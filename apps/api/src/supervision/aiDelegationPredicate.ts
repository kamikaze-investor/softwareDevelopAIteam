/**
 * ai_delegation の completion predicate（Contract C-3 / D-2）
 *
 * 「成功」の定義は **formal verdict が存在すること**であって、process が終了したことではない。
 * 実障害ケース1では `ssh ... codex exec` が子processごと死に、出力0 byteのまま放置された。
 * exit code だけを見る判定はこれを success とも failure とも言えない。
 *
 * したがってここでは次を要求する:
 *   - `verdict` ファイルが存在し、**既知の formal verdict のいずれか**であること
 *   - `COMPLETED` を名乗る場合は、**log に DONE marker が実在すること**を独立に再確認する
 *
 * これにより **exit 0 + 空出力 / verdict無し は決して satisfied にならない**。
 * verdict が無い間は `not_satisfied`（まだ終わっていない）であり、
 * 壊れた verdict は `unevaluatable`（判定不能 → fail-closed）である。
 *
 * 判定ロジックは DB に置かない（D-2）。DB が持つのは predicateKey / predicateVersion と
 * 観測結果だけで、この関数が唯一の実装である。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { registerPredicate } from '@ai-team/shared'
import type { PredicateContext, PredicateEvaluation } from '@ai-team/shared'
import { resolveInsideRunDir, runDirFor } from './runDirectory'

export const AI_DELEGATION_PREDICATE_KEY = 'ai_delegation.formal_verdict'
export const AI_DELEGATION_PREDICATE_VERSION = 1

/** delegate-watchdog.sh が `verdict` へ書く終端値の全集合。 */
export const FORMAL_VERDICTS = [
  'COMPLETED',
  'ESCALATE:blocked',
  'ESCALATE:recovery_exhausted',
  'ESCALATE:watchdog_interrupted',
] as const

export type FormalVerdict = (typeof FORMAL_VERDICTS)[number]

export function isFormalVerdict(value: string): value is FormalVerdict {
  return (FORMAL_VERDICTS as readonly string[]).includes(value)
}

/** DONE marker。delegate.sh / delegate-watchdog.sh が prompt へ強制注入するもの。 */
const DONE_MARKER = 'AI_TEAM_OS_STATUS:DONE'
const BLOCKED_MARKER = 'AI_TEAM_OS_STATUS:BLOCKED'

export interface DelegationRunDirState {
  verdict?: string
  currentLog?: string
  logBytes: number
  logMtimeMs: number
  hasDoneMarker: boolean
  hasBlockedMarker: boolean
  /** current_log が runDir 外を指していたため読まなかった。 */
  logRejected: boolean
}

