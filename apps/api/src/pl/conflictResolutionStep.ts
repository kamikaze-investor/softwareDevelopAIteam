/**
 * Design Review CONFLICT の解決を**段階的に**進める。
 *
 * ## これは Review Pipeline を所有しない
 *
 * ここにあるのは **selector** である。既存 review state（`design_review_runs` /
 * `design_review_evidence`）と既存 audit を**観測して**「次に何をするか」を決めるだけで、
 * Review 自体は既存経路（`adoptRoadmapItem()` → `ensureInitialWorkflowsForActiveTasks()` →
 * `createInitialImplementWorkflow()` → `createAndExecuteDesignReview()`）が実行する。
 *
 * したがって `original_review` / `fresh_review` は**このモジュールの stage ではない**。
 * それらは既存 evidence から読み取る**入力状態**である。新しい Review workflow ownership も
 * 重複 stage も作らない（CEO 指示 2026-09-18）。
 *
 * ## 基本フロー
 *
 *   PL Task Design → 既存 Design Review → CONFLICT
 *     → Independent Critic → PL revision → 既存 Design Review
 *     → 再 CONFLICT → 次 Round の Critic → PL revision → 既存 Design Review
 *     → 解決しなければ Independent Remediation → 既存 adoption seam → 既存 Design Review
 *     → それでも解決しなければ terminal
 *
 * **Critic が Review Finding 自体を具体的根拠付きで dispute した場合だけ**、frozen spec に
 * 対する `stage=challenge` へ条件分岐する。**challenge は固定 stage ではない。**
 *
 * ## Independent Remediation は最初の手段ではない
 *
 * PL は Task Design の Owner のままである。Critic は分析だけを返し、修正するのは PL 自身。
 * flagship が Task Spec を直接再設計する Independent Remediation は、Critic-assisted な
 * PL revision で解決しなかった場合の**強い救済手段**として最後に置く。
 */

import { readFileSync } from 'node:fs'
import {
  bindingDisputes,
  challengeableDisputes,
  parseCritique,
  selectCriticModel,
  challengeTarget,
  type Critique,
  type DesignReviewFinding,
  type FindingAssessment,
} from '@ai-team/shared'
import { getValidRoadmapItems } from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
import { requestText } from '../aiExplain/cheapAiClient'
import {
  buildDefaultCoordinatorDeps,
  createAndExecuteDesignReview,
  executeRunner,
  type CoordinatorDeps,
  type RunnerExecution,
} from '../designReview/designReviewCoordinator'
import { createInitialImplementWorkflow } from '../ctoAi/initialImplementWorkflow'
import { extractImplementationScope, extractItemDescription } from '../ctoAi/roadmapAdoption'
import type { IStorage } from '../storage/interface'
import { ADOPTION_REPOSITORY_MAP, resolveLedgerPath } from './adoptionStep'
import {
  applyRevisedSpec,
  buildDefaultRemediationDeps,
  countRemediationAttempts,
  findRemediationSubject,
  PL_MAX_REMEDIATION_ATTEMPTS,
  priorCriticModels,
  priorCriticProviders,
  recordRemediationFailure,
  runRemediationStep,
  stageEntries,
  type PlRemediationDeps,
  type RemediationSubject,
} from './remediationStep'

/** Critic-assisted PL revision を試せる Round 数。既存 attempt policy と同じ 2 に合わせる。 */
export const PL_MAX_CRITIC_ROUNDS = 2

/**
 * stage machine が**実際に実行する** stage。
 *
 * `original_review` / `fresh_review` は含まない —— それは既存 Review Pipeline が行うことで、
 * ここは既存 evidence からその結果を**読む**側である。
 */
export type ConflictStage = 'critic' | 'pl_revision' | 'challenge' | 'remediation' | 'terminal'

export interface ConflictStageSelection {
  stage: ConflictStage
  reason: string
  criticRounds: number
  remediationAttempts: number
}

/**
 * 次に実行する stage を**既存レコードだけ**から決める。
 *
 * `challenge` はここから返さない。**Critique の内容で決まる条件分岐**であり、
 * 固定 stage ではないからである（CEO 指示 2026-09-18）。
 */
