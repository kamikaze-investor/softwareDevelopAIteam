/**
 * Independent Remediation — Design Review が CONFLICT を返して止まった採用を、
 * **元の提案者ではなく独立した flagship AI** に作り直させる一歩。
 *
 * ## なぜ必要か（production 実測）
 *
 * 2026-09-15、PL が `task-allowed-paths-not-normalized` を自律採用した直後、task-kind の
 * Design Review が `finalDecision: CONFLICT` を返して implement Job が作られず、連続自律開発が
 * 2件目で止まった（ledger: `adopted-item-blocked-by-stale-deferral-text`）。CONFLICT の根拠は
 * 2つあり、うち `scope_simplicity`（より軽い代替がある）は ledger 本文を直しても残る。
 *
 * 同項目が明記しているとおり、**ledger 本文を書き換えて CONFLICT を消すのは
 * 「Binding Review の入力を外から操作して判定を覆す」ことに等しい**。そこで採るのは逆の道で、
 * 判定は動かさず**提案の側を作り直して、もう一度まっさらな Review に掛ける**。
 *
 * ## 何を作っていないか
 *
 * 新しい Review engine / Gate / TaskStatus / Roadmap state / provider stack /
 * recovery subsystem は作らない。使うのは全部既存である:
 *
 *   - 許可 … `authorizeAdoptionScope()`（= `authorizePlAction('adopt_roadmap_item')` +
 *     `assertAdoptionScopeIsBounded()`）。**新しい action kind を作らない**
 *   - Task 更新 … `adoptRoadmapItem()`。Job が0件かつ pending の Task は
 *     `syncRoadmapTasks()` の isUnstarted 分岐で spec が更新される（既存挙動）
 *   - fresh Review … `ensureInitialWorkflowsForActiveTasks()` →
 *     `createInitialImplementWorkflow()` → `createAndExecuteDesignReview()`
 *   - model 実行 … 既存 `createAiCliAdapter()`（`remediationRunner.ts` 経由）と
 *     既存 `executeRunner()` spawn
 *   - vendor 分離 … `reviewSeparation.ts`
 *   - 記録 … 既存 `audit_log`
 *
 * ## 権限の境界
 *
 * **Remediation AI は Review 結果を解除・承認できない。** 返すのは提案だけで、判定は
 * 従来どおり API 側の `recomputeDecision()` が再計算する。PL も Binding Review を
 * override できない（`PL_BLOCKED_RESPONSES` に override は無い）。
 * ここが行うのは `PL_BLOCKED_RESPONSES` のうち `fix` / `propose_alternative` を
 * **独立した AI に代行させる**ことであって、権限の追加ではない。
 *
 * ## 却下済みテキストの再審査を防ぐ（重要）
 *
 * `checkImplementJobDesignReviewEvidence()` は `design_review_runs` を見ない。CONFLICT の run は
 * evidence 行を作らないので、Job Gate は `MISSING_DESIGN_REVIEW_EVIDENCE` で落ちる —— つまり
 * **「prompt が変わったから fresh Review になる」のではない。** hash 束縛が防ぐのは
 * 「Review 後に prompt を書き換えて実行すること」であって、**同一テキストの再審査は防げない**。
 *
 * この repo では同一入力に対する Review 判定が実行ごとに反転することが実測されている
 * （ledger: `independent-review-verdict-instability`。critical な Authority 指摘が再実行で消えた）。
 * したがって却下済みテキストをそのまま再提出できる設計は、**判定の揺れを使って CONFLICT を
 * 洗浄する経路**になる。そこで**却下済みのどの案ともレビュー対象が同じ提案**は
 * **Review を走らせる前に拒否する**（`repairPolicy` の `requireDifferentApproach` と同じ趣旨）。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Task } from '@ai-team/shared'
import {
  buildDesignContract,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import {
  extractDesignReviewFindings,
  parseRemediationProposal,
  selectRemediationModel,
  type DesignReviewFinding,
  type RemediationProposal,
  isMateriallyDifferentSpec,
  reviewVisibleSpecKey,
  type RemediationSpec,
} from '@ai-team/shared'
import { getValidRoadmapItems } from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
import { classifyReviewLoad } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { mapFileToFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
import {
  executeRunner,
  recomputeDecision,
  type CoordinatorDeps,
  type RawStrategicResult,
  type RunnerExecution,
} from '../designReview/designReviewCoordinator'
import { CHEAP_AI_CONFIG } from '../aiExplain/cheapAiClient'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'
import {
  adoptRoadmapItem,
  buildAdoptedDescription,
  extractImplementationScope,
  extractItemDescription,
} from '../ctoAi/roadmapAdoption'
import type { IStorage } from '../storage/interface'
import { ADOPTION_REPOSITORY_MAP, authorizeAdoptionScope, resolveLedgerPath } from './adoptionStep'

/**
 * 1つの却下テキストに対して Remediation を試せる回数。
 *
 * 有界にするための材料は既存 `audit_log` だけである（新しいテーブルは持たない）。
 * **PL の attention 予算とは別に数える。** attention のキー（`task_ready_without_job:<taskId>`）は
 * Task の生涯で変わらないので、そこへ相乗りすると「一度 Escalation した Task は
 * 二度と Remediation されない」ことになり、既に止まっている本番 Task が対象外になる。
 */
export const PL_MAX_REMEDIATION_ATTEMPTS = 2

/** audit_log の語彙。**新しいテーブルも metrics backend も作らない。** */
const AUDIT_ENTITY_TYPE = 'pl_remediation'
const AUDIT_OPERATION = 'pl_independent_remediation'

