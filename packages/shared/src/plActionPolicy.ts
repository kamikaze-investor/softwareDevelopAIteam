/**
 * Mandatory Gate Policy — PL の「操作案」に対して必要 Gate を決める純粋関数。
 *
 * **PL は判断するが、自分の権限と Gate の要否を決めない。**
 * 原因分析・方針判断・次タスク選択といった PL の思考は一切制限しない。安全性は
 * 「PL に考えさせない」ことではなく、**PL が決めた操作を必ず既存 Gate へ通す**ことで担保する。
 *
 *     PL → 操作案 → resolvePlActionPolicy() が必要Gateを自動判定
 *        → 既存Gateへ強制ルーティング → 通過したものだけ実行可能
 *
 * ## ここが「足りていなかった最小分」である理由
 *
 * 既存の判定器はいずれも **Job / 変更ファイル**を入力とする:
 * `runRiskReview()`（changedFiles → RiskLevel）、`runMechanicalGate()`（安全中核ファイル）、
 * `resolvePolicy()`（Gate レスポンス → 実行ポリシー）、`recomputeDecision()`（runner の
 * 自己申告を採用せず API 側で再計算）。
 * これらには「PL が提案する**操作**（retry / quarantine 解除 / rollback / service 再起動 /
 * provider 切替 / production deploy …）に対して必要 Gate を決める入口」が無い。
 * 本モジュールはその入口だけを足す。**新しい Gate 本体・新しい Review 工程は作らない。**
 *
 * ## 不変条件（PL が変更・回避できないもの）
 *
 * Strategic / Alignment Review の要否 / Design Review の要否 / Safety Review の要否 /
 * Independent Review の要否 / CEO Approval の要否 / Production 操作権限 / Safety boundary /
 * 自身の Role・Permission level / Independent Review の独立性条件 / Gate の BLOCK 結果。
 *
 * PL はリスク分類や推奨 Gate を出してよいが、それは**参考情報に留まる**。
 * 具体的には `plRiskOpinion` は `requiredGates` の算出に一切使わず（記録のみ）、
 * `plProposedGates` は **union にしか効かない**（増やせるが減らせない）。
 *
 * ## この関数が保証しないこと（独立レビュー指摘, 2026-09-14）
 *
 * `changedFiles` は **PL が申告する値**であり、実際の差分ではない。したがってここでの
 * risk 判定は「申告された変更集合に対する**上乗せ**」でしかなく、
 * **申告を絞れば Gate が減る**。これを最後の防壁にしてはならない。
 * 実際の差分に対する権威ある判定は既存の File Change Guard と Job の `gate/check` が行う。
 * 申告できないケースを素通しにしないため、変更を伴う操作は
 * `changedFiles` が空なら `forbidden` にする（`KINDS_REQUIRING_CHANGE_SET`）。
 *
 * 同様に `providerChange` も申告値であり、**実際に投入される構成との束縛はここでは行えない**。
 * 実構成との照合は `vps-pl-execution-loop` の配線側の責務とする。
 *
 * ## 副作用を持たない
 *
 * 実行も記録もしない純粋関数である。記録は呼び出し側（API の enforcement seam）が
 * 既存の `audit_log` へ行う。React Native bundle にも載るため node 固有 API を持ち込まないこと。
 */

import { runRiskReview } from './approvalGateLogic'
import { runMechanicalGate } from './approvalLevelClassifier'
import { isGeneratorSeparatedFromFinalReviewer } from './reviewSeparation'

/** 判定ロジックを変えたら上げる。記録から「どの版で判断したか」を特定するために持つ。 */
export const PL_ACTION_POLICY_VERSION = 'pl-action-policy-v1'

// ────────────────────────────────────────────────────────────
// 語彙
// ────────────────────────────────────────────────────────────

/**
 * PL が提案しうる操作の種類。
 *
 * **ここに載っていない値は fail-closed で `forbidden` になる**（`resolvePlActionPolicy` 参照）。
 * 新しい操作を PL へ許すときは、必ずこの表と `ACTION_GATE_TABLE` を同時に更新すること。
 * 「知らない操作は素通し」にすると、語彙を1つ増やすだけで Gate を回避できてしまう。
 */
