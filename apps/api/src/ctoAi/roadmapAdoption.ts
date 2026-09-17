/**
 * 既存 Roadmap 項目の採用（adoption）。
 *
 * **目的**: `tasks/roadmap.md`（正式 Roadmap ledger）は Finding・設計メモ・deferred 項目・
 * 調査記録・実装候補を含む**長期計画の台帳**であり、そのまま全件を Task 化すべきものではない。
 * ここが提供するのは「PL が次に実装すると決めた1件だけを、実行可能な Task specification へ
 * 具体化して採用する」経路である。
 *
 * **新しい仕組みを作らない**:
 *   - Roadmap の再生成をしない（LLM を呼ばない）
 *   - `docs/roadmap.md` / `tasks/task_graph.md` を書かない（`roadmapWriter` を使わない）
 *   - 新しい adoption state / 管理テーブル / Task status / Project status を追加しない
 *   - 既存 parser（`roadmapParser`）・既存 validation（`roadmapTaskValidation`）・
 *     既存同期（`syncRoadmapTasks`）・既存 Job 生成（`ensureInitialWorkflowsForActiveTasks`）
 *     をそのまま再利用する
 *
 * **採用済み Task の累積集合を持たない理由（2026-09-14 に実装を確認して決定）**:
 * `syncRoadmapTasks` は入力に含まれない既存 roadmapActive Task を `roadmapActive=false` へ
 * 落とすが、これは害にならない。次 Task 選択の `selectNextContinuableTask()` は
 * `status === 'pending'` を要求するため、**完了済み Task はそもそも候補にならない**
 * （`roadmapActive` の値によらない）。したがって「直前に採用した1件だけが roadmapActive」
 * という運用で continuation・resume・履歴はいずれも成立する。
 * 累積集合を管理する新しい仕組みは作らない。
 *
 * ただし **adoption は必ず1件以上を同期する**。0件で同期すると全 Task が非活性化し、
 * `hasActiveRoadmap` が false へ戻って次の running 遷移で Roadmap 再生成が走ってしまう。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ADOPTABLE_ROADMAP_STATES,
  getValidRoadmapItems,
  isRoadmapItemAdoptable,
  RoadmapValidationError,
  type RoadmapItem,
} from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
import {
  createFollowUpTaskKey,
  getBaseRoadmapId,
  isFollowUpTaskKey,
  MAX_FOLLOW_UPS_PER_ROADMAP_ITEM,
} from '@ai-team/shared'
import type { IStorage, RoadmapSyncTaskInput, RoadmapSyncPhaseInput } from '../storage/interface'
import { validateRoadmapTasks, validateRoadmapPhases } from '../storage/roadmapTaskValidation'
import { ensureInitialWorkflowsForActiveTasks } from './projectInitialization'

/**
 * 採用した Task が属する Phase。
 *
 * ledger は per-item の phase を持たない。`phase` は `selectNextContinuableTask()` の
 * ソートキーとしてしか使われないが、`GET /api/projects/:id/roadmap` が Phase 単位で
 * Task を返すため、Phase 行が無いと採用した Task が Mobile の Roadmap 画面から見えなくなる。
 * そこで**単一の固定 Phase**だけを持たせる。Phase 体系を ledger へ導入するものではない。
 */
export const ADOPTED_PHASE_NUMBER = 1
const ADOPTED_PHASE_NAME = '採用中のRoadmap項目'
const ADOPTED_PHASE_GOAL = 'tasks/roadmap.md から採用した実装対象を実行する'

export type AdoptRoadmapItemFailure =
  | 'ROADMAP_UNREADABLE'
  | 'ROADMAP_INVALID'
  | 'ITEM_NOT_FOUND'
  | 'ITEM_ALREADY_DONE'
  | 'ITEM_NOT_ADOPTABLE'
  | 'ALREADY_EXECUTED'
  | 'FOLLOW_UP_NOT_ELIGIBLE'
  | 'FOLLOW_UP_NO_PROGRESS'
  | 'SPEC_INVALID'
  | 'SYNC_FAILED'