function readTrimmed(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf-8').trim()
    return text.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * run_dir の観測。**判定ではなく観測**であり、結果はそのまま evidence として保存できる形にする。
 *
 * `runDir` は呼び出し元から受け取らず、常に `runDirFor(runId)`（server 生成 id 由来）を渡すこと。
 * `current_log` は runDir 配下の**相対 path のみ**許可し、symlink / traversal で
 * 外を指すものは読まない（独立レビュー指摘 Step 3 #3）。
 *
 * PID の生死は一切見ない（C-2 / PID alive != healthy）。
 */
export function observeDelegationRunDir(runDir: string): DelegationRunDirState {
  const verdict = readTrimmed(path.join(runDir, 'verdict'))
  const declaredLog = readTrimmed(path.join(runDir, 'current_log'))

  let currentLog: string | undefined
  let logBytes = 0
  let logMtimeMs = 0
  let hasDoneMarker = false
  let hasBlockedMarker = false
  let logRejected = false

  if (declaredLog !== undefined) {
    const safeLog = resolveInsideRunDir(runDir, declaredLog)
    if (safeLog === undefined) {
      // runDir の外を指す current_log は読まない。DONE marker 検査の偽装経路を塞ぐ。
      logRejected = true
    } else {
      currentLog = safeLog
      try {
        const stat = statSync(safeLog)
        logBytes = stat.size
        logMtimeMs = stat.mtimeMs
        const text = readFileSync(safeLog, 'utf-8')
        hasDoneMarker = text.includes(DONE_MARKER)
        hasBlockedMarker = text.includes(BLOCKED_MARKER)
      } catch {
        // 読めない = 観測できないだけ。ここでは判定しない。
      }
    }
  }

  return { verdict, currentLog, logBytes, logMtimeMs, hasDoneMarker, hasBlockedMarker, logRejected }
}

/**
 * completion predicate 本体。
 *
 * 入力は **`context.runId` から導出する**。evidence に書かれた path は信用しない
 * （独立レビュー指摘 Step 3 #3: 呼び出し元由来の path を信用すると判定自体が偽装できる）。
 */
export async function evaluateAiDelegationCompletion(context: PredicateContext): Promise<PredicateEvaluation> {
  let runDir: string
  try {
    runDir = runDirFor(context.runId)
  } catch (err) {
    return { outcome: 'unevaluatable', reason: err instanceof Error ? err.message : String(err) }
  }

  if (!existsSync(runDir)) {
    return { outcome: 'unevaluatable', reason: `delegation run directory is gone: ${runDir}` }
  }

  const state = observeDelegationRunDir(runDir)

  if (state.logRejected) {
    return {
      outcome: 'unevaluatable',
      reason: 'current_log points outside the trusted run directory (symlink or traversal); refusing to read it',
    }
  }

  // verdict がまだ無い = まだ終わっていない。**成功でも失敗でもない。**
  if (state.verdict === undefined) {
    return {
      outcome: 'not_satisfied',
      evidence: {
        runDir,
        logBytes: state.logBytes,
        logMtimeMs: state.logMtimeMs,
        // 実出力が1 byteも無い状態を「観測できた進捗」と混同させないための明示フラグ。
        hasOutput: state.currentLog !== undefined && state.logBytes > 0,
        reason: 'no formal verdict yet',
      },
    }
  }

  if (!isFormalVerdict(state.verdict)) {
    // 既知の終端値でない文字列を勝手に成功へ寄せない。
    return { outcome: 'unevaluatable', reason: `unknown formal verdict: ${state.verdict.slice(0, 120)}` }
  }

  // COMPLETED を名乗る場合だけ、log 側の DONE marker を独立に再確認する。
  // これが「exit 0 + 空出力」を success にしないための最後の砦である。
  if (state.verdict === 'COMPLETED' && !state.hasDoneMarker) {
    return {
      outcome: 'unevaluatable',
      reason: 'verdict claims COMPLETED but the delegation log has no DONE marker (empty or truncated output)',
    }
  }

  return {
    outcome: 'satisfied',
    evidence: {
      runDir,
      formalVerdict: state.verdict,
      logBytes: state.logBytes,
      hasDoneMarker: state.hasDoneMarker,
      hasBlockedMarker: state.hasBlockedMarker,
    },
  }
}

/** formal verdict から supervised run の terminal status を決める。 */
export function terminalStatusForVerdict(verdict: FormalVerdict): 'succeeded' | 'failed' {
  return verdict === 'COMPLETED' ? 'succeeded' : 'failed'
}

let registered = false

/** registry へ登録する。多重登録は registry 側が throw するため、冪等にしておく。 */
export function registerAiDelegationPredicate(): void {
  if (registered) return
  registerPredicate({
    key: AI_DELEGATION_PREDICATE_KEY,
    version: AI_DELEGATION_PREDICATE_VERSION,
    kind: 'ai_delegation',
    description:
      'delegate-watchdog.sh が formal verdict を書き、COMPLETED の場合は log の DONE marker でも裏取りできること',
    evaluate: evaluateAiDelegationCompletion,
  })
  registered = true
}

/** テスト専用。registry の reset と対で使う。 */
export function resetAiDelegationPredicateRegistrationForTest(): void {
  registered = false
}
