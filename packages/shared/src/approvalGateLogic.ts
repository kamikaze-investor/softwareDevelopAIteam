/**
 * Approval Gate — Pure Logic (shared)
 *
 * apps/worker/src/guards/approvalGate.ts から移植した純粋関数群。
 * API と worker の両方からインポートできるように packages/shared に配置する。
 */

import type {
  ApprovalGateInput,
  ApprovalRequest,
  ApprovalGateStatus,
  GateOutcome,
  RiskReviewResult,
} from './types/approval_gate'
import type { RiskLevel } from './types/safety_guard'
import type { CommandKind } from './types/command'

// ────────────────────────────────────────────────────────────
// Safe work（HIGH の承認待ち中でも Worker が続けてよい操作）
// ────────────────────────────────────────────────────────────

/**
 * Worker の Gate policy（`resolvePolicy()`）が **承認の判断ではなく技術的な不整合**で止めたときの理由コード（D2 2026-10-17）。
 *   - `risk_rule_skew`: Worker のローカル risk が API の評価より高い（Worker / API の rule の版ずれ）
 *   - `approval_contract_violation`: Gate 応答の decision / continuationPolicy / nextAction の組が API の契約に無い
 * どちらも re_check で止まり、Worker は理由を Job の stderr に `<code>: ...` として残す。PL triage はこれを見て
 * 自動 resume しない（原因を直した後に resume すれば新しい承認が求められる）。
 */
export const GATE_TECHNICAL_STOP_CODES = ['risk_rule_skew', 'approval_contract_violation'] as const
export type GateTechnicalStopCode = typeof GATE_TECHNICAL_STOP_CODES[number]

/**
 * 文字列が**先頭（offset 0）から** `<code>: ` で始まるときだけその理由コードを返す（stderr / gate 理由のどちらにも使う）。
 * Worker は技術停止の理由をそのまま stderr 全体として書く。途中の行や前置きのある行は照合しない
 * （コマンド出力などの任意の文字列で技術停止を詐称させないため）。
 */
export function findGateTechnicalStopCode(text: string | undefined): GateTechnicalStopCode | undefined {
  if (!text) return undefined
  return GATE_TECHNICAL_STOP_CODES.find((candidate) => text.startsWith(`${candidate}: `))
}

/**
 * HIGH の承認待ち（`continue_safe_work_only`）の間も実行してよい CommandKind。
 * 読み取り・テスト・品質チェックだけで、コード変更・commit は含めない。
 *
 * API（`/gate/check` が承認依頼を作るかどうか）の正本。Worker の実行可否は
 * `apps/worker/src/guards/gatePolicy.ts` の `SAFE_WORK_ALLOWED_COMMAND_KINDS`（AI 編集禁止の Control
 * ファイルなので、ここを import させられない）が持ち、`apps/worker/src/safeWorkKindsDrift.test.ts` が
 * 同じ集合であることを固定する。食い違うと、API が「誰も待たない承認依頼」を作り、Worker はそれを
 * 無視して続行する食い違いが再発する（2026-10-16 b8d0fc5d: review Job の git_status が HIGH diff で
 * WAITING を作り、resume / abort を塞いだ）。
 */
export const SAFE_WORK_COMMAND_KINDS: readonly CommandKind[] = [
  'git_status',
  'git_diff',
  'git_log',
  'typecheck',
  'test',
  'lint',
] as const

export function isSafeWorkCommandKind(kind: string): boolean {
  return (SAFE_WORK_COMMAND_KINDS as readonly string[]).includes(kind)
}

// ────────────────────────────────────────────────────────────
// Risk Review（ルールベース簡易実装）
// TODO: Phase 2 で Independent AI Review に差し替え可能な接続点
// ────────────────────────────────────────────────────────────

interface RiskRule {
  label: string
  pattern: RegExp
  level: RiskLevel
}