/**
 * 却下された提案を書いた側（PL）の provider / model。
 *
 * **識別子を複製せず `cheapAiClient` の設定をそのまま参照する。** 複製すると PL の model を
 * 替えたときに、ここだけ古い値で「分離した」と言い続けることになる。
 *
 * ## 何を強制でき、何を強制できないか（正直に分ける）
 *
 * - **model 単位の分離は強制できる。** `authorModels` に PL の model を渡すので、
 *   候補がそれと同一なら採用されない。「元の設計者へ解決案生成を戻さない」という要求の核は
 *   これであり、vendor 解決の成否に依存しない
 * - **vendor 単位の分離は PL については確認できない。** `opencode-go` は harness であり、
 *   `reviewSeparation.ts` の `PROVIDER_VENDOR` に**意図的に載っていない**。
 *   同モジュールは「識別子ではなく実際の underlying model/vendor を渡せる設計にしてから
 *   分離判定へ参加させること」と明記しているため、**ここで識別子を vendor 表へ登録して
 *   分離を主張してはならない**。よって `unverified_separation=` として記録するだけにする
 *
 * fail-closed（vendor 未解決なら Remediation しない）を選ばない理由: PL の provider が
 * harness である限り恒久的に解決しないため、それは「機構を作らない」のと同じ結果になり、
 * CONFLICT の行き止まりが現状のまま残る。**構造的に充足不能な要求を Gate にしない**
 * （`adopt_roadmap_item` の up-front `design_review` を外したのと同じ判断）。
 *
 * **実装者（`task.provider`）は author に含めない。** その provider はまだ1度も実行されて
 * おらず、却下された設計テキストを書いていない。含めると critical load のときに
 * 「実装者 vendor と judge vendor の両方を除外して候補が尽きる」構造的不能に陥る。
 */
const PL_PROPOSAL_AUTHOR_PROVIDER = CHEAP_AI_CONFIG.provider
const PL_PROPOSAL_AUTHOR_MODEL = CHEAP_AI_CONFIG.model

/**
 * これまでに Remediation を書いた provider。**2回目以降の自己修正を防ぐ。**
 *
 * 1回目の著者（PL）は vendor を解決できないが、**2回目の著者は必ず解決できる**
 * （候補表の provider は `PROVIDER_VENDOR` に載っているものだけ）。ここを author へ含めないと、
 * 1回目に Codex が書いて却下された提案を **2回目も Codex が書き直す**ことになり、
 * 「元設計者へ解決案生成を戻さない」という本経路の前提そのものが崩れる（独立レビュー指摘）。
 *
 * 材料は自前の audit 行の provenance だけである（新しいテーブルは作らない）。
 */
function priorRemediationProviders(storage: IStorage, taskId: string): string[] {
  return priorProvidersForStage(storage, taskId, 'remediation')
}

/**
 * Critic として使った provider / model。
 *
 * **Critic 行と Remediation 行を混同してはならない。** どちらも同じ audit entity
 * （`pl_remediation` / `remediate:<taskId>`）へ載るので、`stage=` で区別する。
 * 混同すると Critic 経験者が「Task Design author」として **hard 除外**されてしまい、
 * CEO が Preference と決めたものが Safety Constraint に化ける（2026-09-18）。
 *
 * Critic は Task Spec を書かないので、Critic 経験は author 独立性を侵さない。
 */
export function priorCriticProviders(storage: IStorage, taskId: string): string[] {
  return priorProvidersForStage(storage, taskId, 'critic')
}

export function priorCriticModels(storage: IStorage, taskId: string): string[] {
  const models: string[] = []
  for (const entry of stageEntries(storage, taskId, 'critic')) {
    const model = /\bmodel=([\w.-]+)/.exec(entry.detail ?? '')?.[1]
    if (model !== undefined && !models.includes(model)) models.push(model)
  }
  return models
}

export function stageEntries(
  storage: IStorage,
  taskId: string,
  stage: 'critic' | 'remediation' | 'challenge' | 'pl_revision',
): { detail?: string }[] {
  return storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, remediationKey(taskId))
    .filter((entry) => {
      const recorded = /\bstage=(\w+)/.exec(entry.detail ?? '')?.[1]
      // `stage=` の無い行は Remediation として扱う（staging 導入前に書かれた形）。
      return recorded === undefined ? stage === 'remediation' : recorded === stage
    })
}

function priorProvidersForStage(
  storage: IStorage,
  taskId: string,
  stage: 'critic' | 'remediation' | 'challenge' | 'pl_revision',
): string[] {
  const providers: string[] = []
  for (const entry of stageEntries(storage, taskId, stage)) {
    const provider = /\bprovider=([\w-]+)/.exec(entry.detail ?? '')?.[1]
    if (provider !== undefined && !providers.includes(provider)) providers.push(provider)
  }
  return providers
}

/**
 * fresh Design Review でこの提案を**判定することになる** provider。
 *
 * ここを除外しないと Remediation AI が自分の提案を自分で審査する構成になりうる。
 * 判定は既存の分類器から導く（値をここに固定しない）。
 */
function resolveJudgeProviders(changedFiles: readonly string[]): string[] {
  // focused review は Gemini 経路（`strategicReview` の既存 topology）。
  const judges = ['gemini']
  // critical load のときだけ Codex independent review が必須になる（`recomputeDecision()`）。
  if (classifyReviewLoad({ changedFiles: [...changedFiles] }).reviewLoad === 'critical') {
    judges.push('codex')
  }
  return judges
}

export type PlRemediationStatus =
  /** CONFLICT で止まった採用ではない（対象外）。 */
  | 'not_applicable'
  /** 試行上限に達した。呼び出し側は既存 Escalation へ渡す。 */
  | 'attempts_exhausted'
  /** 独立した flagship が居ない。呼び出し側は既存 Escalation へ渡す。 */
  | 'no_independent_model'
  /** model 実行が失敗した（弱い model へは落ちない）。 */
  | 'remediation_failed'
  /** 応答が構造化された提案にならなかった。 */
  | 'proposal_unusable'
  /** 却下済みテキストと実質同一の提案だった。Review を走らせずに拒否した。 */
  | 'proposal_not_materially_different'
  /** Remediation AI が「この項目は現状のまま実装すべきでない」と結論した。 */
  | 'abandon_recommended'
  /** Gate に止められた。 */
  | 'blocked'
  /** 採用し直しが既存経路に拒否された。 */
  | 'adoption_rejected'
  /** 採用し直したが fresh Review が通らず Job が作られなかった。 */
  | 'still_not_aligned'
  /** fresh Review が通り implement Job が作られた。 */
  | 'remediated'

