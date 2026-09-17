/**
 * PL が「次にやる Roadmap 項目」を自分で選んで採用する一歩。
 *
 * これが無いと、**Task が1つ終わるたびに外部セッションが採用 API を叩く**必要があり、
 * VPS だけで開発が続かない（本線を VPS へ移した時点で判明した最大のギャップ）。
 *
 * ## 権限の考え方
 *
 * PL が決めてよいのは「CEO 承認済み ledger のどれを次にやるか」までである。
 * **やってよいかどうかは PL が決めない。** 具体的には:
 *
 *   - 採用できるのは `tasks/roadmap.md` に**未完了で実在する**項目だけ。
 *     その事実が `strategic_alignment_review` の根拠になる（`checkRoadmapItemAlignment()`）
 *   - `allowedPaths` は PL が具体化するが、**広すぎる宣言は seam が機械的に弾く**
 *     （`assertAdoptionScopeIsBounded()`）。安全中核は allowedPaths に関係なく守られる
 *   - Design Review は迂回されない。採用操作の内側で必ず実行され、**ALIGNED でなければ
 *     implement Job は作られない**
 *   - 判定は `authorizePlAction()` を必ず通る。PL の自己申告で Gate は減らない
 *
 * ## 作っていないもの
 *
 * 新しい採用経路（既存 `adoptRoadmapItem()` を呼ぶだけ）/ 新しい Gate / 新しい承認経路 /
 * ledger への新しい metadata / PL 専用の状態表。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  getValidRoadmapItems,
  isRoadmapItemAdoptable,
} from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
import {
  getBaseRoadmapId,
  isFollowUpTaskKey,
  MAX_FOLLOW_UPS_PER_ROADMAP_ITEM,
  isLiveJob,
  occupiesProject,
} from '@ai-team/shared'
import { adoptRoadmapItem } from '../ctoAi/roadmapAdoption'
import type { IStorage } from '../storage/interface'
import {
  assertAdoptionScopeIsBounded,
  authorizePlAction,
  PlActionBlockedError,
} from './actionGate'

/** 1つの Project に対して採用を試せる回数。超えたら再試行せず CEO へ上げる。 */
export const PL_MAX_ADOPTION_ATTEMPTS = 2

/** PL へ提示する候補の上限。ledger 全件を渡すとプロンプトが膨らみ、選択がぶれる。 */
export const PL_ADOPTION_CANDIDATE_LIMIT = 40

export interface RoadmapCandidate {
  id: string
  title: string
  state: string
  /** ledger 本文の先頭。title だけでは「何の作業か」が分からないため付ける。 */
  bodyPreview: string
  /** ledger の metadata 行に `priority=high` があるか。既存表記をそのまま読む。 */
  highPriority: boolean
}

/** follow-up 候補が連続 skip されたとき、順序を繰り上げるまでの回数。 */
export const FOLLOW_UP_SKIPS_BEFORE_BOOST = 3

/** audit_log の語彙。**新しいテーブルも metrics backend も作らない。** */
const AUDIT_ENTITY_TYPE = 'roadmap_item'
export const AUDIT_FOLLOW_UP_DETECTED = 'follow_up_candidate_detected'
export const AUDIT_FOLLOW_UP_SKIPPED = 'follow_up_candidate_skipped'
export const AUDIT_FOLLOW_UP_BOOSTED = 'follow_up_candidate_boosted'
export const AUDIT_FOLLOW_UP_ADOPTED = 'follow_up_candidate_adopted'

/**
 * 1 件の open Roadmap item が、いま採用経路から見てどの状態にあるか。
 *
 * **candidate limit / priority / rotation より前に、open 全件へこれを当てる**
 * （CEO 指示 P5・B+ 方式）。後段で切り捨ててから判定すると、rotation の巡り合わせ次第で
 * follow-up 候補が永久に観測されない。
 */
export type AdoptionKind = 'fresh' | 'follow_up' | 'not_available'