/**
 * 'alignment / gate change' の exact path 対象（拡張子 `.ts` を除いた repository-relative path）。
 * **production の実ファイルだけ**を並べる。隣のテスト（`*.test.ts`）は一致しない。
 * 英数字と `/` だけなので RegExp へそのまま埋め込める（下の検査で固定する）。
 */
export const GATE_CHANGE_EXACT_FILES: readonly string[] = [
  // 2026-10-16 監査（RC4/RC6）: approval の保存・却下伝播・PL abort・停止判定・commit gate
  'apps/api/src/storage/sqlite',
  'apps/api/src/pl/abortTask',
  'apps/api/src/pl/executionLoop',
  'apps/api/src/state/systemState',
  'apps/api/src/gitCommitResumeLineage',
  'apps/api/src/linkedGitCommitRejection',
  'apps/worker/src/approvalLevel/commitGate',
  'packages/shared/src/approvalLiveness',
  // 2026-10-17 監査（RC6 / DA trigger 2）: authority・approval/consume・actor 分類・admission・recovery の定義
  'apps/api/src/designReview/resumeActor',                      // 承認 / resume の actor（人・AI）分類
  'apps/api/src/designReview/repairRecoveryEpoch',              // repair 再発行 budget の epoch
  'apps/api/src/designReview/repairFromStoredReview',           // stored-review recovery の authority
  'apps/api/src/designReview/resumeBlockedTask',                // blocked Task resume の admission
  'apps/api/src/designReview/terminalRepairSuccessorRecovery',  // Review を回さず successor を作る recovery
  'apps/api/src/designReview/terminalRepairEscalationRecovery', // 却下の Human escalation recovery
  'apps/api/src/designReview/designReviewCoordinator',          // recomputeDecision（formal verdict）
  'apps/api/src/designReview/resultingCommitBinding',           // Gate ALLOW と resulting commit の bind
  'apps/api/src/humanRecovery/recoverBlockedTask',              // Human Recovery の authority
  'apps/api/src/humanRecovery/recoveryAudit',                   // Human Recovery 履歴（park / attention の根拠）
  'apps/api/src/storage/interface',                             // approval consume / actor 記録の storage 契約
  'packages/shared/src/resumeAdmission',                        // resume admission
  'packages/shared/src/recoverAdmission',                       // recover admission
  'packages/shared/src/taskOccupancy',                          // Task 占有（並走 admission）
  'packages/shared/src/reviewSeparation',                       // generator / final reviewer の自己承認禁止
  'apps/api/src/approvedRunBlock',                              // 承認済み run の block 判定
  'apps/api/src/state/blockedRowOwnership',                     // blocked 行の所有（誰が解除してよいか）
  'apps/api/src/reconcile/externalCompletion',                  // Candidate 外の完了を done にする authority
  'apps/api/src/pl/technicalResumePolicy',                      // PL Technical Resume の budget / actor token
  'apps/api/src/pl/technicalAbortEvidence',                     // PL technical abort の authority
  'apps/api/src/ctoAi/roadmapAdoption',                         // adoption admission / 受理する policy version
  // 2026-10-17 Codex review（c3-b）: recovery / attempt budget・admission・escalation 選択の定義
  'apps/api/src/pl/adoptionStep',                               // adoption の authorizePlAction seam と試行 budget
  'apps/api/src/ctoAi/initialImplementWorkflow',                // initial implement の U7 recovery admission
  'apps/api/src/ctoAi/projectInitialization',                   // Roadmap CONFLICT recovery の admission と試行 budget
  'apps/api/src/pl/remediationStep',                            // remediation の試行 budget
  'apps/api/src/pl/conflictResolutionStep',                     // critic / recovery round の budget
  'apps/api/src/pl/blockedTriage',                              // 自動 recovery か CEO escalation かの選択
  'apps/api/src/pl/operatorRequestStep',                        // 外部依頼を PL 判断経路へ入れる対象照合（admission）
  'apps/worker/src/jobStateManager',                            // stale Job recovery の admission
  'apps/worker/src/workspaceVerification',                      // crash recovery で workspace 所有権を解放する exact 検証
  'apps/worker/src/index',                                      // abort cleanup 再送 budget（fileChangeGuard 保護とは別に不変条件として）
  // 2026-10-17 Codex review round 2（c3-b）
  'apps/api/src/jobResultApplicationPolicy',                    // Job result の状態遷移 admission（正本）
  'apps/api/src/routes/jobs',                                   // 直接遷移 / claim の拒否と Outbox 受理の境界
  'apps/api/src/routes/tasks',                                  // generic route で無許可の done を止める唯一の場所・lifecycle 所有状態の拒否
  // 2026-10-17 最終監査（lifecycle repair final）
  'apps/api/src/state/strandedTask',                            // lifecycle 所有状態（in_progress / review）から出してよいかの stranded 判定
  'apps/api/src/ctoAi/taskContinuation',                        // Task continuation と CEO escalation の選択
  'apps/api/src/designReview/retryCooldown',                    // 判定の出ない Design Review の再試行 budget の時間配分
]
for (const file of GATE_CHANGE_EXACT_FILES) {
  if (!/^[A-Za-z0-9/]+$/.test(file)) {
    throw new Error(`GATE_CHANGE_EXACT_FILES entry must be a plain path: ${file}`)
  }
}

