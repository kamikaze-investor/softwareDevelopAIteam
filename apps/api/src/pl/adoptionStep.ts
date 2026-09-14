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
export function readAdoptionCandidates(
  readLedger: () => string = () => readFileSync(resolveLedgerPath(), 'utf-8'),
): RoadmapCandidate[] {
  return getValidRoadmapItems(readLedger())
    .filter((item) => item.state !== 'done')
    .map((item) => ({ id: item.id, title: item.title.replace(/\*\*/g, '').slice(0, 90), state: item.state }))
    .slice(0, PL_ADOPTION_CANDIDATE_LIMIT)
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

export const ADOPTION_SYSTEM_PROMPT = [
  'You are the Project Lead (PL). The project finished its current task and needs the next one.',
  'Choose exactly ONE item from the roadmap ledger below and specify how to execute it.',
  '',
  'Rules you cannot change:',
  '- You may only choose an id from the provided list. Anything else is refused.',
  '- Prefer items that are small, safe and independent. Avoid items that touch safety guards,',
  '  production infrastructure, secrets, or that depend on unfinished work.',
  '- allowedPaths decides where the implementer may write. Keep it as narrow as the item allows;',
  '  entries must be repository-relative and at least two path segments deep (e.g. "apps/api/src/ctoAi").',
  '- implementationScope must name exactly what is in scope, and say what is out of scope when the',
  '  ledger item contains several sub-items.',
  '- acceptanceCriteria must be mechanically checkable statements.',
  '',
  'Answer with a single JSON object and nothing else:',
  '{"roadmapId": "...", "implementationScope": "...", "allowedPaths": ["..."],',
  ' "acceptanceCriteria": ["..."], "rationale": "one sentence"}',
].join('\n')

export function buildAdoptionPrompt(candidates: readonly RoadmapCandidate[]): string {
  return [
    'Roadmap items still open (id — state — title):',
    ...candidates.map((c) => `- ${c.id} — ${c.state} — ${c.title}`),
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
  const candidates = readAdoptionCandidates(deps.readLedger)
  if (candidates.length === 0) {
    return { status: 'no_candidate', reason: 'no open roadmap item in the ledger' }
  }

  const raw = await deps.propose(ADOPTION_SYSTEM_PROMPT, buildAdoptionPrompt(candidates))
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