export interface ClassifiedCandidate extends RoadmapCandidate {
  kind: AdoptionKind
  /** `follow_up` のとき、これまでに作られた follow-up の数。 */
  followUpCount: number
  /** この項目で**実際に実行された** Task の数。prompt はこちらを使う。 */
  executedTaskCount: number
  /** 連続 skip 回数が閾値に達し、順序だけ繰り上げた候補か。 */
  boosted: boolean
}

/**
 * open item を `fresh` / `follow_up` / `not_available` へ分類する。
 *
 * 機械的に確認するのはここまでで、「本当に残作業があるか」は判定しない。
 * それは diff と ledger 本文を読む AI の仕事であり、採用提案の中で具体的な
 * `implementationScope` として示されなければ `adoptRoadmapItem()` が拒否する。
 * **「何か残っていそう」で follow-up を作らせないための役割分担である。**
 */
export function classifyAdoptionCandidates(
  storage: IStorage,
  projectId: string,
  open: readonly RoadmapCandidate[],
): ClassifiedCandidate[] {
  const projectTasks = storage.tasks.findByProjectId(projectId)
  const pendingContinuations = storage.taskContinuations.findPendingByProjectId(projectId).length
  // 実在する ledger id を優先して base を解決する（独立レビュー Finding 2）。
  const ledgerIds = new Set(open.map((candidate) => candidate.id))
  // **採用 seam と同じ条件で見る。** seam は Project 全体の active Task を見て follow-up を拒否するので、
  // ここで Project が busy なのに候補として出すと、PL が選んだ末に FOLLOW_UP_NOT_ELIGIBLE で落ち、
  // 採用 attempt 予算だけを焼く（2026-09-15 の事故と同じ形）。検出と強制を一致させる。
  // 既存 `currentTask` と同じ意味。parked Task（pending かつ roadmapActive=false）は占有しない。
  const projectHasActiveTask = projectTasks.some((task) => occupiesProject(task))
  // parked Task にも queued Job は残りうる。Worker はそれを実行するので、動いていないとは言えない。
  const projectHasLiveJob = projectTasks.some(
    (task) => storage.jobs.findByTaskId(task.id).some((job) => isLiveJob(job)),
  )

  return open.map((candidate) => {
    const siblings = projectTasks.filter(
      (task) => task.roadmapTaskKey !== undefined
        && getBaseRoadmapId(task.roadmapTaskKey, ledgerIds) === candidate.id,
    )
    if (siblings.length === 0) {
      return { ...candidate, kind: 'fresh' as const, followUpCount: 0, executedTaskCount: 0, boosted: false }
    }

    const followUpCount = siblings.filter(
      (task) => task.roadmapTaskKey !== undefined && isFollowUpTaskKey(task.roadmapTaskKey, ledgerIds),
    ).length
    // **queued は「まだ動いていない」**。採用 seam と同じ定義を使う（独立レビュー Finding 4）。
    // 件数も数える。prompt へ「この項目で実際に何本走ったか」を伝えるため（独立レビュー NEW 3）。
    const executedCount = siblings.filter(
      (task) => storage.jobs.findByTaskId(task.id).some((job) => job.status !== 'queued'),
    ).length
    const executed = executedCount > 0
    const active = siblings.some((task) => occupiesProject(task))

    // **まだ一度も Job が走っていない Task は従来どおり `fresh` 扱いである。**
    // 採用し直すと `syncRoadmapTasks()` の isUnstarted 分岐が spec を更新するだけで、
    // 実行済みの変更と新しい指示が混ざる余地が無い。ここを follow-up 側へ倒すと、
    // 「採用したがまだ動いていない Task」を PL から見えなくしてしまう。
    if (!executed) {
      return { ...candidate, kind: 'fresh' as const, followUpCount, executedTaskCount: executedCount, boosted: false }
    }

    const eligible = !active
      && !projectHasActiveTask
      && !projectHasLiveJob
      && pendingContinuations === 0
      && followUpCount < MAX_FOLLOW_UPS_PER_ROADMAP_ITEM

    return {
      ...candidate,
      kind: eligible ? ('follow_up' as const) : ('not_available' as const),
      followUpCount,
      executedTaskCount: executedCount,
      boosted: false,
    }
  })
}