export interface PlRemediationResult {
  status: PlRemediationStatus
  taskId?: string
  roadmapId?: string
  reason?: string
  /** 機械判定用の下位分類。`reason` は人が読む散文なので分類に使わない。 */
  failureCode?: string
  /** 使った provider / model（provenance）。 */
  provider?: string
  model?: string
  /** 提案の要点。CEO へ渡す Escalation 本文に添える。 */
  proposal?: RemediationProposal
}

/** CONFLICT で止まっていると判定するための材料。read-only。 */
export interface RemediationSubject {
  task: Task
  roadmapId: string
  /** 却下された Design Review の Finding。 */
  findings: readonly DesignReviewFinding[]
  /** 却下された提案の review-visible key（全世代ぶん）。 */
  rejectedSpecKeys: readonly string[]
  /**
   * CONFLICT を受けた**そのままの design text** と hash。
   *
   * `stage=challenge` は spec を変更せず、この text を **byte-identical** で再評価に掛ける。
   * 保持しているのは、Task の description から再構成すると採用後の変更で揺れるためである。
   */
  reviewedDesignText: string
  reviewedDesignTextHash: string
  /**
   * 元 run の `changedFiles`。**再評価でも同じものを渡す。**
   *
   * ここを `[]` に固定すると `classifyReviewLoad()` が critical から medium へ下がり、
   * **必須だった Independent Review が省かれる**（独立レビュー指摘）。再評価は
   * 「同じ入力での判定」でなければならず、レビュー負荷も同じでなければならない。
   */
  reviewedChangedFiles: readonly string[]
}

/**
 * その Task が Independent Remediation の対象かを、**永続レコードだけ**から判定する。
 *
 * 対象にする条件（すべて必要）:
 *   1. Roadmap 項目から採用された Task である（`roadmapTaskKey` がある）
 *   2. Job が1件も無い（実行済みの変更と新しい指示が混ざらない）
 *   3. status が `pending`（`syncRoadmapTasks()` が spec を更新できる状態）
 *   4. 最新の Design Review run が**終端していて**、判定が CONFLICT である
 *
 * 4 で run の status を見るのが重要である。`queued` / `running` は Review がまだ動いている
 * だけなので待つ（採用直後に必ず通る状態）。`failed` は provider 障害側の問題で、
 * 既存 `design_review_failed` attention と `review-provider-exhausted-alternate-rereview` の
 * 担当であり、**Remediation の対象ではない**（提案を作り直しても直らない）。
 *
 * **`CONFLICT` だけを対象にする。`UNCERTAIN` / `REVIEW_UNAVAILABLE` は対象にしない。**
 * `executeDesignReviewRun()` は非 ALIGNED の判定をすべて `status='succeeded'` として保存するため、
 * 「succeeded かつ evidence 無し」だけでは3者を区別できない（独立レビュー指摘）。
 * `UNCERTAIN` は `recomputeDecision()` の**構造検証による fail-closed** でも出る
 * （focus 集合の不一致・未知の decision 値・critical なのに independent review が無い等）。
 * それは設計への異議ではなく契約違反・インフラ側の問題であり、提案を書き直しても答えようがない。
 * fail-closed な不確実性を提案の書き直しへ流し込まない。
 */
export function findRemediationSubject(
  storage: IStorage,
  taskId: string,
): RemediationSubject | undefined {
  const task = storage.tasks.findById(taskId)
  if (!task || task.roadmapTaskKey === undefined) return undefined
  if (task.status !== 'pending') return undefined
  if (storage.jobs.findByTaskId(task.id).length > 0) return undefined

  const run = storage.designReviewRuns.findLatestByTaskId(task.id)
  if (!run || run.reviewKind !== 'task') return undefined
  // 走っている途中・回収待ちは対象にしない（採用直後に必ず通る状態）。
  if (run.status !== 'succeeded') return undefined

  // evidence が登録されていれば ALIGNED である（非 ALIGNED は evidence を作らない）。
  const evidence = storage.designReviewEvidence.findLatestByTaskId(task.id)
  if (evidence?.designTextHash === run.designTextHash) return undefined

  // **判定は runner の自己申告（`finalDecision`）を採用せず、API と同じ関数で再計算する。**
  // Job Gate / evidence 登録が使っているのと同一の `recomputeDecision()` を通すので、
  // ここが独自の判定ロジックを持つことはない。
  if (run.resultJson === undefined) return undefined
  let raw: RawStrategicResult
  try {
    raw = JSON.parse(run.resultJson) as RawStrategicResult
  } catch {
    // 判定を再計算できないものを CONFLICT と決めつけない（fail-closed）。
    return undefined
  }
  if (recomputeDecision(raw, 'task', run.changedFiles).decision !== 'CONFLICT') return undefined

  return {
    task,
    roadmapId: task.roadmapTaskKey,
    findings: extractDesignReviewFindings(run.resultJson),
    reviewedDesignText: run.designText,
    reviewedDesignTextHash: run.designTextHash,
    reviewedChangedFiles: run.changedFiles,
    rejectedSpecKeys: collectRejectedSpecKeys(storage, task),
  }
}

