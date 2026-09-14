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
  getValidRoadmapItems,
  RoadmapValidationError,
  type RoadmapItem,
} from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
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
  | 'ALREADY_EXECUTED'
  | 'SPEC_INVALID'
  | 'SYNC_FAILED'

export type AdoptRoadmapItemResult =
  | { ok: true; taskId: string; roadmapTaskKey: string; title: string }
  | { ok: false; code: AdoptRoadmapItemFailure; reason: string; details?: unknown }

export interface AdoptRoadmapItemInput {
  projectId: string
  /** `tasks/roadmap.md` の `roadmap:id`。そのまま `roadmapTaskKey` になる（追跡可能性）。 */
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

  // 同じ roadmap:id を誤って重複実行しない。既に Job が動いた Task がある場合は採用し直さない
  // （spec だけ書き換えて再実行させると、実行済みの変更と新しい指示が混ざる）。
  const existingTask = storage.tasks
    .findByProjectId(input.projectId)
    .find((task) => task.roadmapTaskKey === input.roadmapId)
  if (existingTask && storage.jobs.findByTaskId(existingTask.id).length > 0) {
    return {
      ok: false,
      code: 'ALREADY_EXECUTED',
      reason: `Roadmap item "${input.roadmapId}" already has an executed Task (${existingTask.id})`,
    }
  }

  const taskInput: RoadmapSyncTaskInput = {
    roadmapTaskKey: item.id,
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
    .find((task) => task.roadmapTaskKey === item.id)
  if (!adopted) {
    return { ok: false, code: 'SYNC_FAILED', reason: 'Task was not present after a successful sync' }
  }

  // Project が既に running の場合、continuation は「Task 完了時」にしか発火しないため、
  // 採用しただけでは初回 Implement Job が作られない。既存の ensure 経路を呼ぶ
  // （eligibility 判定は `createInitialImplementWorkflow()` 側がそのまま行う）。
  const ensure = deps.ensureInitialWorkflows ?? ensureInitialWorkflowsForActiveTasks
  await ensure(storage, input.projectId)

  return { ok: true, taskId: adopted.id, roadmapTaskKey: item.id, title: item.title }
}