/**
 * follow-up の観測を既存 `audit_log` へ残す。**新しい metrics backend は作らない。**
 *
 * `(entity_type, entity_id, created_at DESC)` の既存 index で後から集計できる形にしてある:
 * 検出 → 初回で採用 / skip 1・2・3 → boost → boost 後に採用 / 取り残し、までを1本の系列で追える。
 */
function recordFollowUpAudit(
  storage: IStorage,
  projectId: string,
  roadmapId: string,
  operation: string,
  detail: string,
): void {
  storage.auditLog.record({
    actor: 'api',
    operation,
    entityType: AUDIT_ENTITY_TYPE,
    // **Project ごとに分ける**（独立レビュー Finding 6）。同じ roadmap id でも別 Project の
    // skip 履歴が順序へ影響してはならない。archived な Project の履歴も混ざらない。
    entityId: followUpAuditKey(projectId, roadmapId),
    result: 'success',
    detail,
  })
}

/** audit の entityId。`<projectId>/<roadmapId>`。 */
export function followUpAuditKey(projectId: string, roadmapId: string): string {
  return `${projectId}/${roadmapId}`
}

/** その候補が、直近で連続して何回 skip されたか。**時間は見ない**（CEO 指示）。 */
export function countConsecutiveSkips(
  storage: IStorage,
  projectId: string,
  roadmapId: string,
): number {
  // `findByEntity()` は **新しい順**（created_at DESC）で返す。先頭から見るのが「直近」である。
  const entries = storage.auditLog.findByEntity(AUDIT_ENTITY_TYPE, followUpAuditKey(projectId, roadmapId))
  let skips = 0
  for (const entry of entries) {
    if (entry.operation === AUDIT_FOLLOW_UP_SKIPPED) {
      skips += 1
      continue
    }
    // 検出と boost は「skip されたかどうか」を変えないので連続を途切れさせない。
    if (entry.operation === AUDIT_FOLLOW_UP_DETECTED || entry.operation === AUDIT_FOLLOW_UP_BOOSTED) continue
    // それ以外（採用された等）が現れたら、そこで連続は途切れる。
    break
  }
  return skips
}

/**
 * follow-up 候補を、通常候補より前へ出す。
 *
 * **順序だけを変える。** Gate・Class 判定・Review 要件には一切触れない
 * （CEO 指示: boost が Safety を弱めてはならない）。
 */
export function applyFollowUpBoost(
  storage: IStorage,
  projectId: string,
  candidates: readonly ClassifiedCandidate[],
): ClassifiedCandidate[] {
  const marked = candidates.map((candidate) => (
    candidate.kind === 'follow_up'
      && countConsecutiveSkips(storage, projectId, candidate.id) >= FOLLOW_UP_SKIPS_BEFORE_BOOST
      ? { ...candidate, boosted: true }
      : candidate
  ))
  const boosted = marked.filter((candidate) => candidate.boosted)
  if (boosted.length === 0) return [...marked]
  return [...boosted, ...marked.filter((candidate) => !candidate.boosted)]
}

export interface PlAdoptionProposal {
  roadmapId: string
  implementationScope: string
  allowedPaths: string[]
  acceptanceCriteria: string[]
  rationale?: string
}

export type PlAdoptionStatus =
  | 'no_candidate'
  | 'proposal_unusable'
  | 'blocked'
  | 'adopted'
  | 'adoption_rejected'

export interface PlAdoptionResult {
  status: PlAdoptionStatus
  roadmapId?: string
  taskId?: string
  reason?: string
}

