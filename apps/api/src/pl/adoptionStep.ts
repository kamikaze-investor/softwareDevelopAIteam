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
import { getValidRoadmapItems } from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
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
 * 採用候補を ledger から読む。**done は候補にしない。**
 * 既存 parser をそのまま使い、新しい抽出責務を足さない。
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
    .filter((item) => item.state === 'planned')
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
export function selectAdoptionCandidates(
  all: readonly RoadmapCandidate[],
  limit: number,
  rotationOffset: number,
): RoadmapCandidate[] {
  if (all.length <= limit) return [...all]

  const high = all.filter((c) => c.highPriority)
  const rest = all.filter((c) => !c.highPriority)
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
  candidates: readonly RoadmapCandidate[],
  projectGoal?: string,
): string {
  const goalSection = projectGoal !== undefined && projectGoal.trim() !== ''
    ? ['Project goal (what all of this is for):', projectGoal.trim().slice(0, 600), '']
    : []

  return [
    ...goalSection,
    'Roadmap items still open. Read the body, not just the title:',
    ...candidates.flatMap((c) => [
      `- ${c.id} — ${c.state}${c.highPriority ? ' — PRIORITY:HIGH' : ''} — ${c.title}`,
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
  // **既に実行済みの Task を持つ項目は候補に混ぜない。**
  //
  // ledger（Candidate 側）は master の更新に対して遅れることがある。遅れている間、PL は
  // 完了済みの項目を open と見て選び、`adoptRoadmapItem()` が `ALREADY_EXECUTED` で正しく
  // 弾く — が、その却下は attempt 予算を消費する。2026-09-15 production 実測では、これを
  // 2回繰り返して予算を使い切り、**ledger を直した後も採用が再開しなくなった**。
  //
  // DB（実行済みかどうか）は ledger より新しい事実なので、候補の段階で除く。
  // **新しい state は持たない** — 既存の Task / Job を見るだけである。
  const executedKeys = new Set(
    storage.tasks.findByProjectId(projectId)
      .filter((task) => task.roadmapTaskKey !== undefined && storage.jobs.findByTaskId(task.id).length > 0)
      .map((task) => task.roadmapTaskKey as string),
  )
  const open = readAdoptionCandidates(deps.readLedger)
    .filter((candidate) => !executedKeys.has(candidate.id))
  if (open.length === 0) {
    return { status: 'no_candidate', reason: 'no open roadmap item in the ledger' }
  }

  // 回転位置は**既存 `audit_log` の採用試行回数**から取る。新しい state は持たない。
  // これにより、上限を超える planned 項目もサイクルを跨げばいずれ候補に載る。
  const rotationOffset = storage.auditLog
    .findByEntity('pl_loop_target', `adopt:${projectId}`)
    .length
  const candidates = selectAdoptionCandidates(open, PL_ADOPTION_CANDIDATE_LIMIT, rotationOffset)

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
  if (!candidates.some((candidate) => candidate.id === proposal.roadmapId)) {
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
  })

  if (!result.ok) {
    return { status: 'adoption_rejected', roadmapId: proposal.roadmapId, reason: result.reason }
  }

  return { status: 'adopted', roadmapId: proposal.roadmapId, taskId: result.taskId }
}