/**
 * これまでに却下された提案の **review-visible key** を全件集める。
 *
 * **1世代前だけでは足りない。** A → B → A の巡回で A を再提出できてしまうため、
 * 却下済み全件と比べる（独立レビュー指摘）。
 *
 * 材料は3つで、いずれも既存レコードである:
 *   1. 現在の Task の spec … 直前に却下された案（初回は PL の案）
 *   2. audit の `fspec=` … 過去世代で**提案した**案
 *   3. audit の `rejected_fspec=` … 過去世代で**却下されていた**案
 *
 * **3 が無いと A → B → A を止められない。** 採用は Task の scope を提案内容へ
 * 置き換えるため、世代1で却下されていた A は、世代2の時点では Task 上にもう存在しない。
 * 2 だけでは集合が {B, B+記録} になり A が抜けるので、B → A を通してしまう（独立レビュー指摘）。
 * そこで**却下された側のキーも試行ごとに残す**。
 *
 * `design_review_runs` は Task ごとに最新1件しか引けないので、世代の履歴は audit で復元する。
 * **新しいテーブルは作らない。**
 */
export function collectRejectedSpecKeys(storage: IStorage, task: Task): string[] {
  const keys = new Set<string>([
    shortSpecKey({
      implementationScope: extractImplementationScope(task.description) ?? '',
      allowedPaths: task.allowedPaths ?? [],
    }),
  ])
  for (const entry of storage.auditLog.findByEntity(AUDIT_ENTITY_TYPE, remediationKey(task.id))) {
    for (const match of (entry.detail ?? '').matchAll(/\b(?:fspec|rejected_fspec)=(\S+)/g)) {
      if (match[1] !== undefined && match[1] !== '-') keys.add(match[1])
    }
  }
  return [...keys]
}

/**
 * audit へ載せるための短縮キー。
 *
 * `reviewVisibleSpecKey()` の生値は長く、`audit_log.detail` の 500 字上限に収まらない。
 * 照合に使うのは同一性だけなので hash で足りる。**判定ロジックは共有の pure 関数側に置き、
 * ここでは短縮だけを行う**（2箇所に判定を書かない）。
 */
export function shortSpecKey(spec: { implementationScope: string; allowedPaths: readonly string[] }): string {
  return computeDesignTextHash(reviewVisibleSpecKey(spec)).slice(0, 16)
}

function remediationKey(taskId: string): string {
  return `remediate:${taskId}`
}

/**
 * Independent Remediation の試行回数。
 *
 * **`stage=remediation` の行だけを数える。** Critic / Challenge は同じ audit entity へ載るので、
 * 全行を数えると **Critic Round が Remediation の予算を食い潰す** —— 実際にそうなっていて、
 * Critic を2 Round 行った時点で Remediation へ到達できなくなっていた（テストで検出）。
 * stage ごとに予算が独立していることが、段階フローの前提である。
 */
export function countRemediationAttempts(storage: IStorage, taskId: string): number {
  return stageEntries(storage, taskId, 'remediation').length
}

/**
 * Independent Remediation の予算が残っているか。
 *
 * **判定はここ1箇所だけに置く。** 予算を見る側が増えるたびに
 * `count... >= PL_MAX_...` を書き写すと、片方だけ直したときに
 * **「戻せば Remediation が動く」と案内しておきながら endpoint は動かない**という
 * 食い違いが起きる（独立レビュー round 4 指摘）。
 * いまの呼び出し元は Human Recovery の `nextDriver` 判定と `triageBlocked()` の CEO 案内。
 */
export function hasRemediationBudgetLeft(storage: IStorage, taskId: string): boolean {
  return countRemediationAttempts(storage, taskId) < PL_MAX_REMEDIATION_ATTEMPTS
}

/**
 * stage を問わない解決試行の総数。
 *
 * 用途は1つだけで、**呼び出し側が「この呼び出しで step が既に何か記録したか」を判定する**ため。
 * 予算の判定には使わない（予算は stage ごとに別である）。
 */
export function countConflictAttempts(storage: IStorage, taskId: string): number {
  return storage.auditLog
    .findByEntity(AUDIT_ENTITY_TYPE, remediationKey(taskId))
    .filter((entry) => entry.operation === AUDIT_OPERATION)
    .length
}

/**
 * 呼び出し側（PL ループ）が、Remediation の手前で落ちた試行を数えさせるための入口。
 *
 * **記録の場所を2つに分けない。** 予算は `countRemediationAttempts()` が1箇所で数えるので、
 * 外から数えさせたい失敗もこの entity へ書く。
 */
export function recordRemediationFailure(storage: IStorage, taskId: string, detail: string): void {
  recordRemediation(storage, taskId, detail)
}

function recordRemediation(storage: IStorage, taskId: string, detail: string): void {
  storage.auditLog.record({
    actor: 'api',
    operation: AUDIT_OPERATION,
    entityType: AUDIT_ENTITY_TYPE,
    entityId: remediationKey(taskId),
    result: 'success',
    // 秘密情報・提案本文は載せない。provenance と hash だけを残す。
    detail: detail.slice(0, 500),
  })
}

// ────────────────────────────────────────────────────────────
// Prompt
// ────────────────────────────────────────────────────────────