/** ledger の所在。採用 API と同じ既定を使い、別経路を作らない。 */
export function resolveLedgerPath(): string {
  return path.join(process.env.TARGET_ROOT ?? '/workspace/target', 'tasks', 'roadmap.md')
}

/**
 * 採用候補を ledger から読む。**採用可能な state の項目だけを候補にする**
 * （`isRoadmapItemAdoptable()`。`deferred` / `blocked` / `done` は候補にしない）。
 * 既存 parser をそのまま使い、新しい抽出責務も新しい state も足さない。
 */
/** ledger の行分割。改行コードは環境差があるため LF で切り、行末 CR は下流で吸収する。 */
const LINE_SEPARATOR = String.fromCharCode(10)

export function readAdoptionCandidates(
  readLedger: () => string = () => readFileSync(resolveLedgerPath(), 'utf-8'),
): RoadmapCandidate[] {
  const ledger = readLedger()
  const lines = ledger.split(LINE_SEPARATOR)
  return getValidRoadmapItems(ledger)
    // **`planned` だけを候補にする。** 既存の `state=`（planned / in_progress / blocked /
    // deferred / done）をそのまま可否の正本として使う。新しい state 体系は作らない。
    //
    // 従来は `!== 'done'` だったため、`deferred`（= 現在は着手しない）も候補に入っていた。
    // 2026-09-15 実測で `deferred` が採用を止めておらず、「現在も実装禁止」を表す手段が
    // 事実上無かった。`in_progress` / `blocked` も、着手済み・停止中のものを重ねて採用する
    // 意味が無いので候補から外す。
    //
    // 判定は `isRoadmapItemAdoptable()`（parser 側の allowlist）に一本化してあり、
    // 採用 API・Gate alignment と同じ述語を共有する。ここだけ塞いでも、id 直接指定の
    // 採用と Gate 側が素通しなら `deferred` は止まらない。
    .filter((item) => isRoadmapItemAdoptable(item.state))
    .map((item) => ({
      id: item.id,
      title: item.title.replace(/\*\*/g, '').slice(0, 90),
      state: item.state,
      bodyPreview: extractBodyPreview(lines, item.checkboxLineIndex),
      // `priority=high` は ledger の metadata 行に既にある表記。parser へ責務を足さず行を直接読む。
      highPriority: (lines[item.metadataLineIndex] ?? '').includes('priority=high'),
    }))
  // **ここでは切らない。** 絞り込みは `selectAdoptionCandidates()` の責務である。
}

/**
 * checkbox 行から次の roadmap metadata 行の手前までを本文とみなし、先頭だけ返す。
 *
 * `buildAdoptedDescription()`（`ctoAi/roadmapAdoption.ts`）と**同じ切り出し方**である。
 * parser へ新しい抽出責務を足さないため、既存の行 index をそのまま使う。
 */
function extractBodyPreview(lines: readonly string[], checkboxLineIndex: number): string {
  const body: string[] = []
  for (let i = checkboxLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.includes('<!-- roadmap:id=')) break
    body.push(line)
  }
  const flattened = body.join(' ').replace(/\s+/g, ' ').trim()
  return flattened.length <= CANDIDATE_BODY_PREVIEW_CHARS
    ? flattened
    : `${flattened.slice(0, CANDIDATE_BODY_PREVIEW_CHARS)}…`
}

/**
 * 実際に PL へ提示する候補を選ぶ。
 *
 * **問題**: planned が上限（現在40）を超えると、`.slice(0, limit)` では ledger 後方の項目が
 * **一度も PL に提示されない**。2026-09-16 実測で planned 55件に対し **15件が恒久的に不可視**で、
 * その中に今回の原因項目 `adoption-does-not-check-implementation-feasibility` 自身も含まれていた。
 *
 * **単純に上限を上げない**（本文を載せるぶん prompt が膨らむため）。代わりに:
 *   1. `priority=high` は**常に載せる**（CEO が優先度を付けた意味を失わせない）
 *   2. 残り枠は**回転窓**で埋める。窓は採用サイクルごとにずれるので、
 *      **すべての planned 項目がいずれ候補になる**
 *
 * 回転位置は呼び出し側が既存 `audit_log` の採用試行回数から渡す。**新しい state は持たない。**
 */