export type AdoptRoadmapItemResult =
  | { ok: true; taskId: string; roadmapTaskKey: string; title: string }
  | { ok: false; code: AdoptRoadmapItemFailure; reason: string; details?: unknown }

export interface AdoptRoadmapItemInput {
  projectId: string
  /**
   * `tasks/roadmap.md` の `roadmap:id`（= baseRoadmapId）。
   *
   * 通常採用ではそのまま `roadmapTaskKey` になる（追跡可能性）。
   * follow-up では base のまま受け取り、**Task identity はサーバ側が決める**
   * （`createFollowUpTaskKey()`。caller に key を入力させない）。
   */
  roadmapId: string
  /** PL が明示する変更許可範囲。ledger の散文からは推測しない。 */
  allowedPaths: string[]
  /** PL が明示する完了条件。ledger の散文からは推測しない。 */
  acceptanceCriteria: string[]
  /**
   * 今回実装する範囲。**任意**。
   *
   * 複数サブ項目を含む ledger 項目を採用するとき、対象サブ項目だけを明示するために使う。
   * 指定すると description の先頭へ「今回実装する範囲」として載り、ledger 本文はその後ろに残る。
   * **ledger 側の書式は一切変えない**（`buildAdoptedDescription()` 参照）。
   */
  implementationScope?: string
  /**
   * 既に実行済みの Roadmap 項目に対する **follow-up 採用**として扱う。
   *
   * 既定（`false` / 未指定）では従来どおりの初回採用であり、**挙動は一切変わらない**。
   * `true` のときだけ、別 Task identity（`<base>#<sequence>`）を作る経路へ入り、
   * `assertFollowUpEligible()` の前提条件をすべて満たす場合にのみ通す。
   *
   * CEO 判断（2026-09-17）: これは `ALREADY_EXECUTED` の緩和ではなく、
   * 「同一 Task identity の二重実行は禁止」への精緻化である。
   */
  followUp?: boolean
}

export interface AdoptRoadmapItemDeps {
  /** Roadmap ledger の所在。既定は target repository の `tasks/roadmap.md`。 */
  roadmapPath?: string
  readRoadmap?: (roadmapPath: string) => string
  ensureInitialWorkflows?: typeof ensureInitialWorkflowsForActiveTasks
}

function resolveTargetRoot(): string {
  return process.env.TARGET_ROOT ?? '/workspace/target'
}

/**
 * 採用対象項目の本文を ledger から切り出す。
 *
 * parser が返す行 index をそのまま使い、checkbox 行から次の roadmap metadata 行の直前までを
 * description とする。**parser へ新しい抽出責務を足さない**ための切り出しである。
 */
/**
 * 採用した Task の description を組み立てる。
 *
 * **問題**: description は ledger 項目の本文全文になる。複数サブ項目を含む項目では、
 * Implementer が対象外のサブ項目まで実装対象と解釈する。production で2回再現した
 * （直近: `roadmap-adoption-followups` の採用で、対象外と明記したサブ項目(2)側の
 * `schema.ts` / `sqlite.ts` / `types/task.ts` 等を変更し、File Change Guard が
 * `fileChangeAllowed:false` で停止させた。安全機構は正しく働いたが、Task は進まなかった）。
 *
 * **最小の対処**: 採用時に「今回実装する範囲」を**プロンプト上だけ**で上書きできるようにする。
 * ledger 本文はそのまま後ろに残す（文脈として必要であり、**ledger 側へサブ項目の構造化は
 * 持ち込まない**という本項目の方針にも従う）。
 *
 * `implementationScope` 未指定なら、従来どおり ledger 本文だけを返す（後方互換）。
 */
/**
 * 採用時に埋め込んだ「今回実装する範囲」を description から取り出す。
 *
 * `buildAdoptedDescription()` が書いた形だけを読む。見出しが無ければ `undefined`
 * （= scope 未指定で採用された従来の Task）。
 */