export const REMEDIATION_SYSTEM_PROMPT = [
  'You are an INDEPENDENT remediation engineer. A change proposal was stopped by a binding',
  'Design Review with decision CONFLICT. You did not write the rejected proposal and you are not',
  'defending it. Your job is to read the Review findings and the repository, and decide what should',
  'actually be done.',
  '',
  'What you are NOT allowed to do:',
  '- You cannot approve, clear, soften or overrule the Review. Your output is a proposal only;',
  '  it will be judged by a completely fresh Design Review that you do not control.',
  '- You cannot widen Safety or Authority boundaries. Anything that expands what the AI may do,',
  '  weakens a Guard/Gate/Approval requirement, or removes a CEO approval requirement is out of',
  '  bounds: say so in safetyImpact and prefer an alternative that stays inside current limits.',
  '- You cannot edit the roadmap ledger or the review findings. Changing the reviewer\'s input to',
  '  make the finding disappear is forbidden; change the proposal instead.',
  '',
  'You are free to reach ANY of these conclusions - do not assume the original plan must survive:',
  '- correct the original plan (narrower scope, corrected paths)',
  '- a strictly smaller alternative that satisfies the same intent',
  '- a different approach that reuses an existing mechanism instead of building a new one',
  '- an approach that avoids expanding permissions',
  '- abandon the original plan entirely (set "abandon": true). Choose this when the item should not',
  '  be implemented as written. Do NOT invent a narrow fake scope just to get past the Review.',
  '',
  'Rules you cannot change:',
  '- **Never invent a path.** Verify every allowedPaths entry against the repository you can read.',
  '  A path you cannot point to is wrong even if the name sounds right.',
  '- allowedPaths decides where the implementer may write. Keep it as narrow as the work allows;',
  '  entries must be repository-relative and at least two path segments deep.',
  '- implementationScope must name exactly what is in scope and what is out of scope.',
  '- acceptanceCriteria must be mechanically checkable statements.',
  '- Your proposal must be MATERIALLY DIFFERENT from the rejected one. A restatement of the same',
  '  scope and paths will be refused before it reaches the Review, and the attempt is wasted.',
  '- Every finding below must be addressed in whyResolved, or explicitly listed in',
  '  unresolvedConcerns. Do not silently drop one.',
  '',
  ADOPTION_REPOSITORY_MAP,
  '',
  'Answer with a single JSON object and nothing else:',
  '{"diagnosis": "why the review rejected this, in your own reading",',
  ' "resolution": "what should be done instead",',
  ' "implementationScope": "...", "allowedPaths": ["..."], "acceptanceCriteria": ["..."],',
  ' "whyResolved": "how this answers each finding",',
  ' "safetyImpact": "effect on Safety / Authority boundaries, or why there is none",',
  ' "unresolvedConcerns": ["..."], "abandon": false}',
].join('\n')

function formatFindings(findings: readonly DesignReviewFinding[]): string[] {
  if (findings.length === 0) {
    return ['(the run recorded no machine-readable finding; treat the whole proposal as unverified)']
  }
  return findings.flatMap((finding) => [
    `- [${finding.source}] ${finding.decision}${finding.summary ? `: ${finding.summary}` : ''}`,
    ...finding.messages.map((message) => `    - ${message}`),
  ])
}

/** 候補1件あたりに載せる ledger 本文の長さ。全文は載せない（ledger は20万字を超える）。 */
const LEDGER_BODY_CHARS = 4_000

export function buildRemediationPrompt(input: {
  projectGoal?: string
  subject: RemediationSubject
  ledgerBody: string
}): string {
  const { subject } = input
  const currentScope = extractImplementationScope(subject.task.description)

  return [
    ...(input.projectGoal !== undefined && input.projectGoal.trim() !== ''
      ? ['Project goal (what all of this is for):', input.projectGoal.trim().slice(0, 600), '']
      : []),
    'The binding Design Review findings you must answer:',
    ...formatFindings(subject.findings),
    '',
    `Roadmap item (the CEO-approved source of truth): ${subject.roadmapId}`,
    input.ledgerBody.slice(0, LEDGER_BODY_CHARS),
    '',
    'The rejected proposal:',
    `- implementationScope: ${currentScope ?? '(none was specified)'}`,
    `- allowedPaths: ${JSON.stringify(subject.task.allowedPaths)}`,
    `- acceptanceCriteria: ${JSON.stringify(subject.task.acceptanceCriteria)}`,
    '',
    buildRemediationDesignContract(subject.task.allowedPaths ?? []),
  ].join('\n')
}

/**
 * Remediation AI へ渡す Design Contract。
 *
 * **実装 prompt と同じ関数から作る**（`buildInitialImplementAiCliPrompt()` と同じ
 * `selectPrincipleSlugs` + `buildDesignContract`）。別に組み立てると、Remediation が
 * 従う原則と実装側が従う原則がずれる。
 */
function buildRemediationDesignContract(allowedPaths: readonly string[]): string {
  const principles = loadEngineeringPrinciples()
  return buildDesignContract({
    slugs: selectPrincipleSlugs(
      { predictedFocuses: [...allowedPaths].flatMap(mapFileToFocuses) },
      principles,
    ),
    principles,
  })
}

// ────────────────────────────────────────────────────────────
// Execution
// ────────────────────────────────────────────────────────────

export interface PlRemediationDeps {
  /** runner 起動設定。既定は Design Review と同じ形（新しい Queue / Daemon は作らない）。 */
  runnerDeps?: CoordinatorDeps
  /** ledger の読み取り（テスト差し替え用）。 */
  readLedger?: () => string
  /** 採用の実行（テスト差し替え用）。既定は既存 `adoptRoadmapItem`。 */
  adopt?: typeof adoptRoadmapItem
}

/** Remediation runner の既定起動設定。`buildDefaultRoadmapGeneratorDeps()` と同じ形。 */
export function buildDefaultRemediationDeps(): CoordinatorDeps {
  const repoRoot = process.env.DESIGN_REVIEW_REPO_ROOT ?? path.resolve(process.cwd(), '../..')

  return {
    runnerCommand: process.env.DESIGN_REVIEW_RUNNER_COMMAND ?? 'npx',
    runnerArgs: [
      ...(process.env.DESIGN_REVIEW_RUNNER_COMMAND ? [] : ['tsx']),
      path.join(repoRoot, 'apps', 'worker', 'scripts', 'remediationRunner.ts'),
    ],
    homeDirectory: process.env.HOME ?? process.env.USERPROFILE ?? repoRoot,
    workingDir: repoRoot,
  }
}

/**
 * **実際に submit される** implement prompt の hash。
 *
 * Job Gate が計算するのと同じ値（`computeDesignTextHash(job.aiCliPrompt)`）になるよう、
 * `buildRemediatedScope()` を通した scope から計算する。ここを生の
 * `proposal.implementationScope` から計算すると、**採用時に submit されるテキストと
 * 別の値**になり、記録した hash が後の世代で1つも照合できなくなる（独立レビュー指摘）。
 *
 * この hash は provenance と世代間の蓄積に使う。**「提案が変わったか」の判定には使わない** ——
 * 判断記録の追記で必ず変わるので、判定には使えない（`isMateriallyDifferentSpec()` を使う）。
 */