export const PL_ACTION_KINDS = [
  // ── 観測・調査。状態を変えないため Gate を要さない ──
  'observe_state',
  'read_logs',
  'read_roadmap',

  // ── 既存 Recovery の選択。実行そのものは既存 Gate 経路を通る ──
  'retry_job',
  'resume_task',
  'clear_workspace_quarantine',
  'abort_task',
  'rollback_commit',
  'rekick_design_review',
  'fail_stuck_job',

  // ── 開発の進行 ──
  'adopt_roadmap_item',
  // 外部（Tier B）で正式に完了した成果を Task state へ反映するだけの操作。
  // **実装も権限付与も行わない。** 既存の completion transition を呼ぶだけである。
  'reconcile_external_completion',
  'delegate_implementation',
  'propose_code_change',

  // ── 運用 ──
  'restart_service',
  'deploy_production',
  'switch_provider',

  // ── 常に利用可能。Gate で塞いではならない ──
  'escalate_to_ceo',

  // ── PL が自分では決められないもの（常に forbidden） ──
  'change_safety_boundary',
  'change_own_permission',
  'override_gate_block',
  'skip_required_review',
] as const

Object.freeze(PL_ACTION_KINDS)

export type PlActionKind = (typeof PL_ACTION_KINDS)[number]

/** 既存の Gate / Review 工程。**この語彙は新設ではなく、既存工程への参照である。** */
export type RequiredGate =
  | 'strategic_alignment_review'
  | 'design_review'
  | 'safety_review'
  | 'independent_review'
  | 'approval_gate'
  | 'ceo_approval'

const REQUIRED_GATES: readonly RequiredGate[] = [
  'strategic_alignment_review',
  'design_review',
  'safety_review',
  'independent_review',
  'approval_gate',
  'ceo_approval',
]

/** 出力の安定した並び順。集合演算の結果が呼び出し順で揺れないようにする。 */
const GATE_ORDER: Record<RequiredGate, number> = {
  strategic_alignment_review: 0,
  design_review: 1,
  safety_review: 2,
  independent_review: 3,
  approval_gate: 4,
  ceo_approval: 5,
}

export type PlActionDisposition = 'no_gate_required' | 'gates_required' | 'forbidden'

/** BLOCK / forbidden のときに PL が取れる行動。**override による実行は含まれない。** */
export const PL_BLOCKED_RESPONSES = [
  'fix',
  're_review',
  'propose_alternative',
  'escalate_to_ceo',
] as const

Object.freeze(PL_BLOCKED_RESPONSES)

export type PlBlockedResponse = (typeof PL_BLOCKED_RESPONSES)[number]

// ────────────────────────────────────────────────────────────
// 入出力
// ────────────────────────────────────────────────────────────

export interface PlActionProposal {
  /**
   * 操作の種類。**`PlActionKind` ではなく `string` で受ける**のが重要である。
   * PL の出力は外部プロセス（LLM + provider CLI）由来であり、型注釈は実行時の保証にならない。
   * 未知の値は素通しではなく `forbidden` へ倒す。
   */
  kind: string
  /** 変更を伴う操作のとき、その変更ファイル。既存の risk 判定へそのまま渡す。 */
  changedFiles?: readonly string[]
  /**
   * PL 自身のリスク見解。**記録するだけで `requiredGates` の算出には使わない。**
   * 自己申告で Low Risk 化して Gate を減らせる構造にしないための明示的な設計である。
   */
  plRiskOpinion?: { level: string; rationale: string }
  /**
   * PL が「これで足りる」と考えた Gate。**union にしか効かない**（増やせるが減らせない）。
   * 解決できない名前は無視する（無視は安全側＝Gate を減らさない方向にしか働かない）。
   */
  plProposedGates?: readonly string[]
  /** `switch_provider` のとき、切替後の構成。独立性条件の検査に使う。 */
  providerChange?: { generator: string; finalReviewer: string }
}

export interface PlActionPolicyDecision {
  kind: string
  disposition: PlActionDisposition
  /** システムが決めた必要 Gate。PL はこれを減らせない。 */
  requiredGates: readonly RequiredGate[]
  reasons: readonly string[]
  /** forbidden / BLOCK のときに PL が取れる行動。常に4つで、override を含まない。 */
  allowedResponsesWhenBlocked: readonly PlBlockedResponse[]
  /** 参考情報として記録するだけの PL 見解。判定には使っていない。 */
  recordedPlRiskOpinion?: { level: string; rationale: string }
  /** PL 申告のうちシステム判定に無かったため **追加** されたもの。 */
  plProposedGatesAdded: readonly RequiredGate[]
  /** PL 申告のうち解決できず無視したもの。減らす方向には働かない。 */
  plProposedGatesUnrecognized: readonly string[]
  policyVersion: string
}