export function extractImplementationScope(description: string): string | undefined {
  const heading = '## 今回実装する範囲（この Task の対象）'
  const start = description.indexOf(heading)
  if (start === -1) return undefined

  const rest = description.slice(start + heading.length)
  const end = rest.indexOf('**上記以外は対象外である。**')
  const scope = (end === -1 ? rest : rest.slice(0, end)).trim()
  return scope === '' ? undefined : scope
}

/** 比較用に scope を正規化する。空白の揺れだけで「別の作業」と誤認しないため。 */
function normalizeScope(scope: string): string {
  return scope.replace(/\s+/g, ' ').trim().toLowerCase()
}

type FollowUpEligibility =
  | { ok: true }
  | { ok: false; failure: AdoptRoadmapItemResult & { ok: false } }

/**
 * follow-up を作ってよい状態かを機械的に確かめる。**AI の申告は一切見ない。**
 *
 * CEO 確定の成立条件（2026-09-17）をそのまま実装する。1つでも欠ければ follow-up は作らない。
 * blocked / failed を follow-up で迂回させないことがとくに重要で、それらには
 * 既存の resume / diagnosis 経路という正規の復旧手段がある。
 */
function checkFollowUpEligibility(
  storage: IStorage,
  input: AdoptRoadmapItemInput,
  projectTasks: readonly { id: string; status: string; roadmapTaskKey?: string; description: string }[],
): FollowUpEligibility {
  const fail = (code: AdoptRoadmapItemFailure, reason: string): FollowUpEligibility => ({
    ok: false,
    failure: { ok: false, code, reason },
  })

  const siblings = projectTasks.filter(
    (task) => task.roadmapTaskKey !== undefined && getBaseRoadmapId(task.roadmapTaskKey) === input.roadmapId,
  )

  // 1. 先行 Task が実在すること。無いなら follow-up ではなく通常採用である。
  if (siblings.length === 0) {
    return fail(
      'FOLLOW_UP_NOT_ELIGIBLE',
      `roadmap item "${input.roadmapId}" has no prior task; adopt it normally instead of as a follow-up`,
    )
  }

  // 2. 先行 Task が実行済みであること。Job が1つも無いなら、まだ初回が動いていない。
  const executed = siblings.filter((task) => storage.jobs.findByTaskId(task.id).length > 0)
  if (executed.length === 0) {
    return fail(
      'FOLLOW_UP_NOT_ELIGIBLE',
      `roadmap item "${input.roadmapId}" has no executed prior task; nothing has run yet`,
    )
  }

  // 3. active Task が残っていないこと。blocked / failed を follow-up で迂回させない。
  //    blocked は resume 経路、failed は PL diagnosis / recovery 経路が正規の復旧手段である。
  const active = siblings.find((task) => task.status !== 'done')
  if (active) {
    return fail(
      'FOLLOW_UP_NOT_ELIGIBLE',
      `task ${active.id} for "${input.roadmapId}" is still ${active.status}; ` +
        'resolve it through the existing resume / recovery path instead of creating a follow-up',
    )
  }

  // 4. pending continuation が無いこと。進行中のチェーンと競合させない。
  const pending = storage.taskContinuations.findPendingByProjectId(input.projectId)
  if (pending.length > 0) {
    return fail(
      'FOLLOW_UP_NOT_ELIGIBLE',
      `${pending.length} task continuation(s) are still pending in this project; let the existing chain settle first`,
    )
  }

  // 5. 新しい implementationScope が明示されていること。**follow-up では必須**である。
  const scope = input.implementationScope?.trim()
  if (!scope) {
    return fail(
      'FOLLOW_UP_NOT_ELIGIBLE',
      'a follow-up requires an explicit implementationScope naming the remaining work',
    )
  }

  // 6. 前の Task と同じ作業を繰り返していないこと。
  //    **上限 10 を待たずここで止める。** 上限は最後の非常ブレーキであって、
  //    重複検知の主役ではない。
  const repeated = siblings.find((task) => {
    const previous = extractImplementationScope(task.description)
    return previous !== undefined && normalizeScope(previous) === normalizeScope(scope)
  })
  if (repeated) {
    return fail(
      'FOLLOW_UP_NO_PROGRESS',
      `the requested scope is identical to task ${repeated.id}; ` +
        'a follow-up must name work that the prior task did not do',
    )
  }

  return { ok: true }
}