export function selectAdoptionCandidates<T extends RoadmapCandidate & { boosted?: boolean }>(
  all: readonly T[],
  limit: number,
  rotationOffset: number,
): T[] {
  if (all.length <= limit) return [...all]

  // **boost された候補は rotation で窓から外れてはならない**（独立レビュー NEW 2）。
  // 連続 skip の末に順位を上げたのに、次の rotation で候補一覧から消えては意味がない。
  // priority と同じ「必ず載る」側へ入れ、boost 分を先頭に置く。
  const boosted = all.filter((c) => c.boosted === true)
  const high = [...boosted, ...all.filter((c) => c.highPriority && c.boosted !== true)]
  const rest = all.filter((c) => !c.highPriority && c.boosted !== true)
  const slots = Math.max(0, limit - high.length)
  if (slots === 0 || rest.length === 0) return high.slice(0, limit)

  const start = ((rotationOffset % rest.length) + rest.length) % rest.length
  const rotated = [...rest.slice(start), ...rest.slice(0, start)]
  return [...high, ...rotated.slice(0, slots)]
}

/**
 * PL の出力から採用提案を取り出す。
 *
 * **補正も推測もしない。** 足りない・型が違う場合は採用しない（fail-closed）。
 * ここで緩めると「PL が書いた文字列」と「実際に採用された範囲」がズレる。
 */
export function parseAdoptionProposal(raw: string): PlAdoptionProposal | undefined {
  const match = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!match) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? match[0])
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined

  const obj = parsed as Record<string, unknown>
  const strings = (value: unknown): string[] | undefined => (
    Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim() !== '')
      ? (value as string[])
      : undefined
  )

  const roadmapId = typeof obj.roadmapId === 'string' ? obj.roadmapId.trim() : ''
  const implementationScope = typeof obj.implementationScope === 'string' ? obj.implementationScope.trim() : ''
  const allowedPaths = strings(obj.allowedPaths)
  const acceptanceCriteria = strings(obj.acceptanceCriteria)

  if (roadmapId === '' || implementationScope === '' || !allowedPaths || !acceptanceCriteria) {
    return undefined
  }

  return {
    roadmapId,
    implementationScope,
    allowedPaths,
    acceptanceCriteria,
    ...(typeof obj.rationale === 'string' ? { rationale: obj.rationale } : {}),
  }
}

/**
 * 採用判断のために PL が知っておくべき**固定の事実**。
 *
 * 2026-09-15 の production 事故: PL は `id — state — title` しか渡されておらず、
 * `mobile-approval-role-docs — 2種類の承認の役割整理とMobile導線設計` という1行から
 * **存在しない `docs/approval-roles` を allowedPaths として創作**した。実際の正本は
 * `docs/project_memory/rules/approval_rules.md` だった。
 * **PL の能力不足ではなく、判断材料が無かった。**
 *
 * ここに置くのは「毎回変わらない小さな地図」だけである。**Repository 全体や Finding 全件を
 * prompt へ入れない**（Design Philosophy: Context 重視 / 必要な情報だけ渡す）。
 * 個々の Task の詳細は、実装時に現物を確認する側の責務とする。
 */