export function computeProposedDesignTextHash(input: {
  ledgerBody: string
  implementationScope: string
  allowedPaths: string[]
}): string {
  return computeDesignTextHash(
    buildInitialImplementAiCliPrompt({
      description: buildAdoptedDescription(input.ledgerBody, input.implementationScope),
      allowedPaths: input.allowedPaths,
    }),
  )
}

/**
 * CONFLICT で止まった1件を Remediation する。
 *
 * 呼び出し側（PL ループ）が「いま実行してよい状況か」を決め、ここは**1回の Remediation だけ**を行う。
 */
export async function runRemediationStep(
  storage: IStorage,
  taskId: string,
  deps: PlRemediationDeps = {},
): Promise<PlRemediationResult> {
  const subject = findRemediationSubject(storage, taskId)
  if (!subject) {
    return { status: 'not_applicable', taskId, reason: 'task is not stopped by a design review CONFLICT' }
  }

  const attempts = countRemediationAttempts(storage, taskId)
  if (attempts >= PL_MAX_REMEDIATION_ATTEMPTS) {
    return {
      status: 'attempts_exhausted',
      taskId,
      roadmapId: subject.roadmapId,
      failureCode: 'attempts_exhausted',
      reason: `independent remediation already ran ${attempts} time(s) for this task`,
    }
  }

  // ── ledger 本文（Source of Truth）────────────────────────────
  let ledgerBody: string
  try {
    const markdown = (deps.readLedger ?? (() => readFileSync(resolveLedgerPath(), 'utf-8')))()
    const item = getValidRoadmapItems(markdown).find((candidate) => candidate.id === subject.roadmapId)
    if (!item) {
      // ledger が直るまで結果は変わらない。記録して有界にする（下の catch と同じ理由）。
      recordRemediation(storage, taskId, 'outcome=item_not_in_ledger')
      return {
        status: 'not_applicable',
        taskId,
        roadmapId: subject.roadmapId,
        failureCode: 'item_not_in_ledger',
        reason: `roadmap item "${subject.roadmapId}" is no longer in the ledger`,
      }
    }
    ledgerBody = extractItemDescription(markdown, item)
  } catch (error: unknown) {
    // **model を呼ぶ前の失敗でも試行として記録する。**
    // 記録しないと `countRemediationAttempts()` が 0 のままで対象から外れず、
    // ledger が読めない間ずっと毎 tick 同じ Escalation を出し続ける
    // （2026-09-17 に「63分で同一内容の LINE が18通」として実測された形と同じ）。
    recordRemediation(storage, taskId, 'outcome=ledger_unreadable')
    return {
      status: 'not_applicable',
      taskId,
      roadmapId: subject.roadmapId,
      failureCode: 'ledger_unreadable',
      reason: `roadmap ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  // ── 独立した flagship を選ぶ（弱い model へは落ちない）──────────
  //
  // **Safety Constraint と Preference を分ける**（CEO 指示 2026-09-18）。
  // hard なのは author / judge との分離だけで、chain 使用済み・Critic 使用済みは
  // 順位付けにしか使わない。**diversity 不足で PL loop を止めない。**
  const priorProviders = priorRemediationProviders(storage, taskId)
  const selection = selectRemediationModel({
    // 1回目は PL（vendor 未解決）、2回目以降は前回の Remediation 著者も除外対象になる。
    // **Remediation 著者は Task Design を書いた側**なので、ここは hard 側で正しい。
    authorProviders: [PL_PROPOSAL_AUTHOR_PROVIDER, ...priorProviders],
    // **vendor が解決できない相手にも、model 単位の分離は必ず効かせる。**
    authorModels: [PL_PROPOSAL_AUTHOR_MODEL],
    // 初回 implement Job の Design Review は常に `changedFiles: []` で走る
    // （`createInitialImplementWorkflow()`）。値を固定せず既存分類器から導く。
    judgeProviders: resolveJudgeProviders([]),
    // Preference: この chain で既に使った provider は順位を下げるだけ。
    usedProviders: priorProviders,
    // Preference: Critic 経験者は最下位。ただし **Critic は Task Spec を書かない**ので
    // 除外はしない（Critic と Remediator が同一 model でも許可される）。
    criticProviders: priorCriticProviders(storage, taskId),
  })
  if (!selection.ok) {
    // provider 構成が変わるまで結果は変わらないので、ここも試行として記録して有界にする。
    recordRemediation(storage, taskId, 'outcome=no_independent_flagship')
    return {
      status: 'no_independent_model',
      taskId,
      roadmapId: subject.roadmapId,
      failureCode: 'no_independent_flagship',
      reason: selection.reason,
    }
  }

  const { candidate } = selection
  const provenance =
    `provider=${candidate.provider} model=${candidate.model} vendor=${selection.vendor}`
    + ` excluded=${selection.excludedVendors.join('+') || '-'}`
    // 分離を確認できなかった相手を黙って落とさない。
    + ` unverified_separation=${selection.unresolvedAuthors.join('+') || '-'}`
    + ` stage=remediation rejected_specs=${subject.rejectedSpecKeys.length}`

  // ── 実行（read-only sandbox。提案しか出てこない）────────────────
  const runnerDeps = deps.runnerDeps ?? buildDefaultRemediationDeps()
  const runnerInput = JSON.stringify({
    taskId,
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.reasoningEffort ? { reasoningEffort: candidate.reasoningEffort } : {}),
    prompt: [
      REMEDIATION_SYSTEM_PROMPT,
      '',
      buildRemediationPrompt({
        projectGoal: storage.projects.findById(subject.task.projectId)?.goal,
        subject,
        ledgerBody,
      }),
    ].join('\n'),
    workingDir: process.env.TARGET_ROOT ?? runnerDeps.workingDir,
    // この VPS では Codex が repo を読むために必要（deprecated な暫定経路）。
    useLegacyLandlockSandbox: candidate.provider === 'codex',
  })

  let execution: RunnerExecution
  try {
    execution = runnerDeps.execute
      ? await runnerDeps.execute(runnerInput)
      : await executeRunner(runnerDeps, runnerInput)
  } catch (error: unknown) {
    execution = {
      ok: false,
      stdout: '',
      error: `remediation runner error: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
    }
  }

  // **試行は必ず記録する。** 記録しないと上限が効かず、同じ失敗を無限に繰り返せる。
  if (!execution.ok) {
    recordRemediation(storage, taskId, `${provenance} outcome=runner_failed`)
    return {
      status: 'remediation_failed',
      taskId,
      roadmapId: subject.roadmapId,
      provider: candidate.provider,
      model: candidate.model,
      failureCode: 'runner_failed',
      reason: execution.error ?? 'remediation runner failed',
    }
  }

  const proposal = parseRemediationProposal(execution.stdout)
  if (!proposal) {
    recordRemediation(storage, taskId, `${provenance} outcome=unusable`)
    return {
      status: 'proposal_unusable',
      taskId,
      roadmapId: subject.roadmapId,
      provider: candidate.provider,
      model: candidate.model,
      failureCode: 'unparsable_proposal',
      reason: 'the remediation model did not produce a complete structured proposal',
    }
  }

  // ── 元案を捨てる結論。ledger は CEO の正本なので AI が書き換えない ─────
  if (proposal.abandon) {
    recordRemediation(storage, taskId, `${provenance} outcome=abandon`)
    return {
      status: 'abandon_recommended',
      taskId,
      roadmapId: subject.roadmapId,
      provider: candidate.provider,
      model: candidate.model,
      failureCode: 'abandon_recommended',
      reason: proposal.resolution,
      proposal,
    }
  }

  // ── 修正版 spec を適用する（guard → Gate → 採用 → fresh Review の共有経路）──
  //
  // **PL revision と同じ関数を通す。** 誰が spec を書いたかで関門が変わってはならない。
  const outcome = await applyRevisedSpec(storage, {
    subject,
    ledgerBody,
    submittedScope: buildRemediatedScope(proposal),
    rawScope: proposal.implementationScope,
    allowedPaths: proposal.allowedPaths,
    acceptanceCriteria: proposal.acceptanceCriteria,
    riskOpinionLevel: 'INDEPENDENT_REMEDIATION',
    rationale: proposal.resolution,
    provenance: provenance,
    ...(deps.adopt !== undefined ? { adopt: deps.adopt } : {}),
  })

  const common = {
    taskId,
    roadmapId: subject.roadmapId,
    provider: candidate.provider,
    model: candidate.model,
    proposal,
  }

  if (outcome.status === 'applied') {
    return { ...common, status: 'remediated', taskId: outcome.taskId }
  }
  if (outcome.status === 'not_materially_different') {
    return {
      ...common,
      status: 'proposal_not_materially_different',
      failureCode: outcome.failureCode,
      reason: outcome.reason,
    }
  }
  return {
    ...common,
    status: outcome.status === 'blocked'
      ? 'blocked'
      : outcome.status === 'adoption_rejected' ? 'adoption_rejected' : 'still_not_aligned',
    failureCode: outcome.failureCode,
    reason: outcome.reason,
  }
}

