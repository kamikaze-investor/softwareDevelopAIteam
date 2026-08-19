import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { getStorage } from '../storage'
import type {
  ApprovalExplanationDiffStatus,
  ApprovalRequest,
  ApprovalQuestionTurn,
  GateOutcome,
  RiskLevel,
  RiskReviewResult,
} from '@ai-team/shared'
import {
  runRiskReview,
  decideGateOutcome,
  buildApprovalRequest,
  RISK_RULES,
  APPROVAL_REQUEST_TTL_MINUTES,
  type ApprovalGateInput,
} from '@ai-team/shared'
import {
  answerApprovalQuestion,
  generateApprovalExplanation,
  type ApprovalAiContext,
  type ApprovalAiOptions,
} from '../approvalExplain/approvalAi'
import { readExactApprovalDiff } from '../approvalExplain/diffReader'
import { computeChangeManifestHash } from '../approvalExplain/changeManifestIdentity'
import { buildWorktreeChangeManifest } from '../approvalExplain/changeManifestReader'
import type { GateEvaluationEvidence } from '../storage/interface'
import { TARGET_WORKING_DIR } from '../config/targetWorkingDir'
import { designReviewEvidenceRoutes } from './designReviewEvidence'
import { gateEvaluationRoutes } from './gateEvaluations'

/**
 * Gate policyの版。RISK_RULESや判定ロジックを変えたら上げる。
 * evidenceから「どのpolicyで判断したか」を後から一意に特定するために持つ。
 */
const GATE_POLICY_VERSION = 'gate-policy-v1'

function computeDiffHash(diffText: string): string {
  return createHash('sha256').update(diffText, 'utf-8').digest('hex')
}

const SECRET_SUSPECTED_IN_DIFF_LABEL = 'secret suspected in diff'
const OTHER_RISK_FACTOR_DETECTED_LABEL = 'other risk factor detected'
/** MVP-A: git_commit は実際のriskLevelに関わらず常に承認必須というポリシー起因の理由ラベル */
const GIT_COMMIT_POLICY_LABEL = 'git_commit requires CEO approval (policy)'
const SAFE_RISK_RULE_LABELS = new Set(RISK_RULES.map(rule => rule.label))
const DIFF_SECRET_LABEL_PATTERN = /^diff:secret\([^)]*\)$/

function sanitizeTriggeredRulesForApprovalRequest(triggeredRules: string[]): string[] {
  const safeLabels: string[] = []

  for (const label of triggeredRules) {
    let safeLabel: string
    if (SAFE_RISK_RULE_LABELS.has(label)) {
      safeLabel = label
    } else if (DIFF_SECRET_LABEL_PATTERN.test(label)) {
      safeLabel = SECRET_SUSPECTED_IN_DIFF_LABEL
    } else {
      safeLabel = OTHER_RISK_FACTOR_DETECTED_LABEL
    }

    if (!safeLabels.includes(safeLabel)) {
      safeLabels.push(safeLabel)
    }
  }

  return safeLabels
}

// ────────────────────────────────────────────────────────────
// POST /api/gate/check — ローカル型定義
// ────────────────────────────────────────────────────────────

type SideEffectEvent =
  | { type: 'CREATED_APPROVAL_REQUEST';    requestId: string }
  | { type: 'SUPERSEDED_APPROVAL_REQUEST'; requestId: string }
  | { type: 'MARKED_STALE';               requestId: string }

type ContinuationPolicy =
  | 'continue'
  | 'continue_safe_work_only'
  | 'block_until_approved'

type NextActionKind =
  | 'proceed'
  | 'call_consume'
  | 'wait_for_approval'
  | 're_check'

interface NextAction {
  action: NextActionKind
  consumedRequestId?: string
  requestId?: string
  message: string
}

interface GateCheckResponse {
  outcome:            GateOutcome
  riskReview:         RiskReviewResult
  sideEffects:        SideEffectEvent[]
  continuationPolicy: ContinuationPolicy
  nextAction:         NextAction
  approvalRequest?:   ApprovalRequest
}

function findRelevantRejectedRequest(
  requests: ApprovalRequest[],
  currentCommit: string,
  currentDiffHash: string,
): ApprovalRequest | undefined {
  const rejectedRequests = requests.filter(request => request.status === 'REJECTED')
  return rejectedRequests.find(request =>
    request.targetCommit === currentCommit && request.targetDiffHash === currentDiffHash
  ) ?? rejectedRequests[0]
}