// ────────────────────────────────────────────────────────────
// 操作 → 必要 Gate の基本表
// ────────────────────────────────────────────────────────────

interface ActionRule {
  gates: readonly RequiredGate[]
  /** 常に禁止する操作か。PL の権限・Safety boundary・Gate 結果そのものに触れるもの。 */
  forbidden?: true
  reason: string
}

const ACTION_GATE_TABLE: Record<PlActionKind, ActionRule> = {
  // 状態を変えない
  observe_state: { gates: [], reason: 'read-only observation does not change state' },
  read_logs: { gates: [], reason: 'read-only observation does not change state' },
  read_roadmap: { gates: [], reason: 'read-only observation does not change state' },

  // 既存 Recovery。実行は既存 Gate 経路を通る
  retry_job: {
    gates: ['approval_gate'],
    reason: 'a retried job re-enters the existing gate/check path before it may act',
  },
  /**
   * blocked な Task の再開。
   *
   * **`approval_gate` を up-front 要件から外した。** resume 自体は commit しない。
   * 行うのは「queued な Job を1つ作る」ことだけで、その Job が
   *   - `git_commit` なら `/gate/check` が**現在の diff に対して新しい Approval Request を発行**し、
   *     CEO が承認するまで blocked のままになる（承認は迂回されず、下流で必ず要求される）
   *   - AI CLI なら `resumeBlockedTask()` 自身が Design Review evidence を fail-closed で検査する
   * だからである。
   *
   * up-front に `approval_gate` を要求すると、**「新しい承認サイクルを始めるために既存の承認が要る」**
   * という循環になる。実際 production で、承認が STALE 化した blocked commit Job が
   * この循環で誰にも復旧できなくなった（2026-09-15）。
   *
   * `design_review` は残す。AI CLI の resume は workspace を書き換えるため、
   * その prompt に対する ALIGNED evidence が要る（これは実レコードで検証できる）。
   *
   * **CEO 承認（2026-09-15）は無条件ではない。** 6つの不変条件が維持されることを条件としており、
   * 正本は `docs/project_memory/rules/approval_rules.md`「resume は Gate を代替しない」章。
   * 要旨: resume は最終操作の Gate を代替しない / `git_commit` は現 HEAD・現 diff に対する新しい
   * Approval を必ず通す / Design Review 要件を維持する / deploy・production・Safety boundary・
   * authority 変更はそれぞれ既存 Gate を維持する / BLOCK 済み操作を resume だけで実行できない /
   * STALE Approval を再利用しない。**これが崩れるなら up-front `approval_gate` を戻す。**
   */
  resume_task: {
    gates: ['design_review'],
    reason:
      'resume only queues a job; a git_commit resume must still obtain a fresh approval downstream, '
      + 'and an AI CLI resume is fail-closed on design review evidence',
  },
  clear_workspace_quarantine: {
    gates: ['safety_review', 'approval_gate'],
    reason: 'clearing quarantine re-admits a workspace whose contents were not trusted',
  },
  abort_task: {
    gates: ['approval_gate'],
    reason: 'aborting discards in-flight work and changes project state',
  },
  /**
   * 外部（Tier B）で完了した成果を Task completion へ取り込む。
   *
   * **この操作は実装を行わない。** protected file を書く権限も、Safety Boundary を動かす権限も
   * 与えない。やるのは「既に canonical master へ入り production へ出た成果」を Task state へ
   * 反映することだけである（CEO 指示・2026-09-15）。
   *
   * それでも **Task を done にする**のは進行に影響する状態遷移なので、既存 Approval 機構を
   * そのまま要求する。**呼び出し側の自己申告では通らない**（根拠は server 側で機械照合する）。
   */
  reconcile_external_completion: {
    gates: ['approval_gate'],
    reason:
      'marking a Task done without the Candidate doing the work needs a human to confirm '
      + 'the external result is real; the action itself grants no write or boundary permission',
  },
  rollback_commit: {
    gates: ['safety_review', 'approval_gate', 'ceo_approval'],
    reason: 'rollback rewrites what is considered the accepted state',
  },
  /**
   * Design Review の再kick。`vps-pl-execution-loop` の production evidence
   * （timeout → requeue した run を誰も再開せず Task が止まった）で実際に必要だった操作である。
   * 表に無いと fail-closed で forbidden になり、**PL 基盤を作る動機になった復旧そのものが取れない**。
   *
   * **up-front の Gate を課さない。** 理由は「軽い操作だから」ではなく、この操作が
   * 次の3点をすべて満たすからである:
   *   1. workspace を変更しない（ファイルにも commit にも触れない）
   *   2. `claim()` が `DESIGN_REVIEW_MAX_ATTEMPTS` を強制するので**回数が有界**である
   *   3. 出力の採否は `recomputeDecision()` が API 側で再計算し、ALIGNED のときだけ
   *      evidence が登録される。つまり**この操作の結果は必ず既存 Design Review Gate を通る**
   *
   * ここで `approval_gate` を要求すると、seam の evidence モデル上「承認レコードが先に存在する
   * 復旧しか実行できない」ことになり、system が自分で queue した review を再実行するだけの操作に
   * CEO 承認を要求することになる（Design Philosophy 3「承認最小」に反する過剰安全策）。
   *
   * **下流が Gate されていることを理由に無 Gate にしてよいのはここまで**である。
   * workspace を書き換える操作（`retry_job` / `resume_task` / `delegate_implementation` 等）は
   * 上の 1 を満たさないので、同じ理屈を適用しないこと。
   *
   * ## CEO 判断（2026-09-14・承認済み）
   *
   * この操作は「Review を承認する操作」ではなく、**停止・停滞した同一 Design Review を、
   * 既存の bounded retry 契約の範囲内でもう一度実行する操作**として扱う。
   * 次を不変条件として固定する:
   *
   *   1. workspace を書き換えない
   *   2. Review 結果を変更・上書きしない
   *   3. Review Gate を skip しない
   *   4. API 側の decision 再計算を必ず通す
   *   5. `DESIGN_REVIEW_MAX_ATTEMPTS` 等の既存 attempt 上限を尊重する
   *   6. attempt 上限到達後は再kickしない
   *   7. **同一 Review の再実行以外へ権限を広げない**
   *   8. Review が依然解決しない場合は Escalation へ進む
   *   9. **PL 自身がこの境界を変更できない**
   *
   * **未知操作や近似した別 action へこの許可を流用しない。**
   * 1〜8 の実装上の強制は `apps/api/src/pl/executionLoop.ts` にあり、同ファイルのテストで固定している。
   */
  rekick_design_review: {
    gates: [],
    reason:
      'a re-kicked design review changes no workspace, is bounded by DESIGN_REVIEW_MAX_ATTEMPTS, ' +
      'and its verdict is recomputed by the API before any evidence is registered',
  },
  /**
   * 停止した running Job の強制終端（`PATCH /api/jobs/:id/fail-if-running`）。
   * 既存経路は fail-closed で、workspace 未検証なら quarantine へ倒す。
   * 進行中の作業を破棄して状態を変えるため abort_task と同じ扱いにする。
   */
  fail_stuck_job: {
    gates: ['approval_gate'],
    reason: 'force-failing a running job discards in-flight work and re-quarantines an unverified workspace',
  },

  // 開発の進行
  /**
   * Roadmap 項目の採用。
   *
   * **`strategic_alignment_review` は残す。** ただし「PL が戦略妥当性を自己申告する」形ではなく、
   * **その項目が CEO 承認済みの ledger に未完了として実在すること**を根拠にする
   * （`apps/api/src/pl/actionGate.ts` の `checkRoadmapItemAlignment()`）。
   * ledger（`tasks/roadmap.md`）は CEO が確定する Source of Truth であり、そこに載っていること自体が
   * 「やると決まっている」ことの記録である。**PL は載っていない項目を採用できない。**
   *
   * **`design_review` は up-front 要件から外した。** 採用操作そのものが
   * `ensureInitialWorkflowsForActiveTasks()` → `createAndExecuteDesignReview()` を走らせ、
   * **ALIGNED で evidence が登録されない限り implement Job は作られない**
   * （`createInitialImplementWorkflow()` の `checkImplementJobDesignReviewEvidence()` gate）。
   * つまり Design Review は迂回されるのではなく、**採用の内側で必ず実行される**。
   * up-front に要求すると「まだ存在しない Task の design review evidence」を求めることになり、
   * 構造的に充足不能（＝採用が永久に不可能）になる。
   *
   * **PL が決めてよいのは「どの項目を次にやるか」までで、変更の可否ではない。**
   * `allowedPaths` / `acceptanceCriteria` / `implementationScope` は PL が具体化するが、
   * それらは File Change Guard の効き方を決めるため、seam 側で機械的に検証する
   * （`assertAdoptionScopeIsBounded()`）。`ALWAYS_FORBIDDEN_PATTERNS` は allowedPaths に関係なく効く。
   */
  adopt_roadmap_item: {
    gates: ['strategic_alignment_review'],
    reason:
      'adoption is bounded by the CEO-approved ledger, and the design review runs inside the adoption '
      + 'itself before any job can be created',
  },
  delegate_implementation: {
    gates: ['design_review', 'approval_gate'],
    reason: 'delegated implementation produces changes that must pass the existing gates',
  },
  propose_code_change: {
    gates: ['design_review', 'approval_gate'],
    reason: 'a code change must pass design review and the approval gate',
  },

  // 運用
  restart_service: {
    gates: ['ceo_approval'],
    reason: 'restarting a production service is a production operation',
  },
  deploy_production: {
    gates: ['independent_review', 'ceo_approval'],
    reason: 'production deploy is a production operation and is not self-reviewable',
  },
  switch_provider: {
    gates: ['ceo_approval'],
    reason: 'changing providers changes who reviews whom',
  },

  /**
   * CEO Escalation。**Gate で塞いではならない唯一の write 操作である。**
   * `allowedResponsesWhenBlocked` は BLOCK のたびに `escalate_to_ceo` を返すので、これを
   * forbidden にすると「PL に残された4つの行動」が実際には取れないことになる（自己矛盾）。
   * 通知は CEO へ判断を求めるだけで、システム状態を変えない。
   */
  escalate_to_ceo: {
    gates: [],
    reason: 'escalation is the response this policy guarantees to PL; it must never be gated',
  },

  // PL が自分では決められないもの
  change_safety_boundary: {
    gates: [],
    forbidden: true,
    reason: 'the safety boundary is not PL-changeable; escalate to the CEO instead',
  },
  change_own_permission: {
    gates: [],
    forbidden: true,
    reason: 'PL does not decide its own role or permission level',
  },
  override_gate_block: {
    gates: [],
    forbidden: true,
    reason: 'a gate BLOCK is final for PL; only fix / re-review / alternative / escalation remain',
  },
  skip_required_review: {
    gates: [],
    forbidden: true,
    reason: 'the necessity of a review is decided by policy, not by PL',
  },
}