export const RISK_RULES: RiskRule[] = [
  { label: 'DB migration / schema',      pattern: /migration|schema\.ts/i,                    level: 'HIGH' },
  { label: 'auth / permission guard',    pattern: /auth|permission|guard/i,                   level: 'HIGH' },
  { label: 'payment / billing',          pattern: /payment|billing|stripe/i,                  level: 'CRITICAL' },
  { label: 'secrets / env / token',      pattern: /secret|\.env|token|api.?key/i,             level: 'HIGH' },
  { label: 'destructive operation',      pattern: /delete|drop|truncate|destroy/i,            level: 'HIGH' },
  // Codex P1: docker-compose.yml / sandbox/config.yml も対象に拡張
  { label: 'docker / sandbox config',    pattern: /sandbox\/docker|Dockerfile|docker-compose|sandbox\//i, level: 'HIGH' },
  { label: 'CI/CD workflow change',      pattern: /\.github\//i,                              level: 'HIGH' },
  // 2026-10-02: git_commit の Safety Evidence 判定（Stage 1）と PL の authority 判定の実装も同じ扱い。
  // ここを LOW / MEDIUM に落とすと、Gate 自身を弱める変更を Evidence だけで commit できてしまう。
  // git_commit Evidence が判定に使う lineage / Design Review / Candidate workspace の実装
  // （repairFlow・repairPolicy・designReviewEvidencePolicy・targetWorkingDir）も含める（独立レビュー A-1）。
  //
  // 2026-10-16 監査（RC4/RC6）: approval の保存・却下伝播・PL abort・停止判定・commit gate の実装が
  // 抜けていた。LOW のまま Evidence で commit できると、Gate を弱める変更が人の目を通らない。
  // **production の実ファイルだけ**を exact path で足す（隣のテストまで HIGH にすると、
  // テストを足すだけの変更まで Evidence の対象外になる）。
  //
  // 2026-10-17 監査（RC6 / DA trigger 2）: authority・admission・recovery の**定義そのもの**が LOW のままだった。
  // これらを編集してよい Task が、CEO 依頼なしに Safety Evidence で auto-commit できてしまう。
  // exact path の一覧は `GATE_CHANGE_EXACT_FILES`（理由つき）を正本にする。
  {
    label: 'alignment / gate change',
    pattern: new RegExp(
      String.raw`alignmentCheck|approvalGate|gateProcessor|gitCommitEvidence|actionGate|plActionPolicy|approvalLevelClassifier|approvalExplain\/(diffReader|changeManifest)|designReview\/(repairFlow|repairPolicy)\.ts$|designReviewEvidencePolicy|config\/targetWorkingDir`
        + String.raw`|(^|\/)(` + GATE_CHANGE_EXACT_FILES.join('|') + String.raw`)\.ts$`,
      'i',
    ),
    level: 'HIGH',
  },
  // 2026-10-02: Decision Authority / Safety policy の正本 docs。docs/ 配下は SAFE_ONLY で LOW に
  // 落ちるため、下の SAFE_ONLY 早期リターンより先に評価する（NEVER_SAFE_ONLY_RULES）。
  // 2026-10-16 監査: rules/ は approval_rules.md 以外も運用ルールの正本なので配下すべてを対象にする。
  // 依存定義（package.json / pnpm-lock.yaml）は入れない: 依存の変更は Decision Authority 上の技術判断で、
  // HIGH にすると該当する git_commit がすべて CEO 承認へ回る（PL 判断 2026-10-16）。
  { label: 'decision authority / safety policy doc', pattern: /(^|\/)specs\/(00_constitution|08_permissions|22_safety_approval_design_principle)\.md$|(^|\/)docs\/project_memory\/(goal|design_philosophy)\.md$|(^|\/)docs\/project_memory\/rules\/.+|(^|\/)docs\/multi_ai_step_review_flow\.md$/i, level: 'HIGH' },
  // Codex P1: AI 指示ファイル（AGENTS.md / CLAUDE.md）は CRITICAL
  { label: 'AI instruction file',        pattern: /AGENTS\.md$|CLAUDE\.md$/i,                 level: 'CRITICAL' },
]

// SAFE_ONLY_PATTERNS: 全ファイルが "安全のみ" と判断されたとき LOW に落とすホワイトリスト
// 注意: RISK_RULES より先に評価されるため、ここに入れると RISK_RULES を完全にスキップする
// → .md ファイルは無条件 LOW にせず、RISK_RULES に先に通す
export const SAFE_ONLY_PATTERNS: RegExp[] = [
  /^docs\//,
  /^logs\//,
  /^\.gitignore$/,
]

// CRITICAL ルール（safe-only 早期リターンより先に評価する）
// Codex P1 review: docs/AGENTS.md など safe-only パス配下でも CRITICAL にするために先行チェック
export const ALWAYS_CRITICAL_RULES: RiskRule[] = RISK_RULES.filter(r => r.level === 'CRITICAL')

/** safe-only 早期リターンで素通りさせないルール（CRITICAL と、docs/ 配下にある Safety policy の正本 docs）。 */
const NEVER_SAFE_ONLY_RULES: RiskRule[] = RISK_RULES.filter(r =>
  r.level === 'CRITICAL' || r.label === 'decision authority / safety policy doc')

/**
 * changedFiles からリスクレベルを算出する（純粋関数）
 */
export function runRiskReview(changedFiles: string[]): RiskReviewResult {
  // CRITICAL ルールを先に評価して safe-only 早期リターンを防ぐ（bypass ガード）
  // Codex P3: ここでは早期リターンせず「CRITICAL ファイルが含まれるか」だけ判定する
  const hasNeverSafeOnlyFile = changedFiles.some(f =>
    NEVER_SAFE_ONLY_RULES.some(r => r.pattern.test(f))
  )

  // CRITICAL ファイルがなければ safe-only 早期リターンを許可
  if (!hasNeverSafeOnlyFile) {
    const allSafe = changedFiles.length > 0 &&
      changedFiles.every(f => SAFE_ONLY_PATTERNS.some(p => p.test(f)))
    if (allSafe) {
      return { riskLevel: 'LOW', triggeredRules: [], requiresIndependentReview: false }
    }
  }

  // 全 RISK_RULES をスキャンして maxLevel と triggeredRules を収集
  // Codex P3: 早期リターンをやめることで混在ケースのルール情報が全て揃う
  let maxLevel: RiskLevel = 'LOW'
  const triggered: string[] = []

  const LEVEL_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }

  for (const file of changedFiles) {
    for (const rule of RISK_RULES) {
      if (rule.pattern.test(file)) {
        if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[maxLevel]) {
          maxLevel = rule.level
        }
        if (!triggered.includes(rule.label)) {
          triggered.push(rule.label)
        }
      }
    }
  }

  const requiresIndependentReview = maxLevel === 'HIGH' || maxLevel === 'CRITICAL'
  return { riskLevel: maxLevel, triggeredRules: triggered, requiresIndependentReview }
}