// Zod スキーマ
const GateCheckBody = z.object({
  jobId:           z.string().min(1).optional(),
  taskId:          z.string().min(1),
  requestedAction: z.string().min(1),
  targetBranch:    z.string().min(1),
  targetCommit:    z.string().min(1),
  targetDiffHash:  z.string().min(1),
  changedFiles:    z.array(z.string()),
  diffText:        z.string().optional(),
  // TODO: 外部公開APIとして使う場合は diffText を必須化し、
  //       サーバー側でハッシュ照合すること（現在は trusted internal caller 専用）
  // Step D 実装済み: diffText 内容スキャン（シークレット検出）→ routes/approvalGate.ts の scanDiffForSecrets()
})

// ────────────────────────────────────────────────────────────
// ヘルパー関数
// ────────────────────────────────────────────────────────────

function computeContinuationPolicy(
  riskLevel: RiskLevel,
  decision: GateOutcome['decision'],
  requiresApprovalByPolicy: boolean,
): ContinuationPolicy {
  if (decision === 'ALLOW') return 'continue'

  // policy起因（git_commit等）で承認必須化された場合は、実際のriskLevelに関わらず
  // 完全停止で承認待ちにする（continue_safe_work_onlyのような「実リスクの緩和ラベル」を
  // policy起因の停止へ流用しない）。
  if (requiresApprovalByPolicy) return 'block_until_approved'

  switch (riskLevel) {
    case 'CRITICAL':
      return 'block_until_approved'
    case 'HIGH':
      return 'continue_safe_work_only'
    case 'LOW':
    case 'MEDIUM':
      // LOW/MEDIUM で ALLOW 以外は内部不整合（decideGateOutcome の設計上、
      // requiresApprovalByPolicy=false の場合は発生しえない）
      console.warn(
        `[gate/check] Unexpected: riskLevel=${riskLevel} with decision=${decision}. ` +
        `decideGateOutcome should always return ALLOW for LOW/MEDIUM. Defaulting to continue.`
      )
      return 'continue'
  }
}

function computeNextAction(
  outcome: GateOutcome,
  riskLevel: RiskLevel,
  requiresApprovalByPolicy: boolean,
  newRequestId?: string,
): NextAction {
  switch (outcome.decision) {
    case 'ALLOW':
      if (outcome.consumedRequestId) {
        return {
          action: 'call_consume',
          consumedRequestId: outcome.consumedRequestId,
          message: `承認済みです。POST /api/approval-requests/${outcome.consumedRequestId}/consume を呼び出して承認を使い切ってください。`,
        }
      }
      return {
        action: 'proceed',
        message: 'リスクレベルが低いため承認不要。処理を続けてください。',
      }

    case 'PENDING_APPROVAL':
      return {
        action: 'wait_for_approval',
        requestId: outcome.requestId,
        message: requiresApprovalByPolicy
          ? 'この操作はポリシー上CEO承認が必要です。承認後に反映してください。'
          : riskLevel === 'CRITICAL'
            ? '【CRITICAL】危険な変更を含むため、承認まですべての作業を停止してください。承認者に通知してください。'
            : '承認待ち中です。安全な作業は継続可能ですが、この変更の適用は承認後に行ってください。',
      }

    case 'REJECTED':
      return {
        action: 'wait_for_approval',
        requestId: outcome.requestId,
        message: 'この危険操作は却下済みです。同一内容では再承認依頼を作成しません。作業を続けるにはCEOの追加指示が必要です。',
      }

    case 'BLOCKED':
      return {
        action: 'wait_for_approval',
        requestId: newRequestId,
        message: requiresApprovalByPolicy
          ? 'この操作はポリシー上CEO承認が必要です。承認リクエストを作成しました。'
          : riskLevel === 'CRITICAL'
            ? '【CRITICAL】承認リクエストを作成しました。危険な変更を含むため、承認まですべての作業を停止してください。'
            : '承認リクエストを作成しました。HIGH リスク変更のため人間承認が必要です。安全な作業は継続可能です。',
      }

    case 'STALE':
      return {
        action: 're_check',
        message: '承認が無効化されました（commit/diff が変化）。再度 /api/gate/check を呼び出して新しい承認フローを開始してください。',
      }
  }
}

