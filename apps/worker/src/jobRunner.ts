/**
 * Job Runner — Job 実行エンジン
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 1Job = 1SafeCommand を安全に実行して結果を返す。
 * aiCliProvider / aiCliPrompt / aiCliMode が揃っている場合は
 * SafeCommand 実行前に AI CLI を先行実行する（task-022）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Job, JobGuardResult, PermissionBlockEvent, RollbackInfo, ApprovalLevelResult } from '@ai-team/shared'
import { runRiskReview } from '@ai-team/shared'
import { createAiCliAdapter } from './aiCli/factory.js'
import { evaluateJobApprovalLevel } from './approvalLevel/jobApprovalLevelIntegration.js'
import { scanTargetProjectRisk, formatRiskScanSummary } from './approvalLevel/targetProjectRiskScan.js'
import type { TargetProjectRiskScanResult } from './approvalLevel/targetProjectRiskScan.js'
import { runStepReview, createNotRunStepReviewResult } from './approvalLevel/stepReview.js'
import type { StepReviewResult } from './approvalLevel/stepReview.js'
import { runPostReview } from './approvalLevel/postReviewer.js'
import type { PostReviewResult } from './approvalLevel/postReviewer.js'
import { runSafetyVerification } from './approvalLevel/safetyVerifier.js'
import type { SafetyVerificationResult } from './approvalLevel/safetyVerifier.js'
import { appendObservationLog } from './approvalLevel/observationLog.js'
import { resolveCommand } from './commandResolver.js'
import { buildTargetCommandEnv } from './utils/safeEnv.js'
import { ALWAYS_FORBIDDEN_PATTERNS, fileChangeGuard } from './guards/fileChangeGuard.js'
import type { RuntimeTaskPolicy } from './guards/fileChangeGuard.js'
import {
  ChangeDetectionError,
  assertNoHistoryRewrite,
  buildCommitRangeManifest,
  buildWorktreeManifest,
  captureReflogBaseline,
  diffSensitiveBaseline,
  getCommitRangeDiffText,
  getWorktreeDiffText,
  manifestFromChanges,
  mergeManifests,
  scanSensitiveFiles,
} from './guards/changeManifest.js'
import type { ChangeManifest, ReflogBaseline, SensitiveBaseline } from './guards/changeManifest.js'
import { saveJobLogs } from './jobLogger.js'
import { permissionGuard, permissionGuardWithGrants } from './guards/permissionGuard.js'
import { callGateCheck, callConsume, GateClientError } from './guards/gateClient.js'
import type { GateCheckResponse } from './guards/gateClient.js'
import { resolvePolicy, SAFE_WORK_ALLOWED_COMMAND_KINDS } from './guards/gatePolicy.js'
import type { EffectivePolicy } from './guards/gatePolicy.js'
import { toGateDecision } from './guards/safetyAuditor.js'
import type { GateResult } from './guards/gateProcessor.js'
import { sendAlert } from './notifier/notifier.js'

const JOB_TIMEOUT_MS = 120_000

/** 重複 CEO 通知防止: 同一 approvalRequestId には一度だけ通知する */
const notifiedApprovalRequests = new Set<string>()
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000'