const ADOPTION_REPOSITORY_MAP = [
  'Where things actually live (verify against the repository before you decide):',
  '- Approval / development rules -> docs/project_memory/rules/',
  '- Decision history, operational E2E records, lessons -> docs/project_memory/decisions/',
  '- Project goal and design philosophy (synced views) -> docs/project_memory/goal.md, design_philosophy.md',
  '- Roadmap ledger (the source of truth for what is open) -> tasks/roadmap.md',
  '- PL loop, gates, state API, design review, storage -> apps/api/src/',
  '- Job execution, guards, meta review, notifier, AI CLI adapters -> apps/worker/src/',
  '- Shared types and the PL action policy -> packages/shared/src/',
  '- Mobile app -> apps/mobile/',
  '',
  'You cannot write these no matter what allowedPaths says:',
  '- apps/worker/src/guards/** (file change guard, safety auditor, alignment checker, gate policy)',
  '- apps/worker/src/jobRunner.ts, apps/worker/src/index.ts',
  '- apps/worker/src/utils/safeEnv.ts, apps/worker/src/utils/apiAuth.ts',
  '- .env and any secret material',
  'An item that needs those is not implementable here; say so in rationale and pick another item.',
].join('\n')

export const ADOPTION_SYSTEM_PROMPT = [
  'You are the Project Lead (PL). The project finished its current task and needs the next one.',
  'Choose exactly ONE item from the roadmap ledger below and specify how to execute it.',
  '',
  'Rules you cannot change:',
  '- You may only choose an id from the provided list. Anything else is refused.',
  '- **Never invent a path.** Do not derive allowedPaths from the item title. Decide it in this order:',
  '  read the item body -> recall where that kind of thing already lives (map below) ->',
  '  pick the narrowest existing directory that actually holds it -> check it is not forbidden.',
  '  If the body names a concrete file or directory, that is your answer.',
  '  A path you cannot point to in the repository is wrong, even if the name sounds right.',
  '- Prefer items that are small, safe and independent. Avoid items that touch safety guards,',
  '  production infrastructure, secrets, or that depend on unfinished work.',
  '- allowedPaths decides where the implementer may write. Keep it as narrow as the item allows;',
  '  entries must be repository-relative and at least two path segments deep (e.g. "apps/api/src/ctoAi").',
  '- **allowedPaths is not a glob.** The File Change Guard compares each changed file against',
  '  each entry as a repository-relative directory or file prefix: a file matches only when it',
  '  equals the entry or starts with the entry plus "/". Never write "*", "**", "?" or "[":',
  '  an entry containing them matches NOTHING, so the task cannot change a single file.',
  '  Write "apps/api/src/storage", never "apps/api/src/**" or "apps/api/src/*".',
  '  Name a directory or file that you have confirmed exists at that exact spelling.',
  '- implementationScope must name exactly what is in scope, and say what is out of scope when the',
  '  ledger item contains several sub-items.',
  '- acceptanceCriteria must be mechanically checkable statements.',
  '',
  '',
  ADOPTION_REPOSITORY_MAP,
  '',
  'Answer with a single JSON object and nothing else:',
  '{"roadmapId": "...", "implementationScope": "...", "allowedPaths": ["..."],',
  ' "acceptanceCriteria": ["..."], "rationale": "one sentence"}',
].join('\n')

/** 候補1件あたりに載せる本文の長さ。全文を載せると ledger 全体（20万字超）になるため切る。 */
const CANDIDATE_BODY_PREVIEW_CHARS = 200

/**
 * 採用判断用の user prompt。
 *
 * **title だけでは何の作業か分からない。** 2026-09-15 の事故では
 * `mobile-approval-role-docs — 2種類の承認の役割整理とMobile導線設計` の1行から
 * PL が存在しない path を創作した。本文の先頭を添えると「既存の承認ルール文書へ追記する話」だと
 * 読めるようになる。**全文は載せない**（planned 全件で20万字を超えるため）。
 *
 * Goal は「どの項目を選ぶか」の判断に効くので短い要約を先頭へ置く。
 * Design Philosophy 全文は載せず、採用判断に効く原則だけを system prompt 側へ固定してある。
 */