// ────────────────────────────────────────────────────────────
// 判定
// ────────────────────────────────────────────────────────────

/**
 * 変更集合の申告が無ければ判定できない操作。
 *
 * 申告が無いときに「変更ファイルが無い＝低リスク」として通すと、申告を空にするだけで
 * file 由来の Gate（independent_review / safety_review / ceo_approval）を全て外せてしまう。
 * 申告できないなら通さない。
 */
const KINDS_REQUIRING_CHANGE_SET: readonly PlActionKind[] = [
  'propose_code_change',
  'delegate_implementation',
]

function isPlActionKind(value: string): value is PlActionKind {
  return (PL_ACTION_KINDS as readonly string[]).includes(value)
}

function isRequiredGate(value: string): value is RequiredGate {
  return (REQUIRED_GATES as readonly string[]).includes(value)
}

function sortGates(gates: Iterable<RequiredGate>): RequiredGate[] {
  return [...new Set(gates)].sort((a, b) => GATE_ORDER[a] - GATE_ORDER[b])
}

function forbid(kind: string, reason: string): PlActionPolicyDecision {
  return {
    kind,
    disposition: 'forbidden',
    requiredGates: [],
    reasons: [reason],
    allowedResponsesWhenBlocked: PL_BLOCKED_RESPONSES,
    plProposedGatesAdded: [],
    plProposedGatesUnrecognized: [],
    policyVersion: PL_ACTION_POLICY_VERSION,
  }
}

