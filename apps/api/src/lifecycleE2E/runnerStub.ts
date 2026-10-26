/**
 * Lifecycle E2E の **Design Review runner stub** と、テスト専用の target worktree の所在。
 *
 * このファイルは route / storage を一切 import しない。各 test file の `vi.mock()` factory が
 * これを import するため、route 側を import すると mock 解決の途中で循環して止まる。
 *
 * 置き換えるのは **runner プロセスの出力だけ**である（`CoordinatorDeps.execute`）。claim・
 * attempt 予算・判定の再計算（`recomputeDecision()`）・evidence 登録・repair handoff は
 * すべて本物のコードが走る。stub は「その runner 入力に対して実 runner が返したであろう JSON」を
 * 作るだけで、focus の集合は API と同じ `classifyReviewLoad()` / `selectFocuses()` から導く
 * （集合が合わない出力は本物の構造検証で UNCERTAIN に落ちるので、stub が判定を作ることはない）。
 */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { classifyReviewLoad } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { selectFocuses, selectRoadmapReviewFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
import type { CoordinatorDeps, RunnerExecution } from '../designReview/designReviewCoordinator'

/**
 * runner の 1 回分の振る舞い。
 *
 * - `ALIGNED` / `CONFLICT` … 期待 focus を全部埋めた正しい形の判定
 * - `CONFLICT_MISSING_INDEPENDENT` … CONFLICT かつ critical で必須の independent が無い（b8d0fc5d の形）
 * - `REVIEW_UNAVAILABLE` … runner が `finalDecision: 'REVIEW_UNAVAILABLE'` を返した（provider logout 等）
 * - `RUNNER_UNAVAILABLE` … runner プロセス自体が失敗した（`ok: false`）
 */
export type StubVerdict =
  | 'ALIGNED'
  | 'CONFLICT'
  | 'CONFLICT_MISSING_INDEPENDENT'
  | 'REVIEW_UNAVAILABLE'
  | 'RUNNER_UNAVAILABLE'

export interface StubCall {
  reviewKind: string
  subjectId: string
  changedFiles: string[]
  designText: string
  verdict: StubVerdict
}

interface StubState {
  queue: StubVerdict[]
  fallback: StubVerdict
  calls: StubCall[]
}

const state: StubState = { queue: [], fallback: 'ALIGNED', calls: [] }

/** テスト専用の target worktree（`TARGET_WORKING_DIR` / `TARGET_ROOT`）。test file ごとに一意。 */
export const LIFECYCLE_TARGET_DIR: string = path.join(os.tmpdir(), `lifecycle-e2e-${randomUUID()}`)

/** 次の runner 呼び出しから順に使う振る舞いを積む。尽きたら fallback（既定 ALIGNED）。 */
export function scriptDesignReview(...verdicts: StubVerdict[]): void {
  state.queue.push(...verdicts)
}

export function setDesignReviewFallback(verdict: StubVerdict): void {
  state.fallback = verdict
}

export function resetDesignReviewStub(): void {
  state.queue = []
  state.fallback = 'ALIGNED'
  state.calls = []
}

export function designReviewCalls(): readonly StubCall[] {
  return state.calls
}

function taskOutput(verdict: Exclude<StubVerdict, 'RUNNER_UNAVAILABLE'>, changedFiles: string[]): Record<string, unknown> {
  const reviewLoad = classifyReviewLoad({ changedFiles }).reviewLoad
  const focuses = selectFocuses(reviewLoad, changedFiles)
  const critical = reviewLoad === 'critical'
  if (verdict === 'REVIEW_UNAVAILABLE') {
    return {
      focusedReviewResults: focuses.map((focus) => ({ focus, decision: 'UNCERTAIN', unavailable: true })),
      integrationReviewResult: { decision: 'UNCERTAIN', unavailable: true },
      finalDecision: 'REVIEW_UNAVAILABLE',
      unavailableReason: 'stub: provider is logged out',
    }
  }
  const decision = verdict === 'ALIGNED' ? 'ALIGNED' : 'CONFLICT'
  return {
    focusedReviewResults: focuses.map((focus) => ({ focus, decision })),
    integrationReviewResult: { decision },
    ...(critical && verdict !== 'CONFLICT_MISSING_INDEPENDENT'
      ? { independentReviewResult: { verdict: decision === 'ALIGNED' ? 'approved' : 'changes_requested' } }
      : {}),
    finalDecision: decision,
  }
}

function roadmapOutput(): Record<string, unknown> {
  return {
    focusedReviewResults: selectRoadmapReviewFocuses().map((focus) => ({ focus, decision: 'ALIGNED' })),
    integrationReviewResult: { decision: 'ALIGNED' },
    independentReviewResult: { verdict: 'approved' },
    finalDecision: 'ALIGNED',
  }
}

/** `CoordinatorDeps.execute` の差し替え。入力は本物の coordinator が組んだ runner 入力 JSON。 */
export async function executeDesignReviewStub(input: string): Promise<RunnerExecution> {
  const parsed = JSON.parse(input) as {
    reviewKind: string
    subjectId: string
    changedFiles?: string[]
    designText?: string
  }
  const verdict = state.queue.shift() ?? state.fallback
  const changedFiles = parsed.changedFiles ?? []
  state.calls.push({
    reviewKind: parsed.reviewKind,
    subjectId: parsed.subjectId,
    changedFiles,
    designText: parsed.designText ?? '',
    verdict,
  })
  if (verdict === 'RUNNER_UNAVAILABLE') {
    return { ok: false, stdout: '', error: 'stub: design review runner is unavailable', timedOut: false }
  }
  const output = parsed.reviewKind === 'roadmap' ? roadmapOutput() : taskOutput(verdict, changedFiles)
  return { ok: true, stdout: JSON.stringify(output), timedOut: false }
}

/** 本物の `buildDefaultCoordinatorDeps()` の代わり。spawn する経路を持たない。 */
export function stubCoordinatorDeps(): CoordinatorDeps {
  return {
    runnerCommand: 'lifecycle-e2e-stub',
    runnerArgs: [],
    homeDirectory: LIFECYCLE_TARGET_DIR,
    workingDir: LIFECYCLE_TARGET_DIR,
    execute: executeDesignReviewStub,
  }
}