export function buildAdoptionPrompt(
  candidates: readonly (RoadmapCandidate & { kind?: AdoptionKind; executedTaskCount?: number })[],
  projectGoal?: string,
): string {
  const goalSection = projectGoal !== undefined && projectGoal.trim() !== ''
    ? ['Project goal (what all of this is for):', projectGoal.trim().slice(0, 600), '']
    : []

  return [
    ...goalSection,
    'Roadmap items still open. Read the body, not just the title:',
    ...candidates.flatMap((c) => [
      `- ${c.id} — ${c.state}${c.highPriority ? ' — PRIORITY:HIGH' : ''}${
        c.kind === 'follow_up'
          ? ` — FOLLOW-UP (${c.executedTaskCount ?? 0} task(s) already ran for this item; name ONLY work they did not do)`
          : ''
      } — ${c.title}`,
      c.bodyPreview === '' ? '  (no body)' : `  ${c.bodyPreview}`,
    ]),
  ].join('\n')
}

export interface PlAdoptionDeps {
  /** 選択と具体化。既定は PL ループと同じ provider CLI 経路。 */
  propose: (system: string, user: string) => Promise<string>
  readLedger?: () => string
  adopt?: typeof adoptRoadmapItem
}

/**
 * 次の Roadmap 項目を1件採用する。
 *
 * 呼び出し側（PL ループ）が「いま採用してよい状況か」を決め、ここは**1回の採用だけ**を行う。
 */