export function selectConflictStage(storage: IStorage, taskId: string): ConflictStageSelection {
  const criticRounds = stageEntries(storage, taskId, 'critic').length
  const remediationAttempts = countRemediationAttempts(storage, taskId)
  const base = { criticRounds, remediationAttempts }

  if (findRemediationSubject(storage, taskId) === undefined) {
    return { stage: 'terminal', reason: 'task is not stopped by a design review CONFLICT', ...base }
  }
  if (criticRounds < PL_MAX_CRITIC_ROUNDS) {
    return { stage: 'critic', reason: `critic round ${criticRounds + 1}/${PL_MAX_CRITIC_ROUNDS}`, ...base }
  }
  if (remediationAttempts < PL_MAX_REMEDIATION_ATTEMPTS) {
    return {
      stage: 'remediation',
      reason: 'critic-assisted revision did not resolve it; escalating to independent remediation',
      ...base,
    }
  }
  return { stage: 'terminal', reason: 'critic rounds and remediation attempts are both exhausted', ...base }
}

// ────────────────────────────────────────────────────────────
// Critic prompt
// ────────────────────────────────────────────────────────────

export const CRITIC_SYSTEM_PROMPT = [
  'You are an INDEPENDENT CRITIC. A Task design was stopped by a formal Design Review with',
  'decision CONFLICT. You did not write the design and you did not write the review.',
  '',
  'Your job is to criticise BOTH, as a third party, so the Project Lead can improve the design.',
  '',
  '**Your goal is NOT to get the review to PASS.** Do not look for wording that would slip past',
  'the reviewer. Do not propose superficial rephrasing, and do not suggest narrowing the scope to',
  'something meaningless just to clear the gate. If the honest answer is that the design is wrong,',
  'say that.',
  '',
  'You have no authority here, by design:',
  '- You cannot change the Task Spec. You describe directions; the Project Lead decides and writes.',
  '- You cannot decide PASS or CONFLICT. The formal Review Pipeline does that, not you.',
  '',
  '**Do not treat the Review Finding as necessarily correct.** Assess it. For each finding say',
  'whether it is:',
  '  - "supported": it holds up against the code, the spec and existing decisions',
  '  - "partially_supported": partly right, but wrong about scope or cause',
  '  - "disputed": it does NOT hold. This is a positive claim and needs real grounds (below).',
  '  - "insufficient_evidence": you cannot tell from what you can see',
  '',
  'A "disputed" assessment REQUIRES both:',
  '  - "grounds": one of exactly these —',
  '      contradicts_code_or_spec, wrong_premise, symptom_mistaken_for_root_cause,',
  '      following_it_breaks_goal_or_constraint',
  '  - "evidence": the concrete thing that shows it (a file, a spec section, an existing decision)',
  'Uncertainty is NOT a dispute. "There is another way to see it" is NOT a dispute. If you cannot',
  'point at something concrete, use "insufficient_evidence" — that is a respectable answer and it',
  'does not weaken the rest of your critique.',
  '',
  'Do not appease the finding at the cost of the Goal, the Design Philosophy, existing strategy or',
  'existing contracts. If following the finding would break one of those, say so and use',
  'grounds "following_it_breaks_goal_or_constraint".',
  '',
  ADOPTION_REPOSITORY_MAP,
  '',
  'Answer with a single JSON object and nothing else:',
  '{"coreProblems": ["root causes, not symptoms"],',
  ' "findingAssessments": [{"source": "<finding source>", "status": "supported|partially_supported|disputed|insufficient_evidence",',
  '   "rationale": "why", "grounds": "<only when disputed>", "evidence": "<only when disputed>"}],',
  ' "hiddenRisks": ["problems the reviewer did not raise"],',
  ' "constraintsToPreserve": ["what must not be broken"],',
  ' "improvementDirections": ["how the design should change"],',
  ' "thingsNotToChange": ["what is already right"],',
  ' "uncertainties": ["what you could not determine"]}',
].join('\n')

function formatFindings(findings: readonly DesignReviewFinding[]): string[] {
  return findings.flatMap((finding) => [
    `- [${finding.source}] ${finding.decision}${finding.summary ? `: ${finding.summary}` : ''}`,
    ...finding.messages.map((message) => `    - ${message}`),
  ])
}