/** 修正版 spec を適用した結果。Remediation と PL revision が共有する。 */
export type ApplyRevisedSpecOutcome =
  | { status: 'applied'; taskId: string; proposedHash: string; specKey: string }
  | {
      status: 'not_materially_different' | 'blocked' | 'adoption_rejected' | 'still_not_aligned'
      failureCode: string
      reason: string
      proposedHash: string
      specKey: string
    }

/**
 * 修正版 Task Spec を**既存の採用経路へ適用する**。
 *
 * **Remediation（Stage 3）と PL revision（Stage 1/2）が共有する唯一の適用経路**である。
 * 別々に書くと、片方だけ material-difference guard や Gate を欠いた経路ができる。
 * 誰が spec を書いたかによって通す関門が変わってはならない。
 *
 * ここが必ず行うこと:
 *   1. **却下済みと Review 対象が同一なら適用しない**（judgment の再抽選を作らない）
 *   2. `authorizeAdoptionScope()` —— 既存 Gate。新しい action kind も承認経路も作らない
 *   3. `adoptRoadmapItem()` —— 内側で **fresh Design Review が必ず走る**。旧 evidence は
 *      hash 束縛で流用できない
 *   4. **この spec の prompt から作られた Job の実在だけ**を成功の根拠にする
 */