export async function runAdoptionStep(
  storage: IStorage,
  projectId: string,
  deps: PlAdoptionDeps,
): Promise<PlAdoptionResult> {
  // **実行済みの項目は「もう終わり」ではなく、3通りに分ける（CEO 指示 P5・B+ 方式）。**
  //
  // ledger（Candidate 側）は master の更新に対して遅れることがある。遅れている間、PL は
  // 完了済みの項目を open と見て選び、`adoptRoadmapItem()` が `ALREADY_EXECUTED` で正しく
  // 弾く — が、その却下は attempt 予算を消費する。2026-09-15 production 実測では、これを
  // 2回繰り返して予算を使い切り、**ledger を直した後も採用が再開しなくなった**。
  //
  // DB（実行済みかどうか）は ledger より新しい事実なので、候補の段階で除く。
  // **新しい state は持たない** — 既存の Task / Job を見るだけである。
  //   fresh         … 一度も採用されていない。従来どおり
  //   follow_up     … 実行済みで active Task も pending continuation も無い。残作業があれば続けられる
  //   not_available … 進行中・上限到達。ここでは出さない（既存の resume / recovery 経路が扱う）
  //
  // **分類は candidate limit / priority / rotation より前に open 全件へ当てる。**
  // 後段で切り捨ててから判定すると、rotation の巡り合わせ次第で follow-up 候補が
  // 永久に観測されない（2026-09-15 の予算枯渇と同じ「見えないまま止まる」形になる）。
  const classified = classifyAdoptionCandidates(storage, projectId, readAdoptionCandidates(deps.readLedger))
  const available = applyFollowUpBoost(storage, projectId, classified)
    .filter((candidate) => candidate.kind !== 'not_available')
  if (available.length === 0) {
    return { status: 'no_candidate', reason: 'no open roadmap item in the ledger' }
  }

  // 検出できたことを残す。選ばれたかどうかは下で別途記録する。
  for (const candidate of available) {
    if (candidate.kind !== 'follow_up') continue
    recordFollowUpAudit(storage, projectId, candidate.id, AUDIT_FOLLOW_UP_DETECTED,
      candidate.boosted ? 'detected (boosted after consecutive skips)' : 'detected')
    if (candidate.boosted) {
      recordFollowUpAudit(storage, projectId, candidate.id, AUDIT_FOLLOW_UP_BOOSTED,
        `ordered ahead after ${FOLLOW_UP_SKIPS_BEFORE_BOOST} consecutive skips`)
    }
  }

  // 回転位置は**既存 `audit_log` の採用試行回数**から取る。新しい state は持たない。
  // これにより、上限を超える planned 項目もサイクルを跨げばいずれ候補に載る。
  const rotationOffset = storage.auditLog
    .findByEntity('pl_loop_target', `adopt:${projectId}`)
    .length
  const candidates = selectAdoptionCandidates(available, PL_ADOPTION_CANDIDATE_LIMIT, rotationOffset)

  const projectGoal = storage.projects.findById(projectId)?.goal
  const raw = await deps.propose(
    ADOPTION_SYSTEM_PROMPT,
    buildAdoptionPrompt(candidates, projectGoal),
  )
  const proposal = parseAdoptionProposal(raw)
  if (!proposal) {
    return { status: 'proposal_unusable', reason: 'PL did not produce a complete adoption proposal' }
  }

  // 提示していない id を選んだ場合は、ここで落とす前に Gate でも落ちる（ledger 照合）。
  // ただし理由を分かりやすくするため先に見る。
  const chosen = candidates.find((candidate) => candidate.id === proposal.roadmapId)

  // 提示した follow-up 候補のうち、今回選ばれなかったものを skip として残す。
  // **時間ベースの boost は入れない**（CEO 指示）。数えるのは「採用機会を何回通過したか」である。
  for (const candidate of candidates) {
    if (candidate.kind !== 'follow_up' || candidate.id === proposal.roadmapId) continue
    recordFollowUpAudit(storage, projectId, candidate.id, AUDIT_FOLLOW_UP_SKIPPED,
      `not selected in this adoption opportunity (consecutive skips: ${countConsecutiveSkips(storage, projectId, candidate.id) + 1})`)
  }

  if (!chosen) {
    return {
      status: 'proposal_unusable',
      roadmapId: proposal.roadmapId,
      reason: `PL chose "${proposal.roadmapId}", which was not among the offered candidates`,
    }
  }

  // ── Mandatory Gate（唯一の許可経路）──────────────────────────
  try {
    const authorization = authorizePlAction(storage, {
      proposal: {
        kind: 'adopt_roadmap_item',
        ...(proposal.rationale !== undefined
          ? { plRiskOpinion: { level: 'PL_SELECTION', rationale: proposal.rationale } }
          : {}),
      },
      target: { kind: 'project', projectId },
      evidence: [{ gate: 'strategic_alignment_review', roadmapItemId: proposal.roadmapId }],
    })
    // 宣言されたスコープが広すぎないかは Gate 通過後にも必ず見る。
    assertAdoptionScopeIsBounded(authorization.decision, proposal.allowedPaths)
  } catch (error: unknown) {
    if (error instanceof PlActionBlockedError) {
      return { status: 'blocked', roadmapId: proposal.roadmapId, reason: error.message }
    }
    throw error
  }

  // ── Execute（既存の採用経路をそのまま呼ぶ）────────────────────
  const adopt = deps.adopt ?? adoptRoadmapItem
  const result = await adopt(storage, {
    projectId,
    roadmapId: proposal.roadmapId,
    allowedPaths: proposal.allowedPaths,
    acceptanceCriteria: proposal.acceptanceCriteria,
    implementationScope: proposal.implementationScope,
    // 実行済み項目なら follow-up として採用する。**成立条件は adoptRoadmapItem() が機械判定する**
    // （ここで true を渡しても、前提を満たさなければ FOLLOW_UP_NOT_ELIGIBLE で落ちる）。
    ...(chosen.kind === 'follow_up' ? { followUp: true } : {}),
  })

  if (!result.ok) {
    return { status: 'adoption_rejected', roadmapId: proposal.roadmapId, reason: result.reason }
  }

  // **採用できたら連続 skip を切る**（独立レビュー Finding 6）。
  // これを書かないと、間に採用が挟まっても次の候補が boost されたままになる。
  if (chosen.kind === 'follow_up') {
    recordFollowUpAudit(storage, projectId, proposal.roadmapId, AUDIT_FOLLOW_UP_ADOPTED,
      `adopted as task ${result.taskId}`)
  }

  return { status: 'adopted', roadmapId: proposal.roadmapId, taskId: result.taskId }
}