/** 候補1件あたりに載せる ledger 本文の長さ。全文は載せない。 */
const LEDGER_BODY_CHARS = 4_000

export function buildCriticPrompt(input: {
  projectGoal?: string
  subject: RemediationSubject
  ledgerBody: string
  /** 過去 Round の Critique（2 Round 目以降）。 */
  priorCritiques?: readonly Critique[]
  /** 過去 Round で PL が行った変更の要約。 */
  priorRevisions?: readonly string[]
}): string {
  const { subject } = input
  const currentScope = extractImplementationScope(subject.task.description)

  return [
    ...(input.projectGoal !== undefined && input.projectGoal.trim() !== ''
      ? ['Project goal (what all of this is for):', input.projectGoal.trim().slice(0, 600), '']
      : []),
    'The formal Design Review returned CONFLICT with these findings:',
    ...formatFindings(subject.findings),
    '',
    `Roadmap item (the CEO-approved source of truth): ${subject.roadmapId}`,
    input.ledgerBody.slice(0, LEDGER_BODY_CHARS),
    '',
    'The current Task design:',
    `- implementationScope: ${currentScope ?? '(none was specified)'}`,
    `- allowedPaths: ${JSON.stringify(subject.task.allowedPaths)}`,
    `- acceptanceCriteria: ${JSON.stringify(subject.task.acceptanceCriteria)}`,
    // 2 Round 目以降は**すべての最新情報**を渡す（CEO 指示）。局所的な言い換えではなく
    // 必要なら再設計を検討できるようにするため、過去の批判と PL の変更も含める。
    ...(input.priorCritiques !== undefined && input.priorCritiques.length > 0
      ? [
          '',
          'Earlier critiques in this chain (the design has already been revised once):',
          ...input.priorCritiques.flatMap((critique, index) => [
            `Round ${index + 1} core problems: ${critique.coreProblems.join(' / ')}`,
            `Round ${index + 1} directions given: ${critique.improvementDirections.join(' / ')}`,
          ]),
          'If the same problem survived a revision, say why the earlier direction was not enough.',
          'A redesign is allowed and may be the right answer — do not limit yourself to local edits.',
        ]
      : []),
    ...(input.priorRevisions !== undefined && input.priorRevisions.length > 0
      ? ['', 'What the Project Lead changed in response:', ...input.priorRevisions.map((r) => `- ${r}`)]
      : []),
  ].join('\n')
}

// ────────────────────────────────────────────────────────────
// PL revision prompt
// ────────────────────────────────────────────────────────────

export const PL_REVISION_SYSTEM_PROMPT = [
  'You are the Project Lead (PL) and the OWNER of this Task design. A formal Design Review',
  'returned CONFLICT, and an independent critic has analysed both your design and the review.',
  '',
  'Decide what the design should be. You are not required to agree with the critic, and you are',
  'not trying to find wording that gets past the reviewer — you are trying to make the design',
  'right. A redesign is allowed. So is a strictly smaller scope.',
  '',
  'Consider all of: the Project goal, the roadmap item, the design principles, the review',
  'findings, the critic analysis, and the Safety / Authority constraints. You cannot widen Safety',
  'or Authority boundaries, and you cannot overrule the review — your revised design will go',
  'through the normal formal Design Review again.',
  '',
  'Rules you cannot change:',
  '- **Never invent a path.** Every allowedPaths entry must exist in the repository.',
  '- allowedPaths entries must be repository-relative and at least two path segments deep.',
  '- implementationScope must say exactly what is in scope and what is out of scope.',
  '- acceptanceCriteria must be mechanically checkable.',
  '- The revision must be MATERIALLY different from what was rejected: changing only the',
  '  acceptanceCriteria does not count, because the reviewer never sees them.',
  '',
  ADOPTION_REPOSITORY_MAP,
  '',
  'Answer with a single JSON object and nothing else:',
  '{"implementationScope": "...", "allowedPaths": ["..."], "acceptanceCriteria": ["..."],',
  ' "rationale": "what you changed and why", "respondsTo": "how this answers the findings"}',
].join('\n')

export interface PlRevision {
  implementationScope: string
  allowedPaths: string[]
  acceptanceCriteria: string[]
  rationale: string
  respondsTo: string
}