// ────────────────────────────────────────────────────────────
// 承認の有効期限を算出（純粋関数）
// ────────────────────────────────────────────────────────────

/** 全RiskLevel共通のApprovalRequest有効期限（分）。Risk別の分岐は持たない。 */
export const APPROVAL_REQUEST_TTL_MINUTES = 24 * 60

function computeExpiresAt(now: Date): string {
  return new Date(now.getTime() + APPROVAL_REQUEST_TTL_MINUTES * 60 * 1000).toISOString()
}

// ────────────────────────────────────────────────────────────
// 承認リクエストの失効判定（純粋関数）
// ────────────────────────────────────────────────────────────

/**
 * 現在の状態と ApprovalRequest を照合して最終ステータスを返す。
 * - EXPIRED: expires_at を過ぎている
 * - STALE: commit または diff hash が変わっている
 * - それ以外: 現在の status をそのまま返す
 */
export function resolveEffectiveStatus(
  req: ApprovalRequest,
  currentCommit: string,
  currentDiffHash: string,
): ApprovalGateStatus {
  if (req.status === 'REJECTED') {
    if (req.targetCommit !== currentCommit || req.targetDiffHash !== currentDiffHash) {
      return 'SUPERSEDED'
    }
    return 'REJECTED'
  }
  if (new Date(req.expiresAt) < new Date()) {
    return 'EXPIRED'
  }
  if (req.status === 'APPROVED') {
    if (req.targetCommit !== currentCommit || req.targetDiffHash !== currentDiffHash) {
      return 'STALE'
    }
  }
  return req.status
}