export function buildAdoptedDescription(
  ledgerBody: string,
  implementationScope: string | undefined,
): string {
  const scope = implementationScope?.trim()
  if (!scope) return ledgerBody

  return [
    '## 今回実装する範囲（この Task の対象）',
    '',
    scope,
    '',
    '**上記以外は対象外である。** 以下は採用元 Roadmap 項目の本文であり、',
    '文脈として残しているだけで実装対象の定義ではない。',
    '',
    '---',
    '',
    ledgerBody,
  ].join('\n')
}

export function extractItemDescription(markdown: string, item: RoadmapItem): string {
  const lines = markdown.split(/\r?\n/)
  const start = item.checkboxLineIndex
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*<!--\s*roadmap:id=/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trimEnd()
}

export async function adoptRoadmapItem(
  storage: IStorage,
  input: AdoptRoadmapItemInput,
  deps: AdoptRoadmapItemDeps = {},
): Promise<AdoptRoadmapItemResult> {
  const allowedPaths = input.allowedPaths.map((value) => value.trim()).filter(Boolean)
  const acceptanceCriteria = input.acceptanceCriteria.map((value) => value.trim()).filter(Boolean)

  // allowedPaths / acceptanceCriteria は実行時の安全境界と完成判定そのものなので、
  // 空のまま採用させない（fail-closed）。ledger から自動補完もしない。
  if (allowedPaths.length === 0) {
    return { ok: false, code: 'SPEC_INVALID', reason: 'allowedPaths must be explicitly provided and non-empty' }
  }
  if (acceptanceCriteria.length === 0) {
    return { ok: false, code: 'SPEC_INVALID', reason: 'acceptanceCriteria must be explicitly provided and non-empty' }
  }

  const roadmapPath = deps.roadmapPath ?? path.join(resolveTargetRoot(), 'tasks', 'roadmap.md')
  const read = deps.readRoadmap ?? ((target: string) => readFileSync(target, 'utf-8'))

  let markdown: string
  try {
    markdown = read(roadmapPath)
  } catch (err: unknown) {
    return {
      ok: false,
      code: 'ROADMAP_UNREADABLE',
      reason: `Could not read the roadmap at ${roadmapPath}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 既存の検証をそのまま使う。ledger に1件でも不整合があれば採用しない（fail-closed）。
  let items: RoadmapItem[]
  try {
    items = getValidRoadmapItems(markdown)
  } catch (err: unknown) {
    if (err instanceof RoadmapValidationError) {
      return { ok: false, code: 'ROADMAP_INVALID', reason: err.message, details: err.issues }
    }
    throw err
  }

  const item = items.find((candidate) => candidate.id === input.roadmapId)
  if (!item) {
    return { ok: false, code: 'ITEM_NOT_FOUND', reason: `Roadmap item "${input.roadmapId}" does not exist` }
  }

  // 完了済み項目を再実行しない。
  if (item.state === 'done') {
    return { ok: false, code: 'ITEM_ALREADY_DONE', reason: `Roadmap item "${input.roadmapId}" is already done` }
  }

  // done 以外の非採用 state（deferred / blocked）も採用しない。ledger 上の
  // 「今はやらない」「前提が解消していない」という意思表示を、採用経路でも機械的に守る。
  if (!isRoadmapItemAdoptable(item.state)) {
    return {
      ok: false,
      code: 'ITEM_NOT_ADOPTABLE',
      reason: `Roadmap item "${input.roadmapId}" is ${item.state}; only ${ADOPTABLE_ROADMAP_STATES.join(' / ')} items can be adopted`,
    }
  }

  // ── Task identity を決める ──────────────────────────────
  // 通常採用では taskKey === input.roadmapId であり、以降の判定は従来と完全に同一に働く。
  // follow-up のときだけ別 identity を **サーバ側で** 発番する（caller は key を選べない）。
  const projectTasks = storage.tasks.findByProjectId(input.projectId)

  let taskKey = input.roadmapId
  if (input.followUp === true) {
    const eligibility = checkFollowUpEligibility(storage, input, projectTasks)
    if (!eligibility.ok) return eligibility.failure

    const minted = createFollowUpTaskKey(
      input.roadmapId,
      projectTasks
        .map((task) => task.roadmapTaskKey)
        .filter((key): key is string => key !== undefined),
    )
    if (!minted.ok) {
      return { ok: false, code: 'FOLLOW_UP_NOT_ELIGIBLE', reason: minted.reason }
    }
    taskKey = minted.roadmapTaskKey
  }

  // 同一 Task identity の二重実行を拒否する（既存防御）。
  // **判定対象を「Roadmap item」から「Task identity」へ精緻化しただけで、緩めていない。**
  // 通常採用では taskKey === input.roadmapId なので、結果は従来と1ビットも変わらない。
  const existingTask = projectTasks.find((task) => task.roadmapTaskKey === taskKey)
  if (existingTask && storage.jobs.findByTaskId(existingTask.id).length > 0) {
    return {
      ok: false,
      code: 'ALREADY_EXECUTED',
      reason: `"${taskKey}" already has an executed Task (${existingTask.id})`,
    }
  }

  const taskInput: RoadmapSyncTaskInput = {
    roadmapTaskKey: taskKey,
    title: item.title,
    description: buildAdoptedDescription(
      extractItemDescription(markdown, item),
      input.implementationScope,
    ),
    phase: ADOPTED_PHASE_NUMBER,
    // 採用した項目は「実装して commit まで到達させる」ものなので固定でよい。
    // `selectNextContinuableTask()` と初回 Implement Job の eligibility が
    // `developer_ai` を要求するため、ここを可変にしても選べる値は1つしかない。
    assignee: 'developer_ai',
    category: 'implementation',
    // 1件ずつ採用するため依存は持たない。
    dependencies: [],
    acceptanceCriteria,
    allowedPaths,
  }

  const phaseInput: RoadmapSyncPhaseInput = {
    phaseNumber: ADOPTED_PHASE_NUMBER,
    name: ADOPTED_PHASE_NAME,
    goal: ADOPTED_PHASE_GOAL,
  }

  // 既存 validation をそのまま再利用する（allowedPaths の repository-relative 検証を含む）。
  const issues = [
    ...validateRoadmapTasks([taskInput]),
    ...validateRoadmapPhases([phaseInput], [taskInput]),
  ]
  if (issues.length > 0) {
    return { ok: false, code: 'SPEC_INVALID', reason: 'Task specification failed validation', details: issues }
  }

  const syncResult = storage.tasks.syncRoadmapTasks({
    projectId: input.projectId,
    tasks: [taskInput],
    phases: [phaseInput],
  })
  if (!syncResult.ok) {
    return {
      ok: false,
      code: 'SYNC_FAILED',
      reason: syncResult.failureReason ?? 'Roadmap sync failed',
      details: { conflicts: syncResult.conflicts, phaseConflicts: syncResult.phaseConflicts },
    }
  }

  const adopted = storage.tasks
    .findByProjectId(input.projectId)
    .find((task) => task.roadmapTaskKey === taskKey)
  if (!adopted) {
    return { ok: false, code: 'SYNC_FAILED', reason: 'Task was not present after a successful sync' }
  }

  // Project が既に running の場合、continuation は「Task 完了時」にしか発火しないため、
  // 採用しただけでは初回 Implement Job が作られない。既存の ensure 経路を呼ぶ
  // （eligibility 判定は `createInitialImplementWorkflow()` 側がそのまま行う）。
  const ensure = deps.ensureInitialWorkflows ?? ensureInitialWorkflowsForActiveTasks
  await ensure(storage, input.projectId)

  return { ok: true, taskId: adopted.id, roadmapTaskKey: taskKey, title: item.title }
}