export function parsePlRevision(raw: string): PlRevision | undefined {
  const match = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!match) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1] ?? match[0]) as unknown
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const obj = parsed as Record<string, unknown>

  const text = (key: string): string | undefined => {
    const value = obj[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const list = (key: string): string[] | undefined => {
    const value = obj[key]
    if (!Array.isArray(value)) return undefined
    const items = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    return items.length === value.length && items.length > 0 ? items.map((v) => v.trim()) : undefined
  }

  const implementationScope = text('implementationScope')
  const rationale = text('rationale')
  const respondsTo = text('respondsTo')
  const allowedPaths = list('allowedPaths')
  const acceptanceCriteria = list('acceptanceCriteria')

  if (!implementationScope || !rationale || !respondsTo || !allowedPaths || !acceptanceCriteria) {
    return undefined
  }
  return { implementationScope, allowedPaths, acceptanceCriteria, rationale, respondsTo }
}

/**
 * PL の修正版 scope に判断の記録を折り込む。
 *
 * **新しい Task field を作らない。** ここへ書いたものは Task description に残り、
 * **次の formal Design Review がそのまま読む**ので、レビュアーは「なぜこの設計になったか」を
 * 見たうえで判定できる。
 */
export function buildPlRevisedScope(revision: PlRevision, critique: Critique): string {
  return [
    revision.implementationScope,
    '',
    '### PL revision の記録（Independent Critic を踏まえた再設計）',
    '',
    `- 変更した内容と理由: ${revision.rationale}`,
    `- Review Finding への回答: ${revision.respondsTo}`,
    `- Critic が挙げた根本原因: ${critique.coreProblems.join(' / ')}`,
    critique.hiddenRisks.length > 0
      ? `- Critic が挙げた隠れたリスク: ${critique.hiddenRisks.join(' / ')}`
      : '- Critic が挙げた隠れたリスク: なし',
    `- 維持すべき制約: ${critique.constraintsToPreserve.join(' / ') || '（Critic は挙げなかった）'}`,
  ].join('\n')
}

// ────────────────────────────────────────────────────────────
// 実行
// ────────────────────────────────────────────────────────────

export type ConflictRoundStatus =
  /** CONFLICT で止まった採用ではない。 */
  | 'not_applicable'
  /** Critic の実行に失敗した（弱い model へは落ちない）。 */
  | 'critic_failed'
  /** Critic 応答が構造化された Critique にならなかった。 */
  | 'critique_unusable'
  /** Critic の分析を踏まえて PL が修正し、fresh Design Review を通った。 */
  | 'revised_and_aligned'
  /** PL が修正したが fresh Design Review が通らなかった。 */
  | 'revised_not_aligned'
  /** PL の修正案が使えなかった / Gate に止められた。 */
  | 'revision_rejected'
  /** frozen spec の再評価が ALIGNED evidence を生み、既存 Gate が Job を作った。 */
  | 'challenge_aligned'
  /** frozen spec の再評価が ALIGNED にならなかった。**release しない。** */
  | 'challenge_not_aligned'
  /** 同一 (spec, finding) の再評価は既に使い切っている。 */
  | 'challenge_cap_reached'
  /** Independent Remediation へ移行した（結果は `remediation` に入る）。 */
  | 'remediation'
  /** Round 予算を使い切った。 */
  | 'terminal'

export interface ConflictRoundResult {
  status: ConflictRoundStatus
  stage: ConflictStage
  taskId: string
  reason?: string
  failureCode?: string
  /** Critic の provider / model（provenance）。 */
  criticProvider?: string
  criticModel?: string
  critique?: Critique
  /** Binding Safety 側の dispute。**Challenge では解除されない**ので呼び出し側が人へ渡す。 */
  bindingDisputes?: readonly FindingAssessment[]
  /** Independent Remediation の結果（`stage === 'remediation'` のとき）。 */
  remediation?: Awaited<ReturnType<typeof runRemediationStep>>
}

export interface ConflictResolutionDeps {
  /** Critic runner 起動設定。既定は Remediation と同じ one-shot flagship runner。 */
  runnerDeps?: CoordinatorDeps
  /** PL 自身の model による修正。既定は既存 cheap client（PL は Task Design の Owner）。 */
  revise?: (system: string, user: string) => Promise<string>
  /** frozen spec の再評価。既定は既存 `createAndExecuteDesignReview()`。 */
  reEvaluate?: typeof createAndExecuteDesignReview
  /** 再評価で ALIGNED になった後の Job 生成。既定は既存 `createInitialImplementWorkflow()`。 */
  ensureJob?: typeof createInitialImplementWorkflow
  coordinatorDeps?: CoordinatorDeps
  readLedger?: () => string
  remediationDeps?: PlRemediationDeps
  adopt?: Parameters<typeof applyRevisedSpec>[1]['adopt']
}

/** PL の修正に使えるトークン数。既存 `PL_ADOPTION_MAX_TOKENS` と同じ桁に収める。 */
const PL_REVISION_MAX_TOKENS = 900

/**
 * 同一 (frozen spec, finding) に対する再評価キー。
 *
 * **これが「1回だけ」の根拠である。** 新しい counter table は作らず、既存 audit 行に
 * このキーを書いておき、存在すれば消費済みとする。
 */
function challengeKey(designTextHash: string, findingSource: string): string {
  return `${designTextHash.slice(0, 12)}:${findingSource}`
}

function challengeConsumed(storage: IStorage, taskId: string, key: string): boolean {
  return stageEntries(storage, taskId, 'challenge')
    .some((entry) => (entry.detail ?? '').includes(`chal=${key}`))
}

/** ledger 本文を読む（既存 parser をそのまま使う）。 */
function readLedgerBody(
  subject: RemediationSubject,
  readLedger: () => string,
): { ok: true; body: string } | { ok: false; failureCode: string; reason: string } {
  try {
    const markdown = readLedger()
    const item = getValidRoadmapItems(markdown).find((c) => c.id === subject.roadmapId)
    if (!item) {
      return {
        ok: false,
        failureCode: 'item_not_in_ledger',
        reason: `roadmap item "${subject.roadmapId}" is no longer in the ledger`,
      }
    }
    return { ok: true, body: extractItemDescription(markdown, item) }
  } catch (error: unknown) {
    return {
      ok: false,
      failureCode: 'ledger_unreadable',
      reason: `roadmap ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * frozen spec に対する **fresh formal re-evaluation** を1回だけ行う。
 *
 * ## 呼称について厳密であること（CEO 指示 2026-09-18）
 *
 * これは **different-vendor independent re-review ではない。** 現状の実装では
 *   - 元 Design Reviewer の provider / model を**取得できない**（`DesignReviewRun` に
 *     provider 欄が無く、`strategicReview` は `providerUsed` を捨てている）
 *   - したがって再評価側が元 Reviewer と別 vendor / model である保証も**無い**
 * ため、「reviewer diversity 確認済み」「独立 reviewer による再審査」とは表現しない。
 * 不足している provenance の owner は既存 Roadmap item
 * `review-provider-exhausted-alternate-rereview` である。
 *
 * **保証するのはここまで**: 「Critic の具体的な異議に基づく、同一 frozen Task Spec への
 * once-per-(spec, finding) な fresh formal re-evaluation」。判定は既存
 * `recomputeDecision()` が行い、ALIGNED evidence が出た場合のみ既存 Job Gate へ進む。
 * **新しい override action は作らない。** 元の CONFLICT run は履歴として保持し、削除も上書きもしない。
 */
async function runChallenge(
  storage: IStorage,
  subject: RemediationSubject,
  dispute: FindingAssessment,

  deps: ConflictResolutionDeps,
): Promise<ConflictRoundResult> {
  const taskId = subject.task.id
  const key = challengeKey(subject.reviewedDesignTextHash, dispute.source)
  const base = { stage: 'challenge' as const, taskId }

  if (challengeConsumed(storage, taskId, key)) {
    return {
      ...base,
      status: 'challenge_cap_reached',
      failureCode: 'challenge_already_used',
      reason:
        `the same frozen spec and finding (${dispute.source}) has already had its one`
        + ' fresh re-evaluation; repeating it would be drawing for a different verdict',
    }
  }

  // **先に消費を記録する。** 後で書くと、途中で落ちた場合に何度でも引けてしまう。
  // `orig_provider` / `orig_model` は取得不能なので `unavailable` と明示する
  // （owner: review-provider-exhausted-alternate-rereview）。
  recordRemediationFailure(
    storage,
    taskId,
    `stage=challenge chal=${key} orig_provider=unavailable orig_model=unavailable`
    + ` orig_verdict=CONFLICT finding=${dispute.source} grounds=${dispute.grounds ?? '-'}`
    + ` evidence=${dispute.evidence !== undefined ? 'yes' : 'no'} outcome=starting`,
  )

  const reEvaluate = deps.reEvaluate ?? createAndExecuteDesignReview
  const outcome = await reEvaluate(
    storage,
    {
      taskId,
      taskTitle: subject.task.title,
      // **byte-identical。** spec は変更しない。
      designText: subject.reviewedDesignText,
      // **元 run と同じ changedFiles。** `[]` に落とすと reviewLoad が下がり、
      // critical で必須の Independent Review が省かれてしまう。
      changedFiles: [...subject.reviewedChangedFiles],
    },
    deps.coordinatorDeps ?? buildDefaultCoordinatorDeps(),
  )

  const verdict = outcome.decision ?? outcome.status
  // verdict reversal を観測可能な事実として残す（新しい metrics backend は作らない）。
  recordRemediationFailure(
    storage,
    taskId,
    `stage=challenge chal=${key} orig_verdict=CONFLICT chal_verdict=${verdict}`
    + ` reversal=${outcome.status === 'evidence_registered' ? 'yes' : 'no'} outcome=evaluated`,
  )

  if (outcome.status !== 'evidence_registered') {
    // **release しない。** UNCERTAIN / REVIEW_UNAVAILABLE / CONFLICT はいずれも通さない。
    return {
      ...base,
      status: 'challenge_not_aligned',
      failureCode: `challenge_${String(verdict).toLowerCase()}`,
      reason:
        `the fresh re-evaluation of the unchanged spec returned ${String(verdict)};`
        + ' the original finding stands and the design does not proceed',
    }
  }

  // ALIGNED evidence が出た。**既存 Job Gate に従って進む**（override はしない）。
  const ensureJob = deps.ensureJob ?? createInitialImplementWorkflow
  const job = await ensureJob(storage, taskId, deps.coordinatorDeps ?? buildDefaultCoordinatorDeps())

  return {
    ...base,
    status: job.status === 'created' ? 'challenge_aligned' : 'challenge_not_aligned',
    ...(job.status === 'created'
      ? {}
      : {
          failureCode: 'gate_did_not_release',
          reason: `re-evaluation aligned but the existing job gate did not create a job: ${job.reason}`,
        }),
  }
}

/**
 * Critic を1回走らせ、その結果で**分岐する**。
 *
 * 分岐は2つだけ:
 *   - 具体的根拠付きの advisory dispute があれば → `stage=challenge`（frozen spec の再評価）
 *   - それ以外は → PL revision（PL 自身の model が設計を直す）
 *
 * **Critique を永続化しない。** Critic と PL revision を同じ Round 内で行うので、
 * Critique はメモリ上で渡せば足りる。tick を分けると Critique を保存する新しい state が
 * 必要になり、「新しい永続 state を作らない」方針に反する。
 */
async function runCriticRound(
  storage: IStorage,
  subject: RemediationSubject,
  ledgerBody: string,
  deps: ConflictResolutionDeps,
): Promise<ConflictRoundResult> {
  const taskId = subject.task.id
  const base = { stage: 'critic' as const, taskId }

  // ── Critic model（Preference のみ。**不足しても失敗しない**）──────
  const selection = selectCriticModel({
    previousProviders: priorCriticProviders(storage, taskId),
    previousModels: priorCriticModels(storage, taskId),
  })
  const { candidate } = selection
  const provenance =
    `stage=critic provider=${candidate.provider} model=${candidate.model}`
    + ` vendor=${selection.vendor} reused_model=${selection.reusedModel ? 'yes' : 'no'}`
    + ` reused_vendor=${selection.reusedVendor ? 'yes' : 'no'}`

  const runnerDeps = deps.runnerDeps ?? buildDefaultRemediationDeps()
  const runnerInput = JSON.stringify({
    taskId,
    provider: candidate.provider,
    model: candidate.model,
    ...(candidate.reasoningEffort ? { reasoningEffort: candidate.reasoningEffort } : {}),
    prompt: [
      CRITIC_SYSTEM_PROMPT,
      '',
      buildCriticPrompt({
        projectGoal: storage.projects.findById(subject.task.projectId)?.goal,
        subject,
        ledgerBody,
        priorRevisions: priorRevisionSummaries(storage, taskId),
      }),
    ].join('\n'),
    workingDir: process.env.TARGET_ROOT ?? runnerDeps.workingDir,
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
      error: `critic runner error: ${error instanceof Error ? error.message : String(error)}`,
      timedOut: false,
    }
  }

  // **試行は必ず記録する**（記録しないと Round 予算が効かない）。
  if (!execution.ok) {
    recordRemediationFailure(storage, taskId, `${provenance} outcome=runner_failed`)
    return {
      ...base,
      status: 'critic_failed',
      criticProvider: candidate.provider,
      criticModel: candidate.model,
      failureCode: 'critic_runner_failed',
      reason: execution.error ?? 'the critic runner failed',
    }
  }

  const critique = parseCritique(execution.stdout)
  if (!critique) {
    recordRemediationFailure(storage, taskId, `${provenance} outcome=critique_unusable`)
    return {
      ...base,
      status: 'critique_unusable',
      criticProvider: candidate.provider,
      criticModel: candidate.model,
      failureCode: 'unparsable_critique',
      reason: 'the critic did not produce a complete structured critique',
    }
  }

  const binding = bindingDisputes(critique)
  recordRemediationFailure(
    storage,
    taskId,
    `${provenance} disputes=${challengeableDisputes(critique).length}`
    + ` binding_disputes=${binding.length} outcome=critiqued`,
  )

  const withCritic = {
    critique,
    criticProvider: candidate.provider,
    criticModel: candidate.model,
    ...(binding.length > 0 ? { bindingDisputes: binding } : {}),
  }

  // ── 条件分岐: 具体的根拠付きの advisory dispute があるか ──────────
  //
  // **challenge は固定 stage ではない。** ここだけが入口である。
  const target = challengeTarget(critique, subject.findings.map((f) => f.source))
  if (target !== undefined) {
    const dispute = target
    const challenge = await runChallenge(storage, subject, dispute, deps)
    if (challenge.status !== 'challenge_cap_reached') {
      return { ...challenge, ...withCritic }
    }
    // 上限を使い切っている場合は通常の PL revision へ落ちる（**止めない**）。
  }

  return { ...(await runPlRevision(storage, subject, ledgerBody, critique, deps)), ...withCritic }
}

/** 過去 Round で PL が行った変更の要約（audit から復元。新しい state は作らない）。 */
function priorRevisionSummaries(storage: IStorage, taskId: string): string[] {
  const summaries: string[] = []
  for (const entry of stageEntries(storage, taskId, 'critic')) {
    const match = /\bfspec=(\S+)/.exec(entry.detail ?? '')
    if (match?.[1] !== undefined) summaries.push(`revised design (spec key ${match[1]})`)
  }
  return summaries
}

/**
 * PL 自身の model が設計を直す。
 *
 * **PL が Task Design の Owner である。** Critic は分析を返すだけで、書くのは PL。
 * 修正版は**別の design text**になるので、`applyRevisedSpec()` 経由で通常どおり
 * fresh Design Review を通る（旧 evidence は hash 束縛で流用できない）。
 */
async function runPlRevision(
  storage: IStorage,
  subject: RemediationSubject,
  ledgerBody: string,
  critique: Critique,
  deps: ConflictResolutionDeps,
): Promise<ConflictRoundResult> {
  const taskId = subject.task.id
  const base = { stage: 'pl_revision' as const, taskId }

  const revise = deps.revise
    ?? ((system: string, user: string) => requestText(system, user, {}, PL_REVISION_MAX_TOKENS))

  let raw: string
  try {
    raw = await revise(
      PL_REVISION_SYSTEM_PROMPT,
      [
        buildCriticPrompt({
          projectGoal: storage.projects.findById(subject.task.projectId)?.goal,
          subject,
          ledgerBody,
        }),
        '',
        'The independent critic said:',
        `- core problems: ${critique.coreProblems.join(' / ')}`,
        `- finding assessments: ${critique.findingAssessments
          .map((a) => `${a.source}=${a.status}`)
          .join(', ')}`,
        `- hidden risks: ${critique.hiddenRisks.join(' / ') || '(none)'}`,
        `- constraints to preserve: ${critique.constraintsToPreserve.join(' / ') || '(none)'}`,
        `- improvement directions: ${critique.improvementDirections.join(' / ')}`,
        `- do not change: ${critique.thingsNotToChange.join(' / ') || '(nothing named)'}`,
        `- uncertainties: ${critique.uncertainties.join(' / ') || '(none)'}`,
      ].join('\n'),
    )
  } catch (error: unknown) {
    return {
      ...base,
      status: 'revision_rejected',
      failureCode: 'pl_revision_failed',
      reason: `the PL revision call failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const revision = parsePlRevision(raw)
  if (!revision) {
    return {
      ...base,
      status: 'revision_rejected',
      failureCode: 'unparsable_revision',
      reason: 'the PL did not produce a complete revised task specification',
    }
  }

  // **Remediation と同じ適用経路。** 誰が書いたかで関門は変わらない。
  const outcome = await applyRevisedSpec(storage, {
    subject,
    ledgerBody,
    submittedScope: buildPlRevisedScope(revision, critique),
    rawScope: revision.implementationScope,
    allowedPaths: revision.allowedPaths,
    acceptanceCriteria: revision.acceptanceCriteria,
    riskOpinionLevel: 'PL_REVISION',
    rationale: revision.rationale,
    // ** にする。**  のままだと、1 Round で Critic 行と
    // 適用行の2行が critic として数えられ、**1 Round で2 Round 分の予算を消費**する
    // （独立レビュー指摘。実際に Critic は1 Round しか回らなかった）。
    provenance: 'stage=pl_revision',
    ...(deps.adopt !== undefined ? { adopt: deps.adopt } : {}),
  })

  if (outcome.status === 'applied') {
    return { ...base, status: 'revised_and_aligned', taskId: outcome.taskId }
  }
  if (outcome.status === 'still_not_aligned') {
    return { ...base, status: 'revised_not_aligned', failureCode: outcome.failureCode, reason: outcome.reason }
  }
  return { ...base, status: 'revision_rejected', failureCode: outcome.failureCode, reason: outcome.reason }
}

/**
 * CONFLICT で止まった Task を1 Round 進める。
 *
 * 呼び出し側（PL ループ）が「いま実行してよい状況か」を決め、ここは**1 Round だけ**行う。
 */
export async function runConflictResolutionRound(
  storage: IStorage,
  taskId: string,
  deps: ConflictResolutionDeps = {},
): Promise<ConflictRoundResult> {
  const selection = selectConflictStage(storage, taskId)

  if (selection.stage === 'terminal') {
    return { status: 'terminal', stage: 'terminal', taskId, reason: selection.reason }
  }

  if (selection.stage === 'remediation') {
    // **既存実装をそのまま使う**（Stage 3 は作り直していない）。
    const remediation = await runRemediationStep(storage, taskId, deps.remediationDeps ?? {})
    return { status: 'remediation', stage: 'remediation', taskId, remediation, reason: selection.reason }
  }

  const subject = findRemediationSubject(storage, taskId)
  if (!subject) {
    return { status: 'not_applicable', stage: 'terminal', taskId, reason: 'no conflicted subject' }
  }

  const ledger = readLedgerBody(
    subject,
    deps.readLedger ?? (() => readFileSync(resolveLedgerPath(), 'utf-8')),
  )
  if (!ledger.ok) {
    // ledger が直るまで結果は変わらないので試行として記録し、有界にする。
    recordRemediationFailure(storage, taskId, `stage=critic outcome=${ledger.failureCode}`)
    return {
      status: 'not_applicable',
      stage: 'critic',
      taskId,
      failureCode: ledger.failureCode,
      reason: ledger.reason,
    }
  }

  return runCriticRound(storage, subject, ledger.body, deps)
}