// ────────────────────────────────────────────────────────────
// Step D: diff内容スキャン（シークレット検出）
// ────────────────────────────────────────────────────────────

interface DiffScanHit {
  /** 検出されたシークレットの種類（値そのものは含まない） */
  label: string
  /** マスクされた行（値部分は *** に置換） */
  maskedLine: string
}

interface DiffScanResult {
  hits: DiffScanHit[]
}

/** 追加行（+始まり）のみを対象とする検出ルール */
const DIFF_SECRET_RULES: Array<{
  label: string
  /** 行全体にマッチ。キャプチャグループ1が値部分（マスク対象） */
  pattern: RegExp
}> = [
  { label: 'API_KEY',        pattern: /\bAPI_KEY\s*[:=]\s*(\S+)/i },
  { label: 'SECRET_KEY',     pattern: /\bSECRET(?:_KEY)?\s*[:=]\s*(\S+)/i },
  { label: 'PASSWORD',       pattern: /\bPASSWORD\s*[:=]\s*(\S+)/i },
  { label: 'ACCESS_TOKEN',   pattern: /\bACCESS_TOKEN\s*[:=]\s*(\S+)/i },
  { label: 'AUTH_TOKEN',     pattern: /\bAUTH_TOKEN\s*[:=]\s*(\S+)/i },
  { label: 'PRIVATE_KEY',    pattern: /\bPRIVATE_KEY\s*[:=]\s*(\S+)/i },
  { label: 'ACCESS_KEY_ID',  pattern: /\bACCESS_KEY(?:_ID)?\s*[:=]\s*(\S+)/i },
  { label: 'WEBHOOK_URL',    pattern: /\bWEBHOOK_URL\s*[:=]\s*(\S+)/i },
  { label: 'DATABASE_URL',   pattern: /\bDATABASE_URL\s*[:=]\s*(\S+)/i },
  { label: 'PEM private key', pattern: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/ },
  // .env 追加行に値付きの代入がある場合（KEY=VALUE 形式、値が16文字以上のランダム文字列）
  { label: 'env assignment (long value)', pattern: /^[A-Z][A-Z0-9_]{3,}=([A-Za-z0-9+/=_\-]{16,})$/ },
]

/**
 * diffText の追加行（+で始まる行）をスキャンしてシークレット疑いを検出する。
 * 値そのものはレスポンスに含めず、マスク済み行のみ返す。
 */
function scanDiffForSecrets(diffText: string): DiffScanResult {
  const hits: DiffScanHit[] = []
  const addedLines = diffText
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1)) // '+' を除いた実際の内容

  for (const line of addedLines) {
    for (const rule of DIFF_SECRET_RULES) {
      const m = rule.pattern.exec(line)
      if (!m) continue
      // キャプチャグループ1があれば値部分をマスク、なければ行全体をマスク
      const maskedLine = m[1]
        ? line.replace(m[1], '***')
        : line.replace(m[0], m[0].replace(/=.*/, '=***'))
      hits.push({ label: rule.label, maskedLine })
      break // 同一行で複数ルールがヒットしても1件にする
    }
  }

  return { hits }
}

const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])

// Codex P2: expiresAt はサーバー側で計算する（呼び出し元に任せない）。
// TTL値は packages/shared/src/approvalGateLogic.ts の APPROVAL_REQUEST_TTL_MINUTES を正本とする。
function computeExpiresAt(): string {
  return new Date(Date.now() + APPROVAL_REQUEST_TTL_MINUTES * 60 * 1000).toISOString()
}

const CreateApprovalRequestBody = z.object({
  taskId: z.string(),
  targetBranch: z.string(),
  targetCommit: z.string(),
  targetDiffHash: z.string(),
  riskLevel: RiskLevelSchema,
  requestedAction: z.string(),
  // expiresAt は受け付けない（サーバーが計算する）
  invalidIf: z.array(z.string()).default([]),
  reason: z.string().optional(),
})

const UpdateStatusBody = z.object({
  // EXPIRED / CONSUMED / SUPERSEDED / STALE: 内部遷移専用。PATCH /status では設定不可
  // - EXPIRED: /consume が expiresAt 超過時に自動設定
  // - CONSUMED: /consume エンドポイント経由のみ
  // - SUPERSEDED: /gate/check または POST /approval-requests が自動設定
  // - STALE: /gate/check または /consume が自動設定（commit/diff 不一致時）
  status: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().optional(),
})

