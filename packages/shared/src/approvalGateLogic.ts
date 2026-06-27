/**
 * Approval Gate — Pure Logic (shared)
 *
 * apps/worker/src/guards/approvalGate.ts から移植した純粋関数群。
 * API と worker の両方からインポートできるように packages/shared に配置する。
 */

import { createHash } from 'crypto'
import type {
  ApprovalGateInput,
  ApprovalRequest,
  ApprovalGateStatus,
  GateOutcome,
  RiskReviewResult,
} from './types/approval_gate'
import type { RiskLevel } from './types/safety_guard'

// ────────────────────────────────────────────────────────────
// Risk Review（ルールベース簡易実装）
// TODO: Phase 2 で Independent AI Review に差し替え可能な接続点
// ────────────────────────────────────────────────────────────

interface RiskRule {
  label: string
  pattern: RegExp
  level: RiskLevel
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
  { label: 'alignment / gate change',    pattern: /alignmentCheck|approvalGate|gateProcessor/i, level: 'HIGH' },
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

/**
 * changedFiles からリスクレベルを算出する（純粋関数）
 */
export function runRiskReview(changedFiles: string[]): RiskReviewResult {
  // CRITICAL ルールを先に評価して safe-only 早期リターンを防ぐ（bypass ガード）
  // Codex P3: ここでは早期リターンせず「CRITICAL ファイルが含まれるか」だけ判定する
  const hasCriticalFile = changedFiles.some(f =>
    ALWAYS_CRITICAL_RULES.some(r => r.pattern.test(f))
  )

  // CRITICAL ファイルがなければ safe-only 早期リターンを許可
  if (!hasCriticalFile) {
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
// diff hash（commit/diff 照合用）
// ────────────────────────────────────────────────────────────

/**
 * git diff 文字列の SHA-256 ハッシュを返す（純粋関数）
 */
export function computeDiffHash(diffText: string): string {
  return createHash('sha256').update(diffText, 'utf-8').digest('hex')
}

// ────────────────────────────────────────────────────────────
// 承認の有効期限を算出（純粋関数）
// ────────────────────────────────────────────────────────────

function computeExpiresAt(riskLevel: RiskLevel, now: Date): string {
  const minutes = riskLevel === 'CRITICAL' ? 60 : 30
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString()
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

/**
 * Risk Review 結果と既存の ApprovalRequest（あれば）から GateOutcome を決定する。
 *
 * @param riskReview   runRiskReview() の結果
 * @param existingReq  storage から取得したアクティブな ApprovalRequest（なければ undefined）
 * @param currentCommit  現在の git HEAD commit hash
 * @param currentDiffHash  現在の diff hash
 */
export function decideGateOutcome(
  riskReview: RiskReviewResult,
  existingReq: ApprovalRequest | undefined,
  currentCommit: string,
  currentDiffHash: string,
): GateOutcome {
  const { riskLevel } = riskReview

  // LOW / MEDIUM は自動継続（承認不要）
  if (riskLevel === 'LOW' || riskLevel === 'MEDIUM') {
    return { decision: 'ALLOW', riskLevel }
  }

  // HIGH / CRITICAL: 既存リクエストを照合
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
    // REJECTED / EXPIRED / SUPERSEDED → 新規リクエスト作成が必要
  }

  // 承認リクエストなし or 無効状態 → BLOCKED（新規リクエスト作成を促す）
  return {
    decision: 'BLOCKED',
    reason: riskLevel === 'CRITICAL'
      ? `CRITICAL リスク: 人間承認が必要です。承認リクエストを作成してください。[${riskReview.triggeredRules.join(', ')}]`
      : `HIGH リスク: 人間承認が必要です。承認リクエストを作成してください。[${riskReview.triggeredRules.join(', ')}]`,
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
  now: Date = new Date(),
): Omit<ApprovalRequest, 'id' | 'createdAt'> {
  const exp = computeExpiresAt(riskLevel, now)
  return {
    taskId: input.taskId,
    targetBranch: input.targetBranch,
    targetCommit: input.targetCommit,
    targetDiffHash: input.targetDiffHash,
    riskLevel,
    requestedAction: input.requestedAction,
    status: 'WAITING_FOR_USER',
    expiresAt: exp,
    invalidIf: [
      'commit hash が変わった場合',
      'git diff の内容が変わった場合',
      `${exp} を過ぎた場合`,
    ],
  }
}
