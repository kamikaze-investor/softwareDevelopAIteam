import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { getStorage } from '../storage'
import type {
  ApprovalExplanationDiffStatus,
  ApprovalRequest,
  ApprovalQuestionTurn,
  GateOutcome,
  Job,
  RiskLevel,
  RiskReviewResult,
} from '@ai-team/shared'
import {
  runRiskReview,
  decideGateOutcome,
  buildApprovalRequest,
  RISK_RULES,
  APPROVAL_REQUEST_TTL_MINUTES,
  isSafeWorkCommandKind,
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
import {
  evaluateGitCommitEvidence,
  hasReviewVerdictDisagreement,
  type GitCommitEvidenceResult,
  type GitCommitHumanGateReason,
} from '../gitCommitEvidence'
import { getCredentialClass } from '../auth/credentialClass'
import { recordApprovalActor } from '../designReview/resumeActor'
import { designReviewEvidenceRoutes } from './designReviewEvidence'
import { gateEvaluationRoutes } from './gateEvaluations'

/**
 * Gate policyの版。RISK_RULESや判定ロジックを変えたら上げる。
 * evidenceから「どのpolicyで判断したか」を後から一意に特定するために持つ。
 */
// v2（2026-10-02 Decision Authority Principle Stage 1）: git_commit の一律人間承認を、
// Safety Evidence が全て成立する LOW / MEDIUM に限って外した（`gitCommitEvidence.ts`）。
// v3（2026-10-16 監査 RC4/RC6）: 承認を requestedAction 単位に束縛し、SAFE_WORK の HIGH には承認依頼を
// 作らず、RISK_RULES の HIGH 対象（Gate / 承認の実装ファイル・docs/project_memory/rules/）を広げた。
// v2 の evidence を読む側（roadmapAdoption の Candidate commit 証明）は v2 / v3 の両方を受け付ける。
const GATE_POLICY_VERSION = 'gate-policy-v3'

function computeDiffHash(diffText: string): string {
  return createHash('sha256').update(diffText, 'utf-8').digest('hex')
}

const SECRET_SUSPECTED_IN_DIFF_LABEL = 'secret suspected in diff'
const OTHER_RISK_FACTOR_DETECTED_LABEL = 'other risk factor detected'
/** MVP-A: git_commit は実際のriskLevelに関わらず常に承認必須というポリシー起因の理由ラベル */
const GIT_COMMIT_POLICY_LABEL = 'git_commit requires CEO approval (policy)'
/** git_commit の Safety Evidence 判定結果（gate_evaluations / ApprovalRequest の triggeredRules に残す）。 */
const GIT_COMMIT_EVIDENCE_VERIFIED_LABEL = 'git_commit: safety evidence verified'
const GIT_COMMIT_HUMAN_GATE_LABELS: Record<GitCommitHumanGateReason, string> = {
  human_decision_authority: 'git_commit human gate: human_decision_authority',
  insufficient_safety_evidence: 'git_commit human gate: insufficient_safety_evidence',
}
/**
 * spec 22 §14-3 DA trigger (7)（未解決の review 判定不一致）の開示ラベル。
 * 同じ実装に対する review が changes_requested を返した後、resume で再実行した review が approved を返した
 * git_commit に付ける（2026-10-09 b6d4097a: 同一 diff の指摘が再実行で消え、そのまま承認依頼になった）。
 * 判定は既に Safety Evidence 側で fail closed しているので、これは CEO へ「判断が割れている」ことを見せるだけ。
 */
const REVIEW_VERDICT_DISAGREEMENT_LABEL = 'review verdict disagreement'
const SAFE_RISK_RULE_LABELS = new Set([
  ...RISK_RULES.map(rule => rule.label),
  GIT_COMMIT_EVIDENCE_VERIFIED_LABEL,
  ...Object.values(GIT_COMMIT_HUMAN_GATE_LABELS),
  REVIEW_VERDICT_DISAGREEMENT_LABEL,
])
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

/**
 * 同一 commit / diff の却下済み Approval を探す。**必ず `requestedAction` で先に絞る。**
 *
 * Approval は「その action をしてよいか」への判断であり、却下も同じ action にしか効かない。
 * - git_commit で絞らないと、同じ commit/diff に「新しい REJECTED(action=test)」と
 *   「古い REJECTED(action=git_commit)」が並んだとき test 側を拾い、git_commit の却下を
 *   再探索しないまま新しい Approval を作れてしまう
 * - git_commit 以外で絞らないと、ある action の却下が同じ diff の**別 action の Job を全部止める**
 *   （2026-10-16 監査 RC4: review Job の git_status 向けに勝手に作られた行が REJECTED になると、
 *   同じ diff の無関係な Job まで REJECTED 扱いになっていた）
 */
function findRelevantRejectedRequest(
  requests: ApprovalRequest[],
  currentCommit: string,
  currentDiffHash: string,
  requestedAction: string,
): ApprovalRequest | undefined {
  const rejectedRequests = requests.filter(request =>
    request.status === 'REJECTED' && request.requestedAction === requestedAction)
  return rejectedRequests.find(request =>
    request.targetCommit === currentCommit && request.targetDiffHash === currentDiffHash
  ) ?? rejectedRequests[0]
}

/**
 * git_commit 以外の Gate が再利用してよい active（WAITING / APPROVED）な Approval。
 * **同じ `requestedAction` の最新行だけ**を返す。
 *
 * 以前は Task の最新 active 行を action を見ずに使っていたため、ある action 向けの APPROVED が
 * 同じ diff の**別 action** に `call_consume` で使い切られ、別 action の WAITING を自分の承認待ちと
 * 取り違えていた（2026-10-16 監査 RC4。approval-20261016-f73df27a）。
 * git_commit は従来どおり jobs.approval_id で結び付いた行だけを使う（ここは通らない）。
 */
function findActiveRequestForAction(
  requests: ApprovalRequest[],
  requestedAction: string,
): ApprovalRequest | undefined {
  // findByTaskId は created_at の新しい順なので、最初の一致が最新。
  return requests.find(request =>
    (request.status === 'WAITING_FOR_USER' || request.status === 'APPROVED')
    && request.requestedAction === requestedAction)
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
  gitCommitEvidenceVerified = false,
  noRequestReason?: 'safe_work' | 'evaluation_only',
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
        message: gitCommitEvidenceVerified
          ? 'git_commit の Safety Evidence がすべて成立したため、人間承認なしで続行します（承認ではなく Evidence 検証の結果）。'
          : 'リスクレベルが低いため承認不要。処理を続けてください。',
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
      if (noRequestReason === 'safe_work') {
        // requestId は付けない（作っていない）。Worker は requestId 無しの wait_for_approval を受理し、
        // HIGH → continue_safe_work_only で safe work だけを続ける。
        return {
          action: 'wait_for_approval',
          message: 'HIGH リスク変更を含みますが、この操作は safe work のため承認リクエストは作成しません。safe work のみ継続してください。',
        }
      }
      if (noRequestReason === 'evaluation_only') {
        // Job の無い評価は実行の許可にならない。承認依頼も作らず、requestId も付けない。
        return {
          action: 'wait_for_approval',
          message: 'jobId の無い評価のため、承認リクエストは作成しません（実行を許可する応答ではありません）。',
        }
      }
      return {
        action: 'wait_for_approval',
        requestId: newRequestId,
        message: requiresApprovalByPolicy
          ? 'この操作はポリシー上、Safety Evidence が成立しないため人間承認が必要です。承認リクエストを作成しました。'
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

    // git_commit は policy 上の対象 action。人間承認が要るかどうかは、下の Safety Evidence 照合
    // （`gitCommitEvidence.ts`）が成立したかで決まる（2026-10-02 以前は MVP-A により常に人間承認）。
    // riskLevel自体は書き換えない（decideGateOutcome/継続方針/表示文言だけで扱う）。
    const isGitCommitPolicyAction = requestedAction === 'git_commit'

    // Phase A: git_commit Gateだけは実行中Jobを必須にし、任意クライアントが
    // ApprovalとJobの関連を作れないようAPI側で実体と内容を検証する。
    let linkedGitCommitApproval: ApprovalRequest | undefined
    let gitCommitJob: Job | undefined
    if (isGitCommitPolicyAction) {
      if (!jobId) {
        return reply.status(400).send({ error: 'jobId is required for git_commit gate checks' })
      }
      const job = storage.jobs.findById(jobId)
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' })
      }
      gitCommitJob = job
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
    } else if (jobId !== undefined) {
      // 非 git_commit でも、jobId を名乗るなら実在する同じ Task の、同じ kind の Job でなければならない
      // （2026-10-16 Codex review）。名乗った Job と別物の評価を gate_evaluations へ残さず、
      // その応答の call_consume を別 Task / 別 action の Job に使わせない。
      // jobId 無しの呼び出しは下の evaluation-only（評価だけを残し、承認を作らず call_consume も返さない）。
      const job = storage.jobs.findById(jobId)
      if (!job) {
        return reply.status(404).send({ error: 'Job not found' })
      }
      if (job.taskId !== taskId || job.safeCommand.kind !== requestedAction) {
        return reply.status(409).send({
          error: 'Job task or requested action does not match the gate check',
        })
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
    // それ以外の action は、同じ requestedAction の active 行だけを再利用する（承認は自 action にしか効かない）。
    //
    // **jobId の無い非 git_commit の評価は evaluation-only**（2026-10-16 Codex review round 2）。
    // 承認は「それを評価した Job」に結び付かなければならないが、Job の無い評価で承認を作る・再利用する・
    // call_consume を返すと、後から同じ Task・同じ kind の任意の Job がそれを使い切れる。
    // production の呼び出し元は Worker の callGateCheck だけで、常に jobId を送る（GateCheckParams.jobId は必須）。
    // よって Job の無い評価は gate_evaluations だけを残し、active な承認を読まず・作らず・call_consume を出さない。
    // 却下済み（REJECTED）の参照は実行を許可しないので従来どおり行う（fail closed 側の情報）。
    const evaluationOnly = !isGitCommitPolicyAction && jobId === undefined
    let existingReq = isGitCommitPolicyAction
      ? linkedGitCommitApproval
      : evaluationOnly
        ? undefined
        : findActiveRequestForAction(storage.approvalRequests.findByTaskId(taskId), requestedAction)

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

    // HIGH の SAFE_WORK（Worker は承認を待たずに continue_safe_work_only で走る）に残っている
    // **同じ action の** WAITING は、誰も待っていない行である（この修正以前に作られた git_status 等の行。
    // 2026-10-16 b8d0fc5d の approval-20261016-f73df27a）。PENDING_APPROVAL として返し続けると Task が
    // 承認待ちに見え続けるので、SUPERSEDED にして無い前提で判定し直す（下で新しい依頼も作らない）。
    // - 最新 1 行だけでなく、**保存 riskLevel が HIGH の同 action WAITING をすべて** 1 transaction で畳む
    //   （Codex review round 3: 古い legacy 行が残ると resume / Mobile を塞ぎ続ける）
    // - CRITICAL として作られた行は Worker が block_until_approved で待っていた判断なので残す（round 2）。
    //   残っていれば下の再選択でそれを拾い、PENDING_APPROVAL のまま fail closed になる
    // - 別 action の行、Job の無い evaluation-only、今回の評価が CRITICAL の場合は触れない
    if (
      !isGitCommitPolicyAction
      && !evaluationOnly
      && riskReview.riskLevel === 'HIGH'
      && isSafeWorkCommandKind(requestedAction)
    ) {
      const supersededIds = storage.approvalRequests.supersedeUnwaitedSafeWorkRequests(taskId, requestedAction)
      for (const supersededId of supersededIds) {
        sideEffects.push({ type: 'SUPERSEDED_APPROVAL_REQUEST', requestId: supersededId })
      }
      if (existingReq !== undefined && supersededIds.includes(existingReq.id)) {
        existingReq = findActiveRequestForAction(storage.approvalRequests.findByTaskId(taskId), requestedAction)
      }
    }

    // **却下済み判定の探索は git_commit でも行う。**
    //
    // 以前はここが `!requiresApprovalByPolicy` 条件付きで、`requiresApprovalByPolicy` は
    // `requestedAction === 'git_commit'` そのものだった —— つまり
    // **git_commit のときだけこの探索が丸ごと skip され**、linked approval が無ければ
    // Task の過去 REJECTED を見ずに新しい ApprovalRequest を発行できた。
    // 2026-09-23 production: CEO が却下した diff が、3分後に同一
    // `target_commit` / `target_diff_hash` / `changed_files` の新規 WAITING_FOR_USER として
    // 戻ってきた。守るべき不変条件は
    // **「CEO が REJECT したのと同一 diff を、そのまま新しい ApprovalRequest に置き換えない」**。
    //
    // **`jobs.ts` 側へ diff hash 判定を重複実装しない** —— diff identity の正本はこの Gate にある。
    // 却下は action ごと（2026-10-16 監査 RC4。`findRelevantRejectedRequest` 参照）。
    if (!existingReq) {
      existingReq = findRelevantRejectedRequest(
        storage.approvalRequests.findByTaskId(taskId),
        targetCommit,
        targetDiffHash,
        requestedAction,
      )
    }

    // targetCommit / targetDiffHash がどこまで検証済みかを判定する。
    //
    // callerの申告値をそのままtrusted bindingとして保存してはならない。
    // 既存の readExactApprovalDiff は実worktreeのHEADとdiff hashの**両方**へ照合するので、
    // 新しい検証機構を作らずこれを再利用する。照合できない場合は `unverified` として記録し、
    // trustされているかのように見せない。
    //
    // git_commit の Safety Evidence はこの authoritative な読み取り結果を入力にするため、
    // Gate 判定より前に行う（判定結果には依存しない）。
    let bindingVerification: GateEvaluationEvidence['bindingVerification'] =
      diffText !== undefined ? 'diff_text_hash' : 'unverified'
    let authoritativeDiffText: string | undefined
    try {
      const authoritative = readExactApprovalDiff(targetWorkingDir, targetCommit, targetDiffHash)
      if (!authoritative.stale) {
        bindingVerification = 'authoritative'
        authoritativeDiffText = authoritative.diffText
      }
    } catch (error: unknown) {
      app.log.warn(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'gate evidence binding could not be verified against the worktree',
      )
    }

    // canonical manifest（authoritative のときだけ）。approved_content_hash と
    // git_commit の Safety Evidence の両方がこの 1 回の読み取りを使う。
    let authoritativeManifest: ReturnType<typeof buildWorktreeChangeManifest> | undefined
    if (bindingVerification === 'authoritative') {
      try {
        authoritativeManifest = buildWorktreeChangeManifest(targetWorkingDir)
      } catch (error: unknown) {
        app.log.warn(
          { taskId, error: error instanceof Error ? error.message : String(error) },
          'approved content manifest could not be computed',
        )
      }
    }

    // git_commit の Safety Evidence 照合（Decision Authority Principle Stage 1）。
    // 成立したときだけ人間承認を外す。不成立・照合不能は既存の ApprovalRequest へ fail closed。
    let gitCommitEvidence: GitCommitEvidenceResult | undefined
    if (isGitCommitPolicyAction) {
      const task = storage.tasks.findById(taskId)
      if (!gitCommitJob || !task) {
        gitCommitEvidence = {
          passed: false,
          reason: 'insufficient_safety_evidence',
          failures: ['review_lineage_unresolved'],
        }
      } else {
        gitCommitEvidence = evaluateGitCommitEvidence(storage, {
          gitCommitJob,
          task,
          targetCommit,
          targetDiffHash,
          declaredChangedFiles: changedFiles,
          riskReview,
          authoritativeDiffText,
          manifest: authoritativeManifest,
          // secret scan は API 自身が読んだ diff 本文に対して行う（caller の diffText は使わない）
          secretScanHitCount: authoritativeDiffText !== undefined
            ? scanDiffForSecrets(authoritativeDiffText).hits.length
            : undefined,
          workingDir: targetWorkingDir,
          taskApprovalRequests: storage.approvalRequests.findByTaskId(taskId),
        })
      }
    }
    const gitCommitEvidenceVerified = gitCommitEvidence?.passed === true

    // git_commit で Safety Evidence が成立しなかったときだけ、人間承認を必須にする。
    const requiresApprovalByPolicy = isGitCommitPolicyAction && !gitCommitEvidenceVerified

    // commit/diffHashが偶然一致しても、無関係なrequestedAction向けに発行された既存Approval Requestを
    // 再利用しない（例: 'test' への承認が同じcommit/diffHashの'git_commit'や別 action を通過させない）。
    // 上の探索がすでに action で絞っているので、ここは二重の防御（2026-10-16 監査 RC4 で全 action に拡大）。
    const existingReqForOutcome =
      existingReq && existingReq.requestedAction !== requestedAction
        ? undefined
        : existingReq

    // Gate 判定（純粋関数）
    const outcome = decideGateOutcome(riskReview, existingReqForOutcome, targetCommit, targetDiffHash, {
      requiresApprovalByPolicy,
    })
    const continuationPolicy = computeContinuationPolicy(riskReview.riskLevel, outcome.decision, requiresApprovalByPolicy)

    // **誰も待たない承認依頼を作らない。** HIGH の BLOCKED は Worker 側で continue_safe_work_only になり、
    // safe work の kind（git_status / test 等）はそのまま実行される。ここで依頼を作ると、Worker は
    // 承認を待たずに走り終えるのに Task には WAITING が残り、resume / abort を塞ぎ、APPROVED になれば
    // 同じ diff の別 action に使われ、REJECTED になれば別 Job を止めていた
    // （2026-10-16 b8d0fc5d: review Job の git_status が approval-20261016-f73df27a を作った）。
    // Gate 評価（gate_evaluations）は従来どおり残す。CRITICAL は block_until_approved なので対象外。
    const safeWorkWithoutRequest =
      outcome.decision === 'BLOCKED'
      && continuationPolicy === 'continue_safe_work_only'
      && isSafeWorkCommandKind(requestedAction)

    // storage 副作用
    // Evidence が成立した git_commit は ApprovalRequest を一切使わない。探索で拾った
    // 別 diff の REJECTED 等を応答に載せると「ALLOW なのに REJECTED が付く」不整合になるので載せない。
    // 依頼を作らない safe work も同様（期限切れ行などを「今回の依頼」に見せない）。
    // evaluation-only でも REJECTED はそのまま返す（実行を許可しない事実なので隠さない）。
    let approvalRequest: ApprovalRequest | undefined =
      gitCommitEvidenceVerified || safeWorkWithoutRequest || (evaluationOnly && outcome.decision !== 'REJECTED')
        ? undefined
        : existingReq
    let newRequestId: string | undefined

    // ApprovalRequest / gate_evaluations に残す git_commit の判定理由ラベル
    const gitCommitEvidenceLabels: string[] = gitCommitEvidence === undefined
      ? []
      : gitCommitEvidence.passed
        ? [GIT_COMMIT_EVIDENCE_VERIFIED_LABEL]
        : [
            GIT_COMMIT_HUMAN_GATE_LABELS[gitCommitEvidence.reason],
            // DA trigger (7) の開示。Evidence 不成立（review_resumed / review_lineage_unresolved）で
            // 人間承認へ送る git_commit にだけ付ける。保存済み review_results と Job lineage の読み取りのみ。
            ...(gitCommitJob !== undefined && hasReviewVerdictDisagreement(storage, gitCommitJob)
              ? [REVIEW_VERDICT_DISAGREEMENT_LABEL]
              : []),
          ]

    if (outcome.decision === 'STALE') {
      storage.approvalRequests.updateStatus(existingReq!.id, 'STALE', undefined, true)
      sideEffects.push({ type: 'MARKED_STALE', requestId: existingReq!.id })
      approvalRequest = storage.approvalRequests.findById(existingReq!.id)
    } else if (outcome.decision === 'REJECTED') {
      approvalRequest = existingReq
    } else if (outcome.decision === 'BLOCKED' && !safeWorkWithoutRequest && !evaluationOnly) {
      const input: ApprovalGateInput = {
        taskId, requestedAction, targetBranch, targetCommit, targetDiffHash, changedFiles,
      }
      const safeTriggeredRules = sanitizeTriggeredRulesForApprovalRequest(riskReview.triggeredRules)
      // policy起因（git_commit）でBLOCKEDになった場合、実riskLevelは変更せず
      // triggeredRulesへ固定ラベルと人間承認へ送った理由を追加する（重複追加はしない）
      const triggeredRulesWithPolicy = requiresApprovalByPolicy
        ? [...new Set([...safeTriggeredRules, GIT_COMMIT_POLICY_LABEL, ...gitCommitEvidenceLabels])]
        : safeTriggeredRules
      const approvalData = buildApprovalRequest(input, riskReview.riskLevel, triggeredRulesWithPolicy)
      if (isGitCommitPolicyAction) {
        const created = storage.approvalRequests.createForJob(approvalData, jobId!)
        if (!created.ok) {
          return reply.status(created.code === 'JOB_NOT_FOUND' ? 404 : 409).send({
            error: created.reason,
          })
        }
        approvalRequest = created.approvalRequest
      } else {
        // Task の WAITING（action を問わない）と同 action の APPROVED を同じ transaction で畳んでから作る。
        // 別 action の APPROVED は人の判断なので残す（`replaceActiveAndCreate` の invariant）。
        const replaced = storage.approvalRequests.replaceActiveAndCreate(approvalData)
        for (const supersededId of replaced.supersededIds) {
          sideEffects.push({ type: 'SUPERSEDED_APPROVAL_REQUEST', requestId: supersededId })
        }
        approvalRequest = replaced.approvalRequest
      }
      sideEffects.push({ type: 'CREATED_APPROVAL_REQUEST', requestId: approvalRequest.id })
      newRequestId = approvalRequest.id
    }

    // approved_content_hash: ALLOWした変更集合のcanonical manifest hash。
    // commit後に「Bが本当にこの変更集合から作られたか」を独立検証するために使う。
    // binding_verificationがauthoritativeでないevidenceには付けない
    // （申告値ベースのevidenceをcommit後にauthoritativeへ昇格させないため）。
    const approvedContentHash = authoritativeManifest !== undefined
      ? computeChangeManifestHash(authoritativeManifest)
      : undefined

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
      triggeredRules: sanitizeTriggeredRulesForApprovalRequest([
        ...riskReview.triggeredRules,
        ...gitCommitEvidenceLabels,
      ]),
      policyVersion: GATE_POLICY_VERSION,
      bindingVerification,
      approvedContentHash,
    })

    // git_commit の判定根拠を audit に残す（承認ではなく Evidence 検証の記録）。
    // 不成立の内訳は短いコードだけにし、diff 本文・path・秘密情報は含めない。
    if (gitCommitEvidence !== undefined && jobId !== undefined) {
      storage.auditLog.record({
        actor: 'api',
        operation: 'git_commit_safety_evidence',
        entityType: 'job',
        entityId: jobId,
        result: gitCommitEvidence.passed ? 'verified' : gitCommitEvidence.reason,
        detail: [
          `policy=${GATE_POLICY_VERSION}`,
          `decision=${outcome.decision}`,
          `commit=${targetCommit}`,
          `diffHash=${targetDiffHash}`,
          ...(gitCommitEvidence.passed ? [] : [`failed=${gitCommitEvidence.failures.join(',')}`]),
        ].join(' '),
      })
    }

    const nextAction = computeNextAction(
      outcome, riskReview.riskLevel, requiresApprovalByPolicy, newRequestId, gitCommitEvidenceVerified,
      safeWorkWithoutRequest ? 'safe_work' : evaluationOnly && outcome.decision === 'BLOCKED' ? 'evaluation_only' : undefined,
    )

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

    // 同 taskId の WAITING（action を問わない）と同 action の APPROVED を、作成と同じ transaction で
    // SUPERSEDED にする。以前の「最新1件だけ SUPERSEDED → create」は古い WAITING を残し、
    // 別 action の APPROVED（人の判断）を巻き込んで消していた（2026-10-16 監査）。
    const { approvalRequest: req_ } = storage.approvalRequests.replaceActiveAndCreate({
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
  //
  // 決定の直後に「誰が決めたか」（credential 種別だけから導いた human / ai / unknown）を
  // `approval_actor` audit へ残す。APPROVED は legacy 単一 token でも書けるため、行の状態だけでは
  // 人の判断である証明にならない（b8d0fc5d: stored-review recovery の承認が repair budget を作り直す）。
  // 決定と記録は同じ同期区間で連続して書く（間に await が無いので別 request は割り込まない）。
  // 残る窓は 2 つの書き込みの間のプロセス停止だけで、そのとき行は「actor 記録の無い決定」になり、
  // 読み側（`readApprovalActorClass()`）は unknown = 人ではない、と扱う（fail closed。authority は増えない）。
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
      recordApprovalActor(storage, req.params.id, getCredentialClass(req))
      return reply.send(approved.approvalRequest)
    }

    const updated = storage.approvalRequests.recordDecision(
      req.params.id,
      result.data.status as 'APPROVED' | 'REJECTED',
      result.data.reason,
    )
    if (updated) recordApprovalActor(storage, req.params.id, getCredentialClass(req))
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

    // 非 git_commit の consume は、**それを使う実在の Job** に束縛する（2026-10-16 監査・Codex review）。
    // 以前は jobId 省略・存在しない Job・別 Task の Job でも使い切れ、承認が Task にも実行にも
    // 結び付いていなかった。この口を使うのは Worker の call_consume（gate/check の requestedAction =
    // その Job の safeCommand.kind）だけなので、jobId を必須にし、Task 一致・kind 一致・APPROVED・未失効・
    // commit / diff 一致を storage の 1 transaction で確かめてから CONSUMED にする。
    // Task 単位の操作（abort_task・reconcile_external_completion・repair_from_stored_review:* 等）の承認は
    // その名前の command kind を持つ Job が無いので、この口では決して consume できない
    // （それぞれ verifyAndConsumeForTaskAction で消費する。/consume を迂回路にしない）。
    if (!jobId) {
      return reply.status(400).send({ error: 'jobId is required to consume an approval' })
    }
    const consumed = storage.approvalRequests.consumeForCommandJob({
      id: req.params.id,
      jobId,
      currentCommit,
      currentDiffHash,
    })
    if (!consumed.ok) {
      return reply.status(consumed.code === 'NOT_FOUND' || consumed.code === 'JOB_NOT_FOUND' ? 404 : 409).send({
        error: consumed.reason,
      })
    }
    return reply.send(consumed.approvalRequest)
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