interface ExecFileFailure {
  status?: number
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export interface JobRunResult {
  status: 'success' | 'failed' | 'blocked'
  exitCode?: number
  stdout?: string
  stderr?: string
  stdoutPath?: string
  stderrPath?: string
  changedFiles?: string[]
  guardResult: JobGuardResult
  startedAt: string
  completedAt: string
  permissionBlockEvent?: PermissionBlockEvent
  rollbackInfo?: RollbackInfo
  gatePolicy?: EffectivePolicy
  gateBlockReason?: string
  /**
   * Approval Level v2 判定結果（Step6-A2）。
   * 既存Approval Gate通過後・AI CLI実行前に計算される。
   * 観察モード: まだこの結果でJobをblockingしない。
   */
  approvalLevelResult?: ApprovalLevelResult
  /**
   * Target Project Risk Scan v1 の結果（観察モード）。
   * AI CLI実行ブロックの終端（成功時）・SafeCommand実行前に計算される。
   * hasRisk:true であっても、Jobをblockingする根拠にはまだ使わない。
   * AI CLI失敗時やそれ以前の早期return（Approval Gate blocked等）では
   * 計算されず、undefinedのまま。
   */
  targetProjectRiskScanResult?: TargetProjectRiskScanResult
  /**
   * Gemini Flash Stepレビュー結果（Step R3・観察モード）。
   * targetProjectRiskScanResult.highestSeverity が medium/high の場合のみ呼び出す
   * （target_project向けReview Level 2以上に相当する既存情報として使える唯一のシグナル。
   * 新しい分類器は作らない）。停止権限を持たず、この結果でJobをblockingしない。
   * Gemini呼び出しに失敗しても（quota枯渇等）status:'failed'として保持し、Jobは止めない。
   */
  stepReviewResult?: StepReviewResult
  /**
   * postReviewer結果（Step R4-A・観察モード）。
   * targetProjectRiskScanResult.highestSeverity が medium/high、かつ job.aiCliProvider が
   * 定まっている場合のみ呼び出す（既存Gemini Step Reviewと同じ呼び出し条件を流用。
   * 新しい分類器は作らない）。停止権限を持たず、この結果でJobをblockingしない。
   * reviewWithSeparation()が例外を投げるケース（実装AIとレビューAIが同一等）を含め、
   * postReview呼び出しに失敗した場合はundefinedのまま（Jobは継続）。
   */
  postReviewResult?: PostReviewResult
  /**
   * safetyVerifier結果（Step R4-B・観察モード）。
   * targetProjectRiskScanResult.highestSeverity が medium/high の場合のみ呼び出す
   * （postReviewer/Gemini Step Reviewと同じ既存シグナルを流用。新しい分類器は作らない）。
   * 12項目中、TYPECHECK/RELATED_TESTS/FULL_TESTSの3項目は実行結果を渡していないため
   * 常にfail-closed（overallPassed:falseの主要因になり得る。危険検出とは限らない）。
   * 呼び出し自体に失敗しても（想定外入力・実装バグ等）Jobは止めず、undefinedのまま。
   */
  safetyVerificationResult?: SafetyVerificationResult
  /**
   * 最終成果として検査した変更 manifest（監査用）。
   * commit が作られた場合は commit tree 由来、作られなかった場合は working tree 由来。
   */
  finalChangeManifest?: ChangeManifest
  /**
   * 変更検出・ポリシー構築などの**技術的失敗**であることを示す。
   *
   * Guard 違反（fileChangeAllowed:false）と区別するために持つ。
   * index.ts の resolveResultStatus() はこのフラグが立っている場合、
   * blocked（＝承認・手動 resume 待ち）へ変換せず failed のまま永続化する。
   */
  detectionFailure?: boolean
  /**
   * Permission API / Gate API の**技術障害**であることを示す
   * （疎通不可・認証失敗・タイムアウト・不正レスポンス）。
   *
   * `detectionFailure`（変更検出の失敗）とは意味が異なるため流用しない。
   * 権限の拒否や承認待ちとも区別する: 技術障害を blocked にすると
   * resumeBlockedTask() の自動再開対象になり、API が壊れたまま再実行され続ける。
   * index.ts の resolveResultStatus() はこのフラグで failed を維持する。
   */
  technicalFailure?: boolean
}

/**
 * Job を実行して結果を返す
 * - Permission Guard (with grants) → Gate Check → [AI CLI] → Stage A 検査
 *   → commandResolver → execFileSync → Stage B / Stage C 最終検査
 * - aiCliProvider / aiCliPrompt / aiCliMode が揃っている場合のみ AI CLI を先行実行（task-022）
 *
 * @param policy 実行時 Task ポリシー（required）。呼び出し元は runJob() を呼ぶ前に
 *   Task を取得し buildRuntimeTaskPolicy() で構築する。取得・構築に失敗した場合は
 *   runJob() を呼ばず Job を failed にすること（AI を実行してはならない）。
 */
export async function runJob(job: Job, policy: RuntimeTaskPolicy): Promise<JobRunResult> {
  const startedAt = new Date().toISOString()

  if (policy.taskId !== job.taskId) {
    return failClosed(
      startedAt,
      `Runtime task policy mismatch: policy.taskId=${policy.taskId} job.taskId=${job.taskId}`,
    )
  }
  if (policy.projectId !== job.projectId) {
    return failClosed(
      startedAt,
      `Task と Job の Project が一致しません: task.projectId=${policy.projectId} job.projectId=${job.projectId}`,
    )
  }

  const guardCheck = await permissionGuardWithGrants(
    job.safeCommand,
    job.agentRole,
    job.taskId,
    job.id,
    API_BASE_URL,
  )
  const guardResult: JobGuardResult = {
    permissionAllowed: guardCheck.allowed,
    permissionReason: guardCheck.reason,
    fileChangeAllowed: true,
    fileViolations: [],
  }

  if (!guardCheck.allowed) {
    // 権限 API の技術障害（疎通不可・認証失敗・タイムアウト・不正レスポンス、
    // および once グラントの使用済み記録失敗）は「権限が拒否された」ではない。
    // blocked に流すと resumeBlockedTask() の自動再開対象になってしまうため failed で止める。
    if (guardCheck.technicalFailure) {
      return failTechnical(
        startedAt,
        `Permission check could not be completed: ${guardCheck.reason ?? 'unknown error'}`,
      )
    }
    return {
      status: 'blocked',
      guardResult,
      startedAt,
      completedAt: new Date().toISOString(),
      permissionBlockEvent: guardCheck.blockEvent,
    }
  }

  // ── Approval Gate check (Step 3A) ──
  const workingDir = job.safeCommand.workingDir

  // Job 開始時の機密ファイルベースライン（.gitignore 対象を含む）。
  // 既存の ignored .env 等は「存在するだけ」では違反にせず、以降の新規作成・
  // 内容変更・symlink 化だけを検出するために使う。
  let sensitiveBaseline: SensitiveBaseline
  let preManifest: ChangeManifest
  let preDiffText: string
  // Job 開始時点の HEAD。AI CLI や非 atomic な SafeCommand（target 側の
  // test/build/lint スクリプト）が自分で commit / checkout して working tree を
  // clean にした場合でも、この HEAD を基準に commit tree を検査するために使う。
  // isAtomic のときだけ取得していると、それらの HEAD 変更を完全に見落とす。
  let startCommitHash: string
  // Job 開始時の HEAD reflog スナップショット。`git reset --hard` 等で一度作った
  // commit を履歴から外し、その後に別内容の commit を作ると、base..after の
  // 祖先関係だけを見る検査ではその commit が完全に見えなくなる
  // （2026-07-31 Codex 最終レビューで発見・実測確認済み）。
  let reflogBaseline: ReflogBaseline
  try {
    sensitiveBaseline = scanSensitiveFiles(workingDir, ALWAYS_FORBIDDEN_PATTERNS)
    preManifest = buildWorktreeManifest(workingDir)
    preDiffText = getWorktreeDiffText(workingDir, preManifest)
    // Gate 用の targetCommit と同じ取得を1回で済ませる（追加の git 呼び出しを増やさない）
    startCommitHash = requireCommitHash(workingDir)
    reflogBaseline = captureReflogBaseline(workingDir)
  } catch (err: unknown) {
    return failClosed(startedAt, formatChangeDetectionError(err))
  }
  const preChangedFiles = preManifest.paths
  const targetDiffHash = createHash('sha256').update(preDiffText, 'utf-8').digest('hex')
  const targetCommit = startCommitHash
  const targetBranch = getTargetBranch(workingDir)
  const localGateResult = buildLocalGateResult(preChangedFiles)

  // Gate API の技術障害（通信・認証・タイムアウト・不正レスポンス）は
  // safe work 継続や「CEO 承認待ち」へ変換しない。承認フローと技術障害を
  // 混同すると、API が壊れている事実が承認待ち通知に隠れてしまうため。
  let checkResponse: GateCheckResponse
  try {
    checkResponse = await callGateCheck({
      taskId: job.taskId,
      requestedAction: job.safeCommand.kind,
      targetBranch,
      targetCommit,
      targetDiffHash,
      changedFiles: preChangedFiles,
    })
  } catch (err) {
    return failTechnical(
      startedAt,
      `Gate check could not be completed: ${formatUnknownError(err)}`,
    )
  }

  const gateResult = resolvePolicy(localGateResult, checkResponse)

  if (gateResult.policy === 'block_until_approved' || gateResult.policy === 're_check') {
    console.warn(`[gate] ${gateResult.policy}: taskId=${job.taskId} reason="${gateResult.reason}"`)

    const approvalRequestId =
      checkResponse?.approvalRequest?.id ??
      checkResponse?.nextAction?.requestId ??
      checkResponse?.nextAction?.consumedRequestId
    const expiresAt = checkResponse?.approvalRequest?.expiresAt

    // dedup: 同一 approvalRequestId への重複通知を抑制
    const dedupKey = approvalRequestId
    if (!dedupKey || !notifiedApprovalRequests.has(dedupKey)) {
      if (dedupKey) notifiedApprovalRequests.add(dedupKey)

      if (gateResult.policy === 'block_until_approved') {
        notifyGateEvent({
          severity: 'critical',
          title: `🚨 承認待ち — ${job.safeCommand.kind} が停止`,
          body: [
            '[ACTION REQUIRED] 人間による承認が必要です。',
            '',
            `コマンド: ${job.safeCommand.kind}`,
            `タスク: ${job.taskId}`,
            `Job: ${job.id}`,
            `理由: ${gateResult.reason}`,
            `承認リクエスト: ${approvalRequestId ?? '不明'}`,
            `承認期限: ${expiresAt ?? '不明'}`,
            `変更ファイル: ${formatChangedFiles(preChangedFiles)}`,
            `コミット: ${targetCommit}`,
            `DiffHash: ${targetDiffHash}`,
            `検出時刻: ${new Date().toISOString()}`,
            '',
            '次のアクション:',
            '承認が必要な場合は approval request を確認してください。',
          ].join('\n'),
          sourceType: 'gate_blocked',
          sourceId: approvalRequestId ?? job.id,
        })
      } else {
        notifyGateEvent({
          severity: 'warning',
          title: `⚠️ 承認無効 — 再確認が必要 (${job.safeCommand.kind})`,
          body: [
            '承認が無効化されたか、再確認が必要です。',
            '',
            `コマンド: ${job.safeCommand.kind}`,
            `タスク: ${job.taskId}`,
            `Job: ${job.id}`,
            `理由: ${gateResult.reason}`,
            `対象リクエスト: ${approvalRequestId ?? '不明'}`,
            `コミット: ${targetCommit}`,
            `DiffHash: ${targetDiffHash}`,
            `検出時刻: ${new Date().toISOString()}`,
            '',
            '次のアクション:',
            'もう一度 Gate check を行い、新しい承認フローを開始してください。',
          ].join('\n'),
          sourceType: 'gate_stale',
          sourceId: approvalRequestId ?? job.id,
        })
      }
    }

    return {
      status: 'blocked',
      guardResult: {
        permissionAllowed: true,
        permissionReason: undefined,
        fileChangeAllowed: true,
        fileViolations: [],
      },
      gatePolicy: gateResult.policy,
      gateBlockReason: gateResult.reason,
      startedAt,
      completedAt: new Date().toISOString(),
    }
  }

  if (gateResult.policy === 'continue_safe_work_only') {
    const kind = job.safeCommand.kind
    if (!(SAFE_WORK_ALLOWED_COMMAND_KINDS as readonly string[]).includes(kind)) {
      console.warn(`[gate] safe_work_only: ${kind} is not permitted. taskId=${job.taskId}`)
      return {
        status: 'blocked',
        guardResult: {
          permissionAllowed: true,
          permissionReason: undefined,
          fileChangeAllowed: true,
          fileViolations: [],
        },
        gatePolicy: gateResult.policy,
        gateBlockReason: `safe_work_only: ${kind} not permitted`,
        startedAt,
        completedAt: new Date().toISOString(),
      }
    }
  }

  // ── consume (Step 3B) ──
  if (checkResponse?.nextAction?.action === 'call_consume') {
    const consumeRequestId = checkResponse.nextAction.consumedRequestId
    if (!consumeRequestId) {
      console.error('[gate] consume requested but consumedRequestId is missing')
      notifyGateEvent({
        severity: 'critical',
        title: `🚨 承認 consume ID 欠落 — ${job.safeCommand.kind}`,
        body: [
          'Gate API が call_consume を要求しましたが、consumedRequestId がありません。',
          '',
          `コマンド: ${job.safeCommand.kind}`,
          `タスク: ${job.taskId}`,
          `Job: ${job.id}`,
          '理由: API response inconsistency',
          `コミット: ${targetCommit}`,
          `DiffHash: ${targetDiffHash}`,
          `検出時刻: ${new Date().toISOString()}`,
        ].join('\n'),
        sourceType: 'gate_consume_missing_id',
        sourceId: job.id,
      })
      return {
        status: 'blocked',
        guardResult: {
          permissionAllowed: true,
          permissionReason: undefined,
          fileChangeAllowed: true,
          fileViolations: [],
        },
        gatePolicy: 'block_until_approved',
        gateBlockReason: 'consume requested but consumedRequestId is missing',
        startedAt,
        completedAt: new Date().toISOString(),
      }
    }

    console.log(`[gate] consuming approval request: requestId=${consumeRequestId}`)
    try {
      const consumeResult = await callConsume(consumeRequestId, {
        currentCommit: targetCommit,
        currentDiffHash: targetDiffHash,
      })
      if (consumeResult.alreadyConsumed) {
        console.warn(`[gate] approval already consumed: requestId=${consumeRequestId}`)
      } else {
        console.log(`[gate] approval consumed: requestId=${consumeRequestId}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // GateClientError 以外の想定外エラーも技術障害として扱う（安全側）。
      // 404（request 不存在）・409（stale / 期限切れ / 非APPROVED）だけが
      // API 契約上意味を持つ業務上の block。
      const isTechnical = !(err instanceof GateClientError) || err.technicalFailure
      console.error(`[gate] consume failed: ${message}`)
      notifyGateEvent({
        severity: 'critical',
        title: `🚨 承認 consume 失敗 — ${job.safeCommand.kind}`,
        body: [
          '承認の使用に失敗しました。システム調査が必要です。',
          '',
          `コマンド: ${job.safeCommand.kind}`,
          `タスク: ${job.taskId}`,
          `Job: ${job.id}`,
          `エラー: ${message}`,
          `リクエストID: ${consumeRequestId ?? '不明'}`,
          `コミット: ${targetCommit}`,
          `DiffHash: ${targetDiffHash}`,
          `検出時刻: ${new Date().toISOString()}`,
        ].join('\n'),
        sourceType: 'gate_consume_failed',
        sourceId: consumeRequestId ?? job.id,
      })

      // 消費できたかどうかを確認できない技術障害では、消費済みとみなして継続しない。
      // かつ承認待ちの blocked にもしない（自動再開の対象にしない）。
      if (isTechnical) {
        return failTechnical(
          startedAt,
          `Approval consume could not be completed: ${message}`,
        )
      }

      return {
        status: 'blocked',
        guardResult: {
          permissionAllowed: true,
          permissionReason: undefined,
          fileChangeAllowed: true,
          fileViolations: [],
        },
        gatePolicy: 'block_until_approved',
        gateBlockReason: `consume failed: ${message}`,
        startedAt,
        completedAt: new Date().toISOString(),
      }
    }
  }
  // ── Gate check end ──

  // ── Approval Level v2 判定（Step6-A2） ──────────────────────────────────────
  // 既存Approval Gate通過後・AI CLI実行前に判定する。
  // preChangedFiles / preDiffText は Approval Gate（Step3A）で取得済みのものをそのまま再利用する。
  // 観察モード: ここではまだ判定結果でJobをblockingしない（ceo_requiredでも停止しない）。
  //
  // ── スコープに関する重要な前提（Step6-B0） ─────────────────────────────
  // この時点の workingDir は、直前の permissionGuardWithGrants() 通過後であり、
  // isInsideTargetRoot() により TARGET_ROOT（'/workspace/target'）配下であることが
  // 既に保証されている。つまり、ここで評価している changedFiles / diffText は
  // 常に target_project（AIチームOSが開発する対象アプリ）側の差分であり、
  // AIチームOS自身（control repo）の差分ではない。
  //
  // 一方、determineApprovalLevel()（packages/shared/src/approvalLevelClassifier.ts）の
  // Mechanical Gate・Level0/1/2分類パターンは、control repo（このリポジトリ自身）の
  // ディレクトリ構造（apps/worker/src/jobRunner.ts・guards/・metaReviewer/等）を
  // 前提に設計されている。target_project側のファイル（例: src/index.ts・app/page.tsx等）は
  // これらのパターンにほぼ一致せず、UNMATCHED_FALLBACKによりLevel3/ceo_requiredに
  // 分類されてしまう可能性がある。
  //
  // そのため、以下の approvalLevelResult は「control repo基準の分類器を
  // target_project向けJobに便宜的に適用した、観察目的の参考ラベル」であり、
  // reviewPolicy / level をそのまま target_project の自動停止根拠として
  // 使ってはならない。Step6-B（自動停止）は、target_project向けの
  // 軽量preflight判定を別途設計するまで延期する。
  const approvalLevelResult = evaluateJobApprovalLevel({
    jobId: job.id,
    taskId: job.taskId,
    changedFiles: preChangedFiles,
    diffText: preDiffText,
  })
  // ── Approval Level v2 判定終端 ───────────────────────────────────────────

  // ── AI CLI 実行ブロック（task-022） ─────────────────────────────────────────
  // aiCliProvider / aiCliPrompt / aiCliMode が3つ揃った場合のみ先行実行する。
  // 成功時は後続の SafeCommand（git_commit 等）を引き続き実行する。
  // 失敗（throw / blocked / exitCode !== 0）時は status: failed で早期リターン。
  if (job.aiCliProvider && job.aiCliPrompt && job.aiCliMode) {
    const adapter = createAiCliAdapter({ provider: job.aiCliProvider })
    let cliResult
    try {
      cliResult = await adapter.run({
        taskId: job.taskId,
        provider: job.aiCliProvider,
        workingDir: job.safeCommand.workingDir,
        prompt: job.aiCliPrompt,
        contextFiles: [],  // task-023 で Context Manager 連携後に拡張
        mode: job.aiCliMode,
        dryRun: job.dryRun,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[jobRunner] AI CLI 実行エラー (${job.aiCliProvider}): ${message}`)
      // AI が失敗しても、失敗するまでに書いた変更は残っている。
      // 検査せずに返すと次 Job がそれを新しいベースラインとして信頼してしまうため、
      // 成功・失敗に関わらず終了後検査を必ず実行する。
      return inspectAfterAiFailure({
        workingDir: job.safeCommand.workingDir,
        startCommitHash,
        reflogBaseline,
        sensitiveBaseline,
        policy,
        guardResult,
        startedAt,
        approvalLevelResult,
        exitCode: 1,
        stdout: '',
        stderr: message,
      })
    }

    const cliFailed = cliResult.blocked === true || (cliResult.exitCode !== 0 && !job.dryRun)
    if (cliFailed) {
      console.error(`[jobRunner] AI CLI 失敗 (${job.aiCliProvider}): exitCode=${cliResult.exitCode} blocked=${cliResult.blocked}`)
      return inspectAfterAiFailure({
        workingDir: job.safeCommand.workingDir,
        startCommitHash,
        reflogBaseline,
        sensitiveBaseline,
        policy,
        guardResult,
        startedAt,
        approvalLevelResult,
        exitCode: cliResult.exitCode,
        stdout: cliResult.stdout,
        stderr: cliResult.stderr,
        stdoutPath: cliResult.stdoutPath,
        stderrPath: cliResult.stderrPath,
      })
    }

    console.log(`[jobRunner] AI CLI 成功 (${job.aiCliProvider}): changedFiles=${cliResult.changedFiles.length}件 → SafeCommand に続行`)
  }
  // ── AI CLI 実行ブロック終端 ───────────────────────────────────────────────

  // ── Target Project Risk Scan（観察モード） ─────────────────────────────────
  // AI CLI実行後（AI CLIを使わないJobの場合はこの時点の作業ツリー状態）を対象に
  // スキャンする。AI CLI実行前は差分が空のことが多く検出に使えないため、
  // ここで再取得した changedFiles / diffText を使う。
  // 観察モード: hasRisk:true でもJobをblockingしない。
  // ── Stage A: AI 作業後の途中検査 ───────────────────────────────────────────
  // AI CLI が作った変更をこの時点で検査する。ここは途中検査であり、
  // 最終判定は SafeCommand 実行後の Stage B / Stage C で行う。
  //
  // working tree だけでなく、Job 開始 HEAD からの commit 差分も検査対象にする。
  // AI CLI（Codex 等）が自分で commit / checkout して working tree を clean にすると、
  // working tree だけを見る検査ではこの時点の変更を素通りしてしまう
  // （2026-07-31 Codex 最終レビューで発見。buildFinalInspection() と同じロジックを使う）。
  let stageAManifest: ChangeManifest
  let postDiffText: string
  try {
    const stageAInspection = buildFinalInspection(
      job.safeCommand.workingDir,
      startCommitHash,
      reflogBaseline,
      sensitiveBaseline,
    )
    stageAManifest = stageAInspection.manifest
    postDiffText = stageAInspection.diffText
  } catch (err: unknown) {
    return failClosed(startedAt, formatChangeDetectionError(err), guardResult)
  }
  const postChangedFiles = stageAManifest.paths

  // Guard 違反で return する場合でも、内容ベースの Risk Scan 結果を
  // 監査対象から欠落させないよう、判定より前に実行しておく
  // （2026-07-31 Codex 最終レビューで発見: Stage A blocked 経路のみ Risk Scan が
  //   スキップされ、AI失敗経路の修正と非対称になっていた）。
  const targetProjectRiskScanResult = scanTargetProjectRisk({
    changedFiles: postChangedFiles,
    diffText: postDiffText,
  })
  // Risk Scan Console Warning（観察モード）: summary がある場合のみログに出す。
  // 停止・通知・API/UI転送は一切行わない。
  const riskScanSummary = formatRiskScanSummary(targetProjectRiskScanResult)
  if (riskScanSummary) {
    console.warn(riskScanSummary)
  }
  // ── Target Project Risk Scan 終端 ───────────────────────────────────────────

  const stageAGuard = fileChangeGuard(stageAManifest, policy, job.safeCommand.workingDir)
  if (!stageAGuard.allowed) {
    guardResult.fileChangeAllowed = false
    guardResult.fileViolations = stageAGuard.violations
    console.error(
      `[jobRunner] Stage A file guard blocked: ${JSON.stringify(stageAGuard.reasons)}`,
    )
    // 既存契約に合わせ status は 'failed' を返す。
    // index.ts の resolveResultStatus() が guardResult.fileChangeAllowed=false を見て
    // 最終的に 'blocked' へ変換する（File Change Guard 由来の停止の既存表現）。
    return {
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: `File Change Guard blocked (stage A): ${stageAGuard.violations.join(', ')}`,
      changedFiles: stageAManifest.paths,
      guardResult,
      startedAt,
      completedAt: new Date().toISOString(),
      targetProjectRiskScanResult,
      finalChangeManifest: stageAManifest,
    }
  }

  // ── Gemini Flash Stepレビュー（Step R3・観察モード・非ブロッキング） ─────────
  // targetProjectRiskScanResult.highestSeverity が medium/high の場合のみ呼ぶ。
  // 11章の対応関係により、これがtarget_project向けReview Level 2以上に相当する
  // 既存情報として使える唯一のシグナルであり、新しい分類器はここで作らない。
  // 停止権限を持たず、この結果でJobをblockingしない。Gemini呼び出しに失敗しても
  // （quota枯渇・ネットワークエラー等）stepReview.ts側でstatus:'failed'として
  // 返るため、ここでは例外を捕捉する必要はない（Jobを止めない）。
  const stepReviewResult =
    targetProjectRiskScanResult.highestSeverity === 'medium' ||
    targetProjectRiskScanResult.highestSeverity === 'high'
      ? await runStepReview({
          jobId: job.id,
          taskId: job.taskId,
          stepSummary: riskScanSummary ?? `Risk Scanでseverity:${targetProjectRiskScanResult.highestSeverity}を検出`,
          purposeSummary: job.aiCliPrompt ?? `Task ${job.taskId}（${job.safeCommand.kind}）`,
          mechanicalSafetyResultSummary: riskScanSummary ?? 'Risk Scan: 重大な指摘なし',
          targetFiles: postChangedFiles,
        })
      : createNotRunStepReviewResult('Risk Scan severityがlow/noneのため未実行（Level 1相当）')
  if (stepReviewResult.status === 'done') {
    console.log(`[jobRunner] Gemini Flash Stepレビュー: importance=${stepReviewResult.importance} routing=${stepReviewResult.routing}`)
  } else if (stepReviewResult.status === 'failed') {
    console.warn(`[jobRunner] Gemini Flash Stepレビュー呼び出し失敗（Jobは継続）: ${stepReviewResult.summary}`)
  }
  // ── Gemini Flash Stepレビュー終端 ───────────────────────────────────────────

  // ── postReviewer接続（Step R4-A・観察モード・非停止） ─────────────────────────
  // 既存Gemini Step Reviewと同じ呼び出し条件（Risk Scan severity: medium/high）に加え、
  // job.aiCliProvider が定まっている場合のみ呼ぶ（implementerProviderが必須のため）。
  // reviewWithSeparation()は「実装AIとレビューAIが同一」の場合にErrorをthrowする
  // 防御コードを持つため、必ずtry/catchで包む。catch時はJobを止めず、
  // diff本文等は出さずエラー種別の要約のみをログに残す。
  const isRiskSeverityMediumOrHigh =
    targetProjectRiskScanResult.highestSeverity === 'medium' ||
    targetProjectRiskScanResult.highestSeverity === 'high'
  let postReviewResult: PostReviewResult | undefined
  if (isRiskSeverityMediumOrHigh && job.aiCliProvider) {
    try {
      postReviewResult = await runPostReview({
        jobId: job.id,
        taskId: job.taskId,
        implementerProvider: job.aiCliProvider,
        approvalLevelResult,
        diffText: postDiffText,
        changedFiles: postChangedFiles,
        purposeSummary: job.aiCliPrompt ?? `Task ${job.taskId}（${job.safeCommand.kind}）`,
      })
      console.log(`[jobRunner] postReviewer: verdict=${postReviewResult.reviewerResult.verdict} alignmentVerdict=${postReviewResult.alignmentVerdict}`)
    } catch (err) {
      const errorKind = err instanceof Error ? err.constructor.name : typeof err
      console.warn(`[jobRunner] postReviewer呼び出し失敗（Jobは継続）: jobId=${job.id} taskId=${job.taskId} errorKind=${errorKind}`)
    }
  }
  // ── postReviewer接続終端 ─────────────────────────────────────────────────

  // ── safetyVerifier接続（Step R4-B・観察モード・非停止） ─────────────────────────
  // 既存Risk Scan/Step Review/postReviewと同じ呼び出し条件（severity: medium/high）を流用。
  // 新しい分類器は作らない。runSafetyVerification()は本来例外を投げない純粋関数だが、
  // 観察モードでの接続であることを明確にするため、想定外入力・実装バグを含めてtry/catchで包む。
  // catch時はJobを止めずconsole.warnのみに留める。
  // 12項目中TYPECHECK/RELATED_TESTS/FULL_TESTSの3項目は実行結果を渡していないためfail-closed。
  // これは危険検出ではなく未接続項目によるものであり、blockingFailuresで区別できるようにする。
  let safetyVerificationResult: SafetyVerificationResult | undefined
  if (isRiskSeverityMediumOrHigh) {
    try {
      safetyVerificationResult = runSafetyVerification({
        jobId: job.id,
        taskId: job.taskId,
        changedFiles: postChangedFiles,
        diffText: postDiffText,
        approvalLevelResult,
        repoRoot: job.safeCommand.workingDir,
        postReviewAlignmentVerdict: postReviewResult?.alignmentVerdict,
      })
      console.log(`[jobRunner] safetyVerifier: overallPassed=${safetyVerificationResult.overallPassed} blockingFailures=${safetyVerificationResult.blockingFailures.join(',')}`)
    } catch (err) {
      const errorKind = err instanceof Error ? err.constructor.name : typeof err
      console.warn(`[jobRunner] safetyVerifier呼び出し失敗（Jobは継続）: jobId=${job.id} taskId=${job.taskId} errorKind=${errorKind}`)
    }
  }
  // ── safetyVerifier接続終端 ───────────────────────────────────────────────

  // Review Observation Log（最小永続化。書き込み失敗はobservationLog.ts内部で吸収されJobを止めない）
  appendObservationLog({
    jobId: job.id,
    taskId: job.taskId,
    provider: job.aiCliProvider,
    changedFilesCount: postChangedFiles.length,
    targetProjectRiskScanResult,
    stepReviewResult,
    postReviewResult,
    safetyVerificationResult,
  })

  const resolved = resolveCommand(job.safeCommand)
  const isAtomic = ['git_commit', 'git_revert'].includes(job.safeCommand.kind)

  let exitCode = 0
  let stdout = ''
  let stderr = ''
  let beforeCommitHash: string | undefined
  let afterCommitHash: string | undefined

  if (!job.dryRun) {
    // アトミックジョブの場合は実行前コミットハッシュを記録
    if (isAtomic) {
      beforeCommitHash = getCommitHash(job.safeCommand.workingDir)
    }

    try {
      stdout = execFileSync(resolved.argv[0], resolved.argv.slice(1), {
        cwd: job.safeCommand.workingDir,
        shell: false,
        timeout: isAtomic ? undefined : JOB_TIMEOUT_MS,
        encoding: 'utf-8',
        env: buildTargetCommandEnv(),
      })
    } catch (err: unknown) {
      const failure = toExecFileFailure(err)
      exitCode = typeof failure.status === 'number' ? failure.status : 1
      stdout = outputToString(failure.stdout)
      stderr = outputToString(failure.stderr) || formatUnknownError(err)
    }

    // アトミックジョブの場合は実行後コミットハッシュを記録
    if (isAtomic) {
      afterCommitHash = getCommitHash(job.safeCommand.workingDir)
    }
  }

  // ── Stage B / Stage C: 最終成果の全面再検査 ────────────────────────────────
  // commit が作られていない場合  : SafeCommand 実行後の working tree manifest が最終成果
  // commit が作られた場合        : base commit → after commit の commit tree manifest が最終成果
  //   （git_commit 実行後は working tree 差分が空になるため、working tree だけを見ると
  //     コミット済みの変更を検出できない）
  // 最終成果は path/kind/mode の照合で済ませず、File Change Guard・
  // ALWAYS_FORBIDDEN_PATTERNS・secret/diff 検査・Risk 検査へ改めて通す。
  let finalManifest: ChangeManifest
  let finalDiffText: string
  try {
    const inspection = buildFinalInspection(
      job.safeCommand.workingDir,
      startCommitHash,
      reflogBaseline,
      sensitiveBaseline,
    )
    finalManifest = inspection.manifest
    finalDiffText = inspection.diffText
  } catch (err: unknown) {
    return failClosed(startedAt, formatChangeDetectionError(err), guardResult)
  }

  const changedFiles = finalManifest.paths
  const fileGuard = fileChangeGuard(finalManifest, policy, job.safeCommand.workingDir)
  guardResult.fileChangeAllowed = fileGuard.allowed
  guardResult.fileViolations = fileGuard.violations
  if (!fileGuard.allowed) {
    console.error(`[jobRunner] Final file guard blocked: ${JSON.stringify(fileGuard.reasons)}`)
  }

  // 最終成果に対する secret / diff 検査と Risk 検査
  const finalRiskScan = scanTargetProjectRisk({
    changedFiles,
    diffText: finalDiffText,
  })
  const finalRiskSummary = formatRiskScanSummary(finalRiskScan)
  if (finalRiskSummary) {
    console.warn(`[final] ${finalRiskSummary}`)
  }
  const finalRiskReview = runRiskReview(changedFiles)
  logFinalRiskReview(finalRiskReview.riskLevel, changedFiles)

  const logPaths = saveJobLogs(job.id, stdout, stderr)

  // アトミックジョブの RollbackInfo を自動生成
  let rollbackInfo: RollbackInfo | undefined
  if (isAtomic && beforeCommitHash && exitCode === 0) {
    rollbackInfo = {
      previousCommitHash: beforeCommitHash,
      changedFiles,
      rollbackArgv: ['git', 'revert', '--no-edit', afterCommitHash ?? 'HEAD'],
    }
  }

  return {
    status: exitCode === 0 && fileGuard.allowed ? 'success' : 'failed',
    exitCode,
    stdout: logPaths.stdoutPreview,
    stderr: logPaths.stderrPreview,
    stdoutPath: logPaths.stdoutPath,
    stderrPath: logPaths.stderrPath,
    changedFiles,
    guardResult,
    startedAt,
    completedAt: new Date().toISOString(),
    rollbackInfo,
    approvalLevelResult,
    targetProjectRiskScanResult: finalRiskScan.hasRisk
      ? finalRiskScan
      : targetProjectRiskScanResult,
    stepReviewResult,
    postReviewResult,
    safetyVerificationResult,
    finalChangeManifest: finalManifest,
  }
}

/** 最終 Risk Review の結果はログのみに使う（観察モードの既存方針を変えない） */
function logFinalRiskReview(level: string, files: string[]): void {
  if (level === 'HIGH' || level === 'CRITICAL') {
    console.warn(`[final] risk review ${level}: ${files.join(', ')}`)
  }
}

/**
 * 検出不能・分類不能をJobの失敗として返す。
 *
 * status は 'blocked' ではなく 'failed' を使う。'blocked' は
 * resumeBlockedTask()（最新Jobがblockedのときに新Jobを作る承認・手動resume経路）の
 * 入口であり、技術障害へ流用すると人手の再開待ちと区別できなくなるため。
 * 'failed' は resumeBlockedTask() の対象外なので自動resumeされず fail-closed になる。
 */
function failClosed(
  startedAt: string,
  message: string,
  guardResult?: JobGuardResult,
): JobRunResult {
  console.error(`[jobRunner] fail-closed: ${message}`)
  return {
    status: 'failed',
    exitCode: 1,
    stdout: '',
    stderr: message,
    changedFiles: [],
    // 技術的失敗では fileChangeAllowed を false にしない。
    // false にすると index.ts の resolveResultStatus() が blocked へ変換し、
    // 承認・手動 resume 待ち（Guard 違反の表現）と区別できなくなるため。
    guardResult: guardResult ?? {
      permissionAllowed: true,
      fileChangeAllowed: true,
      fileViolations: [],
    },
    startedAt,
    completedAt: new Date().toISOString(),
    detectionFailure: true,
  }
}

/**
 * Permission API / Gate API の技術障害で Job を停止する。
 *
 * failClosed() と同じく status='failed'（resumeBlockedTask() の対象外）だが、
 * 意味が異なるため `detectionFailure` は流用せず `technicalFailure` を立てる。
 *
 * guardResult は permissionAllowed/fileChangeAllowed とも true のままにする。
 * false にすると index.ts の resolveResultStatus() が blocked へ変換し、
 * 「権限が拒否された」「承認待ち」と区別できなくなるため
 * （ここで起きたのは判定の失敗であって、拒否ではない）。
 */
function failTechnical(startedAt: string, message: string): JobRunResult {
  console.error(`[jobRunner] technical-failure: ${message}`)
  return {
    status: 'failed',
    exitCode: 1,
    stdout: '',
    stderr: message,
    changedFiles: [],
    guardResult: {
      permissionAllowed: true,
      fileChangeAllowed: true,
      fileViolations: [],
    },
    startedAt,
    completedAt: new Date().toISOString(),
    technicalFailure: true,
  }
}

function formatChangeDetectionError(err: unknown): string {
  if (err instanceof ChangeDetectionError) {
    return `変更ファイル検出に失敗したため fail-closed で停止します: ${err.message}`
  }
  return `変更ファイル検出で予期しないエラーが発生しました: ${
    err instanceof Error ? err.message : String(err)
  }`
}

/**
 * git が報告しない `.gitignore` 対象の機密ファイル変化を manifest へ合流させる。
 * Job 開始時ベースラインと比較し、新規作成・内容変更・symlink 化・削除を検出する。
 */
function withSensitiveChanges(
  manifest: ChangeManifest,
  baseline: SensitiveBaseline,
  workingDir: string,
): ChangeManifest {
  const current = scanSensitiveFiles(workingDir, ALWAYS_FORBIDDEN_PATTERNS)
  const sensitiveChanges = diffSensitiveBaseline(baseline, current)
  if (sensitiveChanges.length === 0) return manifest
  return mergeManifests(manifest, manifestFromChanges(sensitiveChanges))
}

interface AiFailureInspectionInput {
  workingDir: string
  startCommitHash: string
  reflogBaseline: ReflogBaseline
  sensitiveBaseline: SensitiveBaseline
  policy: RuntimeTaskPolicy
  guardResult: JobGuardResult
  startedAt: string
  approvalLevelResult?: ApprovalLevelResult
  exitCode?: number
  stdout?: string
  stderr?: string
  stdoutPath?: string
  stderrPath?: string
}

/**
 * AI CLI が失敗した場合でも、残っている変更を必ず検査してから結果を返す。
 * Job 自体は failed のままだが、禁止ファイルが残っていれば
 * guardResult.fileChangeAllowed=false として記録する。
 */
function inspectAfterAiFailure(input: AiFailureInspectionInput): JobRunResult {
  let manifest: ChangeManifest | undefined
  let riskScan: ReturnType<typeof scanTargetProjectRisk> | undefined
  try {
    const inspection = buildFinalInspection(
      input.workingDir,
      input.startCommitHash,
      input.reflogBaseline,
      input.sensitiveBaseline,
    )
    manifest = inspection.manifest
    const guard = fileChangeGuard(manifest, input.policy, input.workingDir)
    input.guardResult.fileChangeAllowed = guard.allowed
    input.guardResult.fileViolations = guard.violations
    if (!guard.allowed) {
      console.error(
        `[jobRunner] AI CLI 失敗後にも Guard 違反が残っています: ${JSON.stringify(guard.reasons)}`,
      )
    }
    // 成功経路と同様、失敗経路でも secret/diff の Risk Scan を残す。
    // Guard がパス単位の違反を検出しなくても、内容ベースの検査結果を
    // 監査対象から欠落させない（2026-07-31 Codex 最終レビューで発見）。
    riskScan = scanTargetProjectRisk({ changedFiles: manifest.paths, diffText: inspection.diffText })
    const summary = formatRiskScanSummary(riskScan)
    if (summary) console.warn(`[final][ai-failure] ${summary}`)
  } catch (err: unknown) {
    return failClosed(input.startedAt, formatChangeDetectionError(err), input.guardResult)
  }

  return {
    status: 'failed',
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    stdoutPath: input.stdoutPath,
    stderrPath: input.stderrPath,
    changedFiles: manifest.paths,
    guardResult: input.guardResult,
    startedAt: input.startedAt,
    completedAt: new Date().toISOString(),
    approvalLevelResult: input.approvalLevelResult,
    targetProjectRiskScanResult: riskScan,
    finalChangeManifest: manifest,
  }
}

/**
 * 最終成果（working tree + Job 開始 HEAD からの commit tree + 機密ファイル差分）を組み立てる。
 *
 * base は Job 開始時の HEAD を使う。AI CLI 自身や非 atomic な SafeCommand が
 * commit / checkout して working tree を clean にしても、HEAD が動いていれば
 * その差分を必ず検査対象に含めるため。
 */
function buildFinalInspection(
  workingDir: string,
  startCommitHash: string,
  reflogBaseline: ReflogBaseline,
  baseline: SensitiveBaseline,
): { manifest: ChangeManifest; diffText: string } {
  // currentHead が startCommitHash と一致していても、reset で一度別のcommitへ
  // 移動してから元のhashへ戻された可能性は排除できないため、HEAD一致による
  // 早期returnより前に必ず reflog を検証する（fail-closed）。
  assertNoHistoryRewrite(workingDir, reflogBaseline)

  const worktreeManifest = withSensitiveChanges(
    buildWorktreeManifest(workingDir),
    baseline,
    workingDir,
  )
  const currentHead = requireCommitHash(workingDir)
  const worktreeDiff = getWorktreeDiffText(workingDir, worktreeManifest)

  if (currentHead === startCommitHash) {
    return { manifest: worktreeManifest, diffText: worktreeDiff }
  }

  // tree-to-tree の単純比較ではなく、commit を1つずつ検査する。
  // 途中コミットで追加・削除された変更が最終treeで相殺されて消える経路
  // （2026-07-31 Codex 最終レビューで発見・実測確認済み）を塞ぐため。
  const commitManifest = buildCommitRangeManifest(workingDir, startCommitHash, currentHead)
  return {
    manifest: mergeManifests(commitManifest, worktreeManifest),
    diffText: getCommitRangeDiffText(workingDir, startCommitHash, currentHead) + worktreeDiff,
  }
}

/**
 * 安全判定に使う HEAD 取得。失敗を undefined で握りつぶすと
 * commit tree 検査自体がスキップされてしまうため fail-closed にする。
 */
function requireCommitHash(workingDir: string): string {
  const hash = getCommitHash(workingDir)
  if (hash === undefined || hash === '') {
    throw new ChangeDetectionError(`Failed to resolve HEAD commit in "${workingDir}"`)
  }
  return hash
}

function getCommitHash(workingDir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    }).trim()
  } catch {
    return undefined
  }
}