export async function applyRevisedSpec(
  storage: IStorage,
  input: {
    subject: RemediationSubject
    ledgerBody: string
    /** 採用へ渡す scope（判断記録を折り込んだ最終形）。 */
    submittedScope: string
    /**
     * 却下済みとの比較に使う **raw scope**（著者が書いた生の文）。
     *
     * `submittedScope` は判断記録を追記するので**毎回必ず変わる**。それをキーにすると
     * 「違う」ことを1つも保証せず、`collectRejectedSpecKeys()` が集めた過去世代のキーとも
     * 照合できない。比較の基礎は raw scope である。
     * 呼び出し側へ明示させるのは、取り違えても型では気付けないためである。
     */
    rawScope: string
    allowedPaths: string[]
    acceptanceCriteria: string[]
    /** Gate へ記録する risk 見解ラベルと理由。判定には使われない。 */
    riskOpinionLevel: string
    rationale: string
    /** audit へ残す provenance 前置き（`stage=` を含む）。 */
    provenance: string
    adopt?: typeof adoptRoadmapItem
  },
): Promise<ApplyRevisedSpecOutcome> {
  const { subject, ledgerBody } = input
  const taskId = subject.task.id

  // **raw と submitted の取り違えを黙って通さない。**
  //
  // この2つは「片方が他方を含む」関係にある（submitted = raw + 判断記録）。名前が似ていて
  // 隣接行に並ぶため、実際に一括置換で入れ替わり、**成功した review が
  // `still_not_aligned` として報告される**状態になっていた（独立レビュー指摘。4回目の混同）。
  // 型では区別できないので、関係そのものを実行時に確かめる。
  if (!input.submittedScope.includes(input.rawScope.trim())) {
    throw new Error(
      '[applyRevisedSpec] submittedScope must contain rawScope'
      + ' (submittedScope = rawScope + the decision record); the two look swapped',
    )
  }
  // **2つの hash は基礎が違う。取り違えると guard か Job 照合のどちらかが壊れる。**
  //   - `proposedHash` … **実際に submit される** prompt の hash。Job Gate が計算する値と
  //     一致させる必要があるので `submittedScope`（判断記録を含む最終形）から作る
  //   - `specKey` … 却下済みとの比較キー。判断記録は毎回変わるので **raw scope** から作る
  const proposedHash = computeProposedDesignTextHash({
    ledgerBody,
    implementationScope: input.submittedScope,
    allowedPaths: input.allowedPaths,
  })
  const specKey = shortSpecKey({
    implementationScope: input.rawScope,
    allowedPaths: input.allowedPaths,
  })
  // **却下された側のキーもここで残す。**
  //
  // 採用は Task の scope を提案内容へ置き換えるので、この世代で却下されていた案は
  // Task 上から消える。残さないと次の世代で再提出でき、A → B → A が通る。
  // 以前は Remediation 側の provenance にだけ載せていたため、**PL revision 経由だと
  // 却下キーが1件も残らなかった**（独立レビュー指摘）。適用する全経路で必要なので、
  // 呼び出し側の provenance ではなく**共有経路のここ**で付ける。
  const tail =
    `proposed=${proposedHash} fspec=${specKey}`
    + ` rejected_fspec=${subject.rejectedSpecKeys[0] ?? '-'}`

  if (!isMateriallyDifferentSpec(subject.rejectedSpecKeys, specKey)) {
    recordRemediation(storage, taskId, `${input.provenance} ${tail} outcome=not_different`)
    return {
      status: 'not_materially_different',
      failureCode: 'identical_to_rejected',
      reason:
        'the revision leaves the review-visible design (implementationScope and allowedPaths)'
        + ' identical to one the review already rejected; re-reviewing it would only re-roll'
        + ' the verdict on the same text',
      proposedHash,
      specKey,
    }
  }

  const gate = authorizeAdoptionScope(storage, {
    projectId: subject.task.projectId,
    roadmapId: subject.roadmapId,
    allowedPaths: input.allowedPaths,
    riskOpinionLevel: input.riskOpinionLevel,
    rationale: input.rationale,
  })
  if (!gate.ok) {
    recordRemediation(storage, taskId, `${input.provenance} ${tail} outcome=${gate.failureCode}`)
    return {
      status: 'blocked',
      failureCode: gate.failureCode,
      reason: gate.reason,
      proposedHash,
      specKey,
    }
  }

  recordRemediation(storage, taskId, `${input.provenance} ${tail} outcome=adopting`)

  const adopt = input.adopt ?? adoptRoadmapItem
  const result = await adopt(storage, {
    projectId: subject.task.projectId,
    roadmapId: subject.roadmapId,
    allowedPaths: input.allowedPaths,
    acceptanceCriteria: input.acceptanceCriteria,
    // **submitted 側を渡す。** raw を渡すと判断記録が Task から消え、かつ Job の prompt が
    // `proposedHash` と一致しなくなるので、**成功した fresh review まで
    // `still_not_aligned` として報告される**（独立レビュー指摘。実際にそうなっていた）。
    implementationScope: input.submittedScope,
  })

  if (!result.ok) {
    return {
      status: 'adoption_rejected',
      failureCode: result.code,
      reason: result.reason,
      proposedHash,
      specKey,
    }
  }

  // `adoptRoadmapItem()` は `ensureInitialWorkflows()` の結果を捨てるため、CONFLICT のままでも
  // `ok: true` を返す。**この spec の prompt から作られた Job だけ**を成功の根拠にする
  // （別の試行が作った Job を自分の成果として報告しない）。
  const applied = storage.jobs.findByTaskId(result.taskId).some(
    (job) => job.aiCliPrompt !== undefined && computeDesignTextHash(job.aiCliPrompt) === proposedHash,
  )
  if (!applied) {
    return {
      status: 'still_not_aligned',
      failureCode: 'fresh_review_not_aligned',
      reason: 'the revised design did not pass a fresh design review; no implement job was created',
      proposedHash,
      specKey,
    }
  }

  return { status: 'applied', taskId: result.taskId, proposedHash, specKey }
}

/**
 * 採用へ渡す `implementationScope` に、判断の記録を折り込む。
 *
 * **新しい Task field を作らない**代わりに、既存 `implementationScope` へ載せる。
 * ここへ書いたものは Task description に残り、**fresh Design Review がそのまま読む**
 * ので、レビュアーは「なぜこの scope になったか」を見たうえで判定できる
 * （Design Philosophy 8: 効果検証可能性。provenance は audit_log 側に残る）。
 */
export function buildRemediatedScope(proposal: RemediationProposal): string {
  return [
    proposal.implementationScope,
    '',
    '### Independent Remediation の記録',
    '',
    `- 却下の診断: ${proposal.diagnosis}`,
    `- 採った解決: ${proposal.resolution}`,
    `- Review Finding への回答: ${proposal.whyResolved}`,
    `- Safety / Authority への影響: ${proposal.safetyImpact}`,
    proposal.unresolvedConcerns.length > 0
      ? `- 未解決の懸念: ${proposal.unresolvedConcerns.join(' / ')}`
      : '- 未解決の懸念: なし（と Remediation 側は判断した）',
  ].join('\n')
}