/**
 * PL の操作案に対して、システムが必要と判断する Gate を返す。
 *
 * **この関数は `plRiskOpinion` を判定に使わない。** 使わないことが仕様であり、
 * 「PL が LOW と申告したから Gate を減らす」経路を構造的に作らないためである。
 */
export function resolvePlActionPolicy(proposal: PlActionProposal): PlActionPolicyDecision {
  const { kind } = proposal

  // 未知の操作は素通しにしない。語彙を1つ増やすだけで Gate を回避できてはならない。
  if (typeof kind !== 'string' || !isPlActionKind(kind)) {
    return forbid(
      typeof kind === 'string' ? kind : String(kind),
      'unknown action kind; unrecognized actions are refused rather than passed through',
    )
  }

  const rule = ACTION_GATE_TABLE[kind]

  if (rule.forbidden) {
    return forbid(kind, rule.reason)
  }

  const gates = new Set<RequiredGate>(rule.gates)
  const reasons: string[] = [rule.reason]

  // ── 変更ファイルがあるなら既存の risk 判定へそのまま通す ──
  const changedFiles = proposal.changedFiles ?? []

  if (changedFiles.length === 0 && KINDS_REQUIRING_CHANGE_SET.includes(kind)) {
    return forbid(
      kind,
      `${kind} without a declared change set cannot be risk-classified; an empty declaration must not remove file-derived gates`,
    )
  }

  if (changedFiles.length > 0) {
    const risk = runRiskReview([...changedFiles])
    if (risk.riskLevel === 'HIGH' || risk.riskLevel === 'CRITICAL') {
      gates.add('independent_review')
      reasons.push(
        `changed files classify as ${risk.riskLevel} risk (${
          risk.triggeredRules.join(', ') || 'no labelled rule'
        })`,
      )
    }
    if (risk.riskLevel === 'CRITICAL') {
      gates.add('ceo_approval')
    }

    // Mechanical Gate は安全中核ファイルを機械的に拾う。
    // diff 本文はこの時点では存在しないため file パターンのみが効く。
    // diff パターンは後段の実 Job Gate で改めて評価されるので、ここでの評価は
    // **上乗せにしかならない**（取りこぼしても既存経路が落とさない）。
    const mechanical = runMechanicalGate([...changedFiles], '')
    if (mechanical.triggered) {
      gates.add('safety_review')
      gates.add('independent_review')
      gates.add('ceo_approval')
      reasons.push(`mechanical gate hit: ${mechanical.hits.map((hit) => hit.patternId).join(', ')}`)
    }
  }

  // ── Independent Review の独立性条件は PL より上位の Policy である ──
  if (kind === 'switch_provider') {
    const change = proposal.providerChange
    if (!change) {
      return forbid(
        kind,
        'switch_provider without the resulting generator / final reviewer pair cannot be checked for review independence',
      )
    }
    if (!isGeneratorSeparatedFromFinalReviewer(change.generator, change.finalReviewer)) {
      return forbid(
        kind,
        `the resulting configuration would let ${change.generator} be finally reviewed by ${change.finalReviewer}; review independence is not PL-relaxable`,
      )
    }
    reasons.push('review independence holds for the resulting provider pair')
  }

  // ── PL の申告は union にしか効かない ──
  const added: RequiredGate[] = []
  const unrecognized: string[] = []
  for (const proposed of proposal.plProposedGates ?? []) {
    if (!isRequiredGate(proposed)) {
      unrecognized.push(proposed)
      continue
    }
    if (!gates.has(proposed)) {
      gates.add(proposed)
      added.push(proposed)
    }
  }
  if (added.length > 0) {
    reasons.push(`PL additionally proposed: ${added.join(', ')} (added, never subtracted)`)
  }

  const requiredGates = sortGates(gates)

  return {
    kind,
    disposition: requiredGates.length === 0 ? 'no_gate_required' : 'gates_required',
    requiredGates,
    reasons,
    allowedResponsesWhenBlocked: PL_BLOCKED_RESPONSES,
    recordedPlRiskOpinion: proposal.plRiskOpinion,
    plProposedGatesAdded: added,
    plProposedGatesUnrecognized: unrecognized,
    policyVersion: PL_ACTION_POLICY_VERSION,
  }
}