const ConsumeApprovalRequestBody = z.object({
  jobId: z.string().min(1).optional(),
  currentCommit: z.string(),
  currentDiffHash: z.string(),
})

const ApprovalQuestionBody = z.object({
  question: z.string().trim().min(1).max(2_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4_000),
  })).max(20).default([]),
})

export interface ApprovalGateRouteOptions {
  targetWorkingDir?: string
  explanationAiOptions?: ApprovalAiOptions
  questionAiOptions?: ApprovalAiOptions
}

interface ResolvedApprovalAiContext {
  context: ApprovalAiContext
  diffStatus: ApprovalExplanationDiffStatus
  exactDiff?: string
}

export async function approvalGateRoutes(
  app: FastifyInstance,
  options: ApprovalGateRouteOptions = {},
): Promise<void> {
  const storage = getStorage()
  const targetWorkingDir = options.targetWorkingDir ?? TARGET_WORKING_DIR
  app.register(designReviewEvidenceRoutes)
  // AV-001保護のindex.tsを触らずに済むよう、既存の同prefix(/api)配下へ相乗りする。
  app.register(gateEvaluationRoutes)

  function resolveApprovalAiContext(request: ApprovalRequest): ResolvedApprovalAiContext | null {
    const task = storage.tasks.findById(request.taskId)
    if (!task) return null

    let diffStatus: ApprovalExplanationDiffStatus = 'unavailable'
    let exactDiff: string | undefined
    try {
      const diffResult = readExactApprovalDiff(
        targetWorkingDir,
        request.targetCommit,
        request.targetDiffHash,
      )
      if (diffResult.stale) {
        diffStatus = 'stale'
      } else {
        diffStatus = 'exact'
        exactDiff = diffResult.diffText
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      app.log.warn({ approvalRequestId: request.id, error: message }, 'Approval diff could not be read')
    }

    return {
      context: {
        task,
        approvalRequest: request,
        reviewResults: storage.reviewResults.findByTaskId(request.taskId),
        qaResults: storage.qaResults.findByTaskId(request.taskId),
        ...(exactDiff !== undefined ? { exactDiff } : {}),
      },
      diffStatus,
      ...(exactDiff !== undefined ? { exactDiff } : {}),
    }
  }

  // POST /api/gate/check
  // ⚠️ trusted internal caller 専用。
  //    diffText 省略時は changedFiles / targetDiffHash / targetCommit / targetBranch を申告値として信頼する。
  app.post('/gate/check', async (req, reply) => {
    const parsed = GateCheckBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Validation failed', details: parsed.error.format() })
    }

    const {
      jobId, taskId, requestedAction, targetBranch, targetCommit,
      targetDiffHash, changedFiles, diffText,
    } = parsed.data

    // diffText が提供された場合のみハッシュ照合
    if (diffText !== undefined) {
      const computed = computeDiffHash(diffText)
      if (computed !== targetDiffHash) {
        return reply.status(400).send({
          error: 'targetDiffHash does not match computed hash of diffText',
        })
      }
    }

    const sideEffects: SideEffectEvent[] = []

    // MVP-A: git_commit は実際のriskLevelに関わらず常にCEO承認を必須にする。
    // riskLevel自体は書き換えない（decideGateOutcome/継続方針/表示文言だけで扱う）。
    const requiresApprovalByPolicy = requestedAction === 'git_commit'

    // Phase A: git_commit Gateだけは実行中Jobを必須にし、任意クライアントが
    // ApprovalとJobの関連を作れないようAPI側で実体と内容を検証する。
    let linkedGitCommitApproval: ApprovalRequest | undefined
    if (requiresApprovalByPolicy) {
      if (!jobId) {
        return reply.status(400).send({ error: 'jobId is required for git_commit gate checks' })
      }
      const job = storage.jobs.findById(jobId)
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' })
      }
      if (
        job.taskId !== taskId ||
        job.safeCommand.kind !== 'git_commit' ||
        requestedAction !== job.safeCommand.kind
      ) {
        return reply.status(409).send({
          error: 'Job task or requested action does not match the gate check',
        })
      }
      if (job.approvalId) {
        const linkedApproval = storage.approvalRequests.findById(job.approvalId)
        if (
          !linkedApproval ||
          linkedApproval.taskId !== taskId ||
          linkedApproval.requestedAction !== requestedAction
        ) {
          return reply.status(409).send({
            error: 'Job has an invalid approval association',
          })
        }
        linkedGitCommitApproval = linkedApproval
      }
    }

    // Risk Review（changedFiles ベース）
    let riskReview = runRiskReview(changedFiles)

    // Step D: diffText 内容スキャン（シークレット検出）
    // diffText が提供された場合のみ実行。ハッシュ照合は上記で完了済み。
    if (diffText !== undefined) {
      const scanResult = scanDiffForSecrets(diffText)
      if (scanResult.hits.length > 0) {
        const LEVEL_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
        const labels = scanResult.hits.map(h => `diff:secret(${h.label})`)
        riskReview = {
          ...riskReview,
          riskLevel: LEVEL_ORDER[riskReview.riskLevel] >= LEVEL_ORDER['CRITICAL']
            ? riskReview.riskLevel
            : 'CRITICAL',
          triggeredRules: [...riskReview.triggeredRules, ...labels],
          requiresIndependentReview: true,
        }
        console.warn(
          `[gate/check][Step D] シークレット疑いを検出: taskId=${taskId}, hits=[${labels.join(', ')}]`
        )
      }
    }

    // アクティブな承認リクエストを取得
    // 同一Taskには複数の正当なJobが存在し得る。git_commitはTask単位の最新Approvalではなく、
    // jobs.approval_idでこのJobに結び付いたApprovalだけを再利用する。
    let existingReq = requiresApprovalByPolicy
      ? linkedGitCommitApproval
      : storage.approvalRequests.findActiveByTaskId(taskId)

    // P2-followup: expired APPROVED cleanup
    // findActiveByTaskId は expiresAt を見ないため期限切れ APPROVED が返ることがある。
    // DB を EXPIRED に更新して次回以降も正しく扱えるようにする。
    if (existingReq?.status === 'APPROVED' && new Date(existingReq.expiresAt) < new Date()) {
      console.warn(`[gate/check] expired APPROVED detected: id=${existingReq.id}. Updating to EXPIRED.`)
      storage.approvalRequests.updateStatus(existingReq.id, 'EXPIRED', undefined, true)
      existingReq = undefined
    }

    // WAITING_FOR_USER + ref 変化 → SUPERSEDE（decideGateOutcome に渡す前に処理）
    if (existingReq?.status === 'WAITING_FOR_USER') {
      if (existingReq.targetCommit !== targetCommit || existingReq.targetDiffHash !== targetDiffHash) {
        storage.approvalRequests.updateStatus(existingReq.id, 'SUPERSEDED')
        sideEffects.push({ type: 'SUPERSEDED_APPROVAL_REQUEST', requestId: existingReq.id })
        existingReq = undefined
      }
    }

    if (!existingReq && !requiresApprovalByPolicy) {
      existingReq = findRelevantRejectedRequest(
        storage.approvalRequests.findByTaskId(taskId),
        targetCommit,
        targetDiffHash,
      )
    }

    // policy起因（git_commit）で承認必須にした場合、commit/diffHashが偶然一致しても
    // 無関係なrequestedAction向けに発行された既存Approval Requestを再利用しない
    // （例: 'test' への承認が偶然同じcommit/diffHashの'git_commit'を通過させない）。
    // 既存のHIGH/CRITICALパス（requiresApprovalByPolicy=false）はrequestedActionを
    // 見ない従来どおりの挙動を維持する（対象外）。
    const existingReqForOutcome =
      requiresApprovalByPolicy && existingReq && existingReq.requestedAction !== requestedAction
        ? undefined
        : existingReq

    // Gate 判定（純粋関数）
    const outcome = decideGateOutcome(riskReview, existingReqForOutcome, targetCommit, targetDiffHash, {
      requiresApprovalByPolicy,
    })

    // storage 副作用
    let approvalRequest: ApprovalRequest | undefined = existingReq
    let newRequestId: string | undefined

    if (outcome.decision === 'STALE') {
      storage.approvalRequests.updateStatus(existingReq!.id, 'STALE', undefined, true)
      sideEffects.push({ type: 'MARKED_STALE', requestId: existingReq!.id })
      approvalRequest = storage.approvalRequests.findById(existingReq!.id)
    } else if (outcome.decision === 'REJECTED') {
      approvalRequest = existingReq
    } else if (outcome.decision === 'BLOCKED') {
      const input: ApprovalGateInput = {
        taskId, requestedAction, targetBranch, targetCommit, targetDiffHash, changedFiles,
      }
      const safeTriggeredRules = sanitizeTriggeredRulesForApprovalRequest(riskReview.triggeredRules)
      // policy起因（git_commit）でBLOCKEDになった場合、実riskLevelは変更せず
      // triggeredRulesへ固定ラベルを追加して理由を残す（重複追加はしない）
      const triggeredRulesWithPolicy = requiresApprovalByPolicy && !safeTriggeredRules.includes(GIT_COMMIT_POLICY_LABEL)
        ? [...safeTriggeredRules, GIT_COMMIT_POLICY_LABEL]
        : safeTriggeredRules
      const approvalData = buildApprovalRequest(input, riskReview.riskLevel, triggeredRulesWithPolicy)
      if (requiresApprovalByPolicy) {
        const created = storage.approvalRequests.createForJob(approvalData, jobId!)
        if (!created.ok) {
          return reply.status(created.code === 'JOB_NOT_FOUND' ? 404 : 409).send({
            error: created.reason,
          })
        }
        approvalRequest = created.approvalRequest
      } else {
        approvalRequest = storage.approvalRequests.create(approvalData)
      }
      sideEffects.push({ type: 'CREATED_APPROVAL_REQUEST', requestId: approvalRequest.id })
      newRequestId = approvalRequest.id
    }

    // targetCommit / targetDiffHash がどこまで検証済みかを判定する。
    //
    // callerの申告値をそのままtrusted bindingとして保存してはならない。
    // 既存の readExactApprovalDiff は実worktreeのHEADとdiff hashの**両方**へ照合するので、
    // 新しい検証機構を作らずこれを再利用する。照合できない場合は `unverified` として記録し、
    // trustされているかのように見せない。
    let bindingVerification: GateEvaluationEvidence['bindingVerification'] =
      diffText !== undefined ? 'diff_text_hash' : 'unverified'
    try {
      const authoritative = readExactApprovalDiff(TARGET_WORKING_DIR, targetCommit, targetDiffHash)
      if (!authoritative.stale) {
        bindingVerification = 'authoritative'
      }
    } catch (error: unknown) {
      app.log.warn(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'gate evidence binding could not be verified against the worktree',
      )
    }

    // approved_content_hash: ALLOWした変更集合のcanonical manifest hash。
    // commit後に「Bが本当にこの変更集合から作られたか」を独立検証するために使う。
    // binding_verificationがauthoritativeでないevidenceには付けない
    // （申告値ベースのevidenceをcommit後にauthoritativeへ昇格させないため）。
    let approvedContentHash: string | undefined
    if (bindingVerification === 'authoritative') {
      try {
        approvedContentHash = computeChangeManifestHash(buildWorktreeChangeManifest(TARGET_WORKING_DIR))
      } catch (error: unknown) {
        app.log.warn(
          { taskId, error: error instanceof Error ? error.message : String(error) },
          'approved content manifest could not be computed',
        )
      }
    }

    // Gate評価のdurable evidenceを残す。
    //
    // 目的は「このcommit/diffに対してGate評価が実行され、結果がこうだった」ことを
    // API/DB側で独立に証明できるようにすることだけで、Gateの権限は増やさない。
    // 特にLOW/MEDIUMの自動ALLOWはこれまで一切永続化されておらず、
    // Workerの自己申告（Job.guardResult）しか残らなかった。自己申告はevidenceにしない。
    //
    // ここで記録するのはAPI側が今まさに実行した評価の結果だけである。
    storage.gateEvaluations.create({
      taskId,
      jobId,
      targetBranch,
      targetCommit,
      targetDiffHash,
      decision: outcome.decision,
      riskLevel: riskReview.riskLevel,
      triggeredRules: sanitizeTriggeredRulesForApprovalRequest(riskReview.triggeredRules),
      policyVersion: GATE_POLICY_VERSION,
      bindingVerification,
      approvedContentHash,
    })

    const continuationPolicy = computeContinuationPolicy(riskReview.riskLevel, outcome.decision, requiresApprovalByPolicy)
    const nextAction = computeNextAction(outcome, riskReview.riskLevel, requiresApprovalByPolicy, newRequestId)

    const response: GateCheckResponse = {
      outcome,
      riskReview,
      sideEffects,
      continuationPolicy,
      nextAction,
      ...(approvalRequest ? { approvalRequest } : {}),
    }
    return reply.send(response)
  })

  // POST /api/approval-requests — 承認リクエスト作成
  app.post('/approval-requests', async (req, reply) => {
    const result = CreateApprovalRequestBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    if (result.data.requestedAction === 'git_commit') {
      return reply.status(400).send({
        error: 'git_commit approval requests must be created by /api/gate/check',
      })
    }

    // 同 taskId の既存アクティブリクエストを SUPERSEDED にする
    const existing = storage.approvalRequests.findActiveByTaskId(result.data.taskId)
    if (existing) {
      storage.approvalRequests.updateStatus(existing.id, 'SUPERSEDED')
    }

    const req_ = storage.approvalRequests.create({
      ...result.data,
      status: 'WAITING_FOR_USER',
      expiresAt: computeExpiresAt(),  // Codex P2: サーバー計算
    })
    return reply.status(201).send(req_)
  })

  // GET /api/approval-requests?taskId=xxx — タスクの承認リクエスト一覧
  app.get<{ Querystring: { taskId?: string } }>('/approval-requests', async (req, reply) => {
    const { taskId } = req.query
    if (!taskId) {
      return reply.status(400).send({ error: 'taskId query parameter is required' })
    }
    const requests = storage.approvalRequests.findByTaskId(taskId)
    return reply.send(requests)
  })

  // GET /api/approval-requests/waiting
  app.get('/approval-requests/waiting', async (_req, reply) => {
    const requests = storage.approvalRequests.findWaiting()
    return reply.send(requests)
  })

  // GET /api/approval-requests/:id — 単体取得
  app.get<{ Params: { id: string } }>('/approval-requests/:id', async (req, reply) => {
    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }
    return reply.send(request)
  })

  // POST /api/approval-requests/:id/explanation — read-onlyなCEO向け説明生成
  app.post<{ Params: { id: string } }>('/approval-requests/:id/explanation', async (req, reply) => {
    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }

    const resolved = resolveApprovalAiContext(request)
    if (!resolved) {
      return reply.send({
        ok: false,
        error: 'AIによる説明を生成できませんでした',
        diffStatus: 'unavailable' satisfies ApprovalExplanationDiffStatus,
      })
    }

    const generated = await generateApprovalExplanation(
      resolved.context,
      options.explanationAiOptions,
    )
    if (!generated.ok) {
      req.log.warn(
        { approvalRequestId: request.id, error: generated.error },
        'Approval explanation generation failed',
      )
      return reply.send({
        ok: false,
        error: 'AIによる説明を生成できませんでした',
        diffStatus: resolved.diffStatus,
      })
    }

    return reply.send({
      ok: true,
      explanation: generated.explanation,
      diffStatus: resolved.diffStatus,
      ...(resolved.diffStatus === 'exact' ? { exactDiff: resolved.exactDiff } : {}),
    })
  })

  // POST /api/approval-requests/:id/ask — 会話履歴を保存しない単発AI質問
  app.post<{ Params: { id: string } }>('/approval-requests/:id/ask', async (req, reply) => {
    const bodyResult = ApprovalQuestionBody.safeParse(req.body)
    if (!bodyResult.success) {
      return reply.status(400).send({ error: 'Validation failed', details: bodyResult.error.format() })
    }

    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }

    const resolved = resolveApprovalAiContext(request)
    if (!resolved) {
      return reply.send({
        ok: false,
        error: 'AIから回答を取得できませんでした',
        diffStatus: 'unavailable' satisfies ApprovalExplanationDiffStatus,
      })
    }

    const generated = await answerApprovalQuestion(
      resolved.context,
      bodyResult.data.question,
      bodyResult.data.history as ApprovalQuestionTurn[],
      options.questionAiOptions,
    )
    if (!generated.ok) {
      req.log.warn(
        { approvalRequestId: request.id, error: generated.error },
        'Approval question generation failed',
      )
      return reply.send({
        ok: false,
        error: 'AIから回答を取得できませんでした',
        diffStatus: resolved.diffStatus,
      })
    }

    return reply.send({
      ok: true,
      answer: generated.answer,
      diffStatus: resolved.diffStatus,
    })
  })

  // PATCH /api/approval-requests/:id/status — 状態更新（人間が承認/拒否する口）
  app.patch<{ Params: { id: string } }>('/approval-requests/:id/status', async (req, reply) => {
    const result = UpdateStatusBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }
    if (request.status !== 'WAITING_FOR_USER') {
      return reply.status(409).send({
        error: `Cannot update status: current status is '${request.status}'`,
      })
    }

    if (result.data.status === 'APPROVED' && request.requestedAction === 'git_commit') {
      const approved = storage.approvalRequests.approveAndResumeJob(req.params.id, result.data.reason)
      if (!approved.ok) {
        return reply.status(approved.code === 'NOT_FOUND' ? 404 : 409).send({
          error: approved.reason,
          ...(approved.approvalRequest ? { status: approved.approvalRequest.status } : {}),
        })
      }
      return reply.send(approved.approvalRequest)
    }

    const updated = storage.approvalRequests.recordDecision(
      req.params.id,
      result.data.status as 'APPROVED' | 'REJECTED',
      result.data.reason,
    )
    return reply.send(updated)
  })

  // POST /api/approval-requests/:id/consume — APPROVED → CONSUMED に遷移（一回限りの承認を強制）
  // git_commitはJob関連・task/action・commit/diffをtransaction内で検証する。
  app.post<{ Params: { id: string } }>('/approval-requests/:id/consume', async (req, reply) => {
    const request = storage.approvalRequests.findById(req.params.id)
    if (!request) {
      return reply.status(404).send({ error: 'Approval request not found' })
    }

    const bodyResult = ConsumeApprovalRequestBody.safeParse(req.body)
    if (!bodyResult.success) {
      return reply.status(400).send({ error: 'Validation failed', details: bodyResult.error.format() })
    }
    const { jobId, currentCommit, currentDiffHash } = bodyResult.data

    if (request.requestedAction === 'git_commit') {
      if (!jobId) {
        return reply.status(400).send({ error: 'jobId is required to consume a git_commit approval' })
      }

      const consumed = storage.approvalRequests.consumeForJob({
        id: req.params.id,
        jobId,
        currentCommit,
        currentDiffHash,
      })
      if (!consumed.ok) {
        const consumedByDifferentJob =
          consumed.code === 'JOB_MISMATCH' &&
          consumed.approvalRequest?.status === 'CONSUMED' &&
          consumed.linkedJobId !== undefined &&
          consumed.linkedJobId !== jobId
        return reply.status(consumed.code === 'NOT_FOUND' || consumed.code === 'JOB_NOT_FOUND' ? 404 : 409).send({
          error: consumed.reason,
          consumed: consumedByDifferentJob,
          ...(consumed.linkedJobId ? { jobId: consumed.linkedJobId } : {}),
        })
      }

      return reply.send({
        ...consumed.approvalRequest,
        consumed: true,
        jobId: consumed.jobId,
        alreadyConsumed: consumed.alreadyConsumed,
      })
    }

    // 非git_commit経路は既存契約を維持する。
    if (request.status !== 'APPROVED') {
      return reply.status(409).send({
        error: `Cannot consume: current status is '${request.status}' (must be APPROVED)`,
      })
    }

    if (new Date(request.expiresAt) <= new Date()) {
      storage.approvalRequests.updateStatus(req.params.id, 'EXPIRED', undefined, true)
      return reply.status(409).send({ error: 'Approval request has expired' })
    }

    if (request.targetCommit !== currentCommit || request.targetDiffHash !== currentDiffHash) {
      storage.approvalRequests.updateStatus(req.params.id, 'STALE', undefined, true)
      return reply.status(409).send({ error: 'Approval request is stale: commit or diff has changed' })
    }

    const updated = storage.approvalRequests.updateStatus(req.params.id, 'CONSUMED', undefined, true)
    return reply.send(updated)
  })

  // GET /api/approval-requests/:id/active?taskId=xxx — アクティブな承認リクエストを取得
  app.get<{ Querystring: { taskId?: string } }>('/approval-requests/active', async (req, reply) => {
    const { taskId } = req.query
    if (!taskId) {
      return reply.status(400).send({ error: 'taskId query parameter is required' })
    }
    const request = storage.approvalRequests.findActiveByTaskId(taskId)
    return reply.send(request ?? null)
  })
}