// ────────────────────────────────────────────────────────────
// Gate Decision（純粋関数）
// ────────────────────────────────────────────────────────────

export interface GateDecisionOptions {
  /**
   * riskLevel が LOW/MEDIUM でも承認を必須にする（例: git_commit は常に承認必須という
   * MVP-A ポリシー）。riskLevel 自体は書き換えない。既存の呼び出し元（4引数）を
   * 壊さないよう省略可能とし、既定値は false（従来どおり LOW/MEDIUM は自動継続）。
   */
  requiresApprovalByPolicy?: boolean
}

/**
 * Risk Review 結果と既存の ApprovalRequest（あれば）から GateOutcome を決定する。
 *
 * @param riskReview   runRiskReview() の結果
 * @param existingReq  storage から取得したアクティブな ApprovalRequest（なければ undefined）
 * @param currentCommit  現在の git HEAD commit hash
 * @param currentDiffHash  現在の diff hash
 * @param options      省略可能。`requiresApprovalByPolicy` で LOW/MEDIUM の自動 ALLOW を無効化する
 */
export function decideGateOutcome(
  riskReview: RiskReviewResult,
  existingReq: ApprovalRequest | undefined,
  currentCommit: string,
  currentDiffHash: string,
  options: GateDecisionOptions = {},
): GateOutcome {
  const { riskLevel } = riskReview
  const { requiresApprovalByPolicy = false } = options

  // LOW / MEDIUM は自動継続（承認不要）。ただし policy 上の承認必須指定がある場合は
  // 自動継続をスキップし、以降の existingReq 照合・BLOCKED 生成へ進む（riskLevel は変更しない）。
  if (!requiresApprovalByPolicy && (riskLevel === 'LOW' || riskLevel === 'MEDIUM')) {
    return { decision: 'ALLOW', riskLevel }
  }

  // HIGH / CRITICAL 相当（または policy により承認必須化された LOW/MEDIUM）:
  // 既存リクエストを照合する。この分岐は riskLevel を一切参照しないため無変更で流用できる。
  if (existingReq) {
    const effective = resolveEffectiveStatus(existingReq, currentCommit, currentDiffHash)

    if (effective === 'APPROVED') {
      // consumedRequestId を返すことで呼び出し元が承認を SUPERSEDED にできる
      // （一回限りの承認を保証するため、呼び出し元が必ず updateStatus を呼ぶ）
      return { decision: 'ALLOW', riskLevel, consumedRequestId: existingReq.id }
    }
    if (effective === 'STALE') {
      return {
        decision: 'STALE',
        requestId: existingReq.id,
        reason: 'commit または diff が変化したため承認が無効になりました。再承認が必要です。',
      }
    }
    if (effective === 'WAITING_FOR_USER') {
      return { decision: 'PENDING_APPROVAL', requestId: existingReq.id, riskLevel }
    }
    if (effective === 'REJECTED') {
      return {
        decision: 'REJECTED',
        requestId: existingReq.id,
        riskLevel,
        reason: 'この変更はCEOにより却下されています。同一内容のため再承認依頼は作成されません。内容を変更するか、CEOの追加指示を待ってください。',
      }
    }
    // EXPIRED / SUPERSEDED → 新規リクエスト作成が必要
  }

  // 承認リクエストなし or 無効状態 → BLOCKED（新規リクエスト作成を促す）
  // policy起因（riskLevelはLOW/MEDIUMのまま）の場合は、実際のriskLevelを偽らない固定文言にする。
  const reason = requiresApprovalByPolicy && (riskLevel === 'LOW' || riskLevel === 'MEDIUM')
    ? 'git_commit はポリシー上CEO承認が必要です。承認リクエストを作成してください。'
    : riskLevel === 'CRITICAL'
      ? `CRITICAL リスク: 人間承認が必要です。承認リクエストを作成してください。[${riskReview.triggeredRules.join(', ')}]`
      : `HIGH リスク: 人間承認が必要です。承認リクエストを作成してください。[${riskReview.triggeredRules.join(', ')}]`

  return {
    decision: 'BLOCKED',
    reason,
    riskLevel,
  }
}