// getChangedFiles() / getPreGateDiffText() は削除した。
// `git diff --name-only HEAD` は untracked を検出せず、git_commit 実行後は差分が空になり、
// さらに失敗時に [] / '' を返して fail-open になっていたため、
// guards/changeManifest.ts の buildWorktreeManifest() / getWorktreeDiffText() へ置き換えた。

function getTargetBranch(workingDir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workingDir,
      encoding: 'utf-8',
      shell: false,
    }).trim()
  } catch {
    return 'unknown'
  }
}

function buildLocalGateResult(changedFiles: string[]): GateResult {
  const riskReview = runRiskReview(changedFiles)
  return {
    finalRiskLevel: riskReview.riskLevel,
    gateDecision: toGateDecision(riskReview.riskLevel),
    auditRiskLevel: riskReview.riskLevel,
    alignmentRiskLevel: 'LOW',
  }
}

function toExecFileFailure(err: unknown): ExecFileFailure {
  if (typeof err === 'object' && err !== null) {
    return err as ExecFileFailure
  }
  return {}
}

function outputToString(output: string | Buffer | undefined): string {
  if (typeof output === 'string') return output
  if (Buffer.isBuffer(output)) return output.toString('utf-8')
  return ''
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Gate 通知ヘルパー ──

/**
 * sendAlert を void で呼び出す best-effort ラッパー。
 * 同期 throw を握りつぶし、Gate 判定に影響させない。
 * 非同期失敗は sendAlert 側が console.error に記録する。
 */
function notifyGateEvent(payload: Parameters<typeof sendAlert>[0]): void {
  try {
    void sendAlert(payload)
  } catch (err) {
    console.error(`[gate] failed to dispatch notification: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 変更ファイル一覧を最大3件に丸めて文字列化する */
function formatChangedFiles(files: string[]): string {
  if (files.length === 0) return 'なし'
  const head = files.slice(0, 3).join(', ')
  return files.length > 3 ? `${head} …他${files.length - 3}件` : head
}

// 後方互換のため permissionGuard を再エクスポート
export { permissionGuard }