// ────────────────────────────────────────────────────────────
// ApprovalRequest ファクトリ（純粋関数）
// ────────────────────────────────────────────────────────────

/**
 * Storage に渡す ApprovalRequest の作成データを返す（id / createdAt は Storage が付与）
 *
 * @param input      ApprovalGateInput
 * @param riskLevel  Risk Review が算出したリスクレベル
 * @param now        現在時刻（省略時は new Date()。テスト時に注入可能）
 */
export function buildApprovalRequest(
  input: ApprovalGateInput,
  riskLevel: RiskLevel,
  triggeredRulesOrNow: string[] | Date = [],
  now?: Date,
): Omit<ApprovalRequest, 'id' | 'createdAt'> {
  const triggeredRules = Array.isArray(triggeredRulesOrNow) ? triggeredRulesOrNow : []
  const requestTime = triggeredRulesOrNow instanceof Date ? triggeredRulesOrNow : (now ?? new Date())
  const exp = computeExpiresAt(requestTime)
  return {
    taskId: input.taskId,
    targetBranch: input.targetBranch,
    targetCommit: input.targetCommit,
    targetDiffHash: input.targetDiffHash,
    riskLevel,
    requestedAction: input.requestedAction,
    changedFiles: [...input.changedFiles],
    triggeredRules: [...triggeredRules],
    status: 'WAITING_FOR_USER',
    expiresAt: exp,
    invalidIf: [
      'commit hash が変わった場合',
      'git diff の内容が変わった場合',
      `${exp} を過ぎた場合`,
    ],
  }
}
