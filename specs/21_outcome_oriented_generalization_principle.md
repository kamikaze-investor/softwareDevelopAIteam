# Outcome-Oriented Generalization Principle

<!-- principle-id: evidence-not-spec -->
<!-- principle-oneliner: Define required outcomes first; current implementation is evidence, not specification. -->
<!-- principle-category: outcome-definition -->
<!-- principle-scope: universal -->
<!-- principle-tier: core -->
<!-- principle-tags: requirements, design, contract -->
■ Top-level principle: define "what must ultimately be guaranteed for this to be a success" before "how
to implement it." Within Required Outcomes / Non-Negotiable Invariants, preserve maximum Implementation
Freedom. Current implementation is evidence, not specification. Priority: Goal -> Design Philosophy ->
Policy/Approval Policy -> Required Outcomes -> Non-Negotiable Invariants -> Stable Contract -> Current
Implementation.

<!-- principle-id: standard-design-frame -->
<!-- principle-oneliner: Name the failure a constraint prevents before adding it. -->
<!-- principle-category: outcome-definition -->
<!-- principle-scope: universal -->
<!-- principle-tier: core -->
<!-- principle-tags: design, constraints, risk-treatment -->
■ Standard design frame (before significant design/fix): 1) Required Outcomes, 2) Non-Negotiable
Invariants, 3) Implementation Freedom/Change Tolerance, 4) Relaxation Risks, 5) Risk Treatment
(Prevent/Detect/Recover/Accept), 6) Constraint Cost. Before adding a constraint: name the specific
failure it prevents, that failure's impact, what it makes harder to change, whether a Stable Contract
could guarantee the same outcome instead, whether Detect/Recover/Accept would suffice instead of
Prevent. A constraint that can't name the specific failure it prevents should generally not be added.

<!-- principle-id: stable-contract-first -->
<!-- principle-oneliner: Prefer public APIs and stable contracts over incidental internals. -->
<!-- principle-category: coupling -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: api, coupling, refactoring -->
■ Stable Contract First: depend on things in priority order -- Public/Formal API > Formal Service
Interface > Formal Script/Command > Explicit Schema/Storage Contract > Internal Module Interface >
Process Structure > argv/wrapper/filesystem-layout incidental details. If a higher-level contract
achieves the goal, don't inspect/pin lower-level internals.

<!-- principle-id: deterministic-vs-heuristic -->
<!-- principle-oneliner: Use deterministic facts for gates; keep heuristics diagnostic unless justified. -->
<!-- principle-category: verification -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: gate, heuristics, determinism -->
■ Deterministic vs Heuristic: Deterministic (may gate): required check PASS, hash match, git ancestor,
backup service success, health OK, Review verdict, unique constraint. Heuristic (Warning/Diagnostic/
Investigation-trigger only, not a gate without explicit stated safety justification): process name,
argv, wrapper structure, filename-based inference, inferring runtime from source code patterns.

<!-- principle-id: honest-unverifiable -->
<!-- principle-oneliner: Report unverifiable claims honestly instead of turning guesses into PASS. -->
<!-- principle-category: verification -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: honesty, fail-closed, review -->
■ Honest about unverifiable: don't force something into "verified" via guesswork when there's no formal
interface to prove it. State NOT_VERIFIABLE / VERIFICATION_NOT_AVAILABLE / NOT_IMPLEMENTED where needed.
Prefer honest unverified state over false PASS from an incomplete heuristic.

<!-- principle-id: boundary-strictness -->
<!-- principle-oneliner: Keep security and data boundaries strict while preserving internal flexibility. -->
<!-- principle-category: safety -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: security, data-boundary, permissions -->
■ Boundary Strictness / Internal Flexibility: strict at Security, Authorization, Approval, Policy,
External Contract, Data Integrity, Idempotency, Evidence Freshness, safety-critical state transitions.
Flexible at helper composition, launchers, wrappers, process hierarchy, provider implementation, file
organization, internal algorithms, temporary representations. Few strong invariants; strict boundaries;
flexible internals.

<!-- principle-id: observable-behavior -->
<!-- principle-oneliner: Test observable behavior and invariants, not private structure. -->
<!-- principle-category: verification -->
<!-- principle-scope: universal -->
<!-- principle-tier: core -->
<!-- principle-tags: testing, invariants -->
■ Test principle: prefer observable behavior, final state, invariants, idempotency, error semantics,
recovery behavior. Avoid asserting exact internal call counts, private function structure, internal
call order, process topology. Example -- Bad: "internal function A is called 3 times." Better: "even
with 2 transient failures, exactly one final Job is created."

<!-- principle-id: review-integration -->
<!-- principle-oneliner: Extend existing review paths instead of creating duplicate review engines. -->
<!-- principle-category: scope-control -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: review, duplication, minimal-change -->
■ Design Review integration: survey existing Design Review; do not build a duplicate review engine;
integrate implementation_coupling / over_constraint / unverifiable_assumption checks (as defined above)
into the appropriate existing review path(s); investigate integration with the existing focus system
rather than adding a duplicate focus.

<!-- principle-id: scale-to-risk -->
<!-- principle-oneliner: Scale design detail to risk; do not force large templates onto small changes. -->
<!-- principle-category: scope-control -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: risk, proportionality, process-cost -->
■ Scale to risk: Lightweight (small local fix) -> brief Outcome/Invariant/coupling check. Standard
(normal feature/workflow change) -> Outcome/Invariant/Freedom/Risks/Constraint Cost. High Risk
(Production/Security/Approval/Policy/DB migration/Review Gate) -> review all items explicitly. Don't
force a giant template onto a small change.

<!-- principle-id: existing-code-grandfather -->
<!-- principle-oneliner: Grandfather existing code and improve it incrementally when touched. -->
<!-- principle-category: scope-control -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: migration, incrementalism -->
■ Existing code: don't mass-rewrite because this principle was introduced. Grandfather existing code;
improve incrementally on touch/incident/review-finding.

<!-- principle-id: observation-closes-loop -->
<!-- principle-oneliner: Deferring to observation requires a closed loop: metric, threshold, re-evaluation trigger and landing point. -->
<!-- principle-category: verification -->
<!-- principle-scope: universal -->
<!-- principle-tier: core -->
<!-- principle-tags: observation, feedback-loop, deferral, effect-verifiability -->
■ Deciding to "observe first and see how it goes" is a design deliverable, not a deferral. Whenever an
outcome is left to observation, specify as mechanically as the change allows: what is observed, the
measured value, where that value is recorded, the firing condition and its threshold, the re-evaluation
trigger, where the re-evaluation lands (review / finding / roadmap item), and the escalation condition if
one exists. Never rely on a human or an AI remembering to look later - an observation with no firing
condition is an unfalsifiable TODO. If no data path is worth building, state instead what will count as
done or effective, and state it in the same change. This clause is the mechanized form of the
effect-verifiability requirement (Design Philosophy #8, `docs/multi_ai_step_review_flow.md` 2-3);
it does not replace it. It applies to any system, team, or business, not only to this one.

<!-- principle-id: unknown-driven-staging -->
<!-- principle-oneliner: Stage by unknown, not by size: build the Target Capability directly unless a stage isolates a concrete unknown, risk, scale-dependent failure mode, or attribution benefit; never stage only by shrinking volume, cardinality, data, entity count, or scope. -->
<!-- principle-category: scope-control -->
<!-- principle-scope: universal -->
<!-- principle-tier: contextual -->
<!-- principle-tags: staging, mvp, spike, decomposition, iteration-tax -->
■ Unknown-Driven Staging / Direct-to-Target Capability. This is the staging form of
`standard-design-frame`: an intermediate stage is a constraint on the path, so it must name what it
prevents. It applies to milestones, task decomposition and implementation plans alike. An unjustified
stage is reported as `over_constraint` (sub-kind `unnecessary_staging`); it is not a separate review.
Default: if the Target Capability is known and the intermediate stage does not isolate a materially
different unknown or failure mode, implement the Target Capability directly. This is a default, not
"always run at Target Scale first".
A stage (MVP / Spike / phase / "first 1, then a few, then N") is justified only when it concretely
names at least one of: (1) an independent technical or external unknown; (2) a Safety / Security /
Data Integrity / Approval / Money boundary; (3) an irreversible or expensive failure; (4) a material
improvement in failure attribution; (5) a new scale-dependent failure mode; (6) evidence / contract /
fixture / adapter / benchmark the Target Capability itself reuses. "Smaller feels safer", "MVP",
"start with one as usual" or "phased seems safer" alone justify nothing.
Size is not an unknown: 1 -> N, one EA / Symbol / File / Account / Strategy -> many, small -> large
dataset, narrow -> broad scope do not by themselves justify a stage when the contract is unchanged
(e.g. 1 EA x 1 Symbol -> 1 EA x N Symbols -> N EA x N Symbols is one stage). Scale that introduces a
new failure mode, contract or resource boundary IS a capability / risk change and may be its own
stage: concurrency / races, queue / resume / retry, rate limits, memory / storage limits, timeouts,
ordering guarantees, partial failure, distributed coordination, transaction boundaries,
backpressure, cost explosion, scheduler contention, DB locking, observability boundaries (e.g. N EA x
N Symbols -> persistent job queue with resume / retry).
Iteration tax: a stage costs far more than code generation - task decomposition, delegation and
prompts, human confirmation, file delivery / patch application, review, regression test, deploy,
command execution, evidence / log collection, state synchronization, context switching. Remove a
stage whose risk benefit cannot be stated concretely against that tax.
Scale-down is primarily a diagnosis tool: when the Target Capability fails, shrinking toward a
minimal reproduction to isolate root cause is expected. A pre-emptive small-scale run is still
reasonable when it cheaply settles a specific scale-dependent unknown.
A Spike exists to turn a specific unknown into evidence at minimum cost, not to build a small
finished version; state its unknown, required evidence, pass / fail condition and effect on the
Target Capability. Do not stack further stages on an unknown that is already resolved.
Review questions: which unknown / risk does this stage resolve; what concrete failure risk rises if
it is dropped and the Target Capability is built directly; is it only a volume / cardinality /
scope reduction; does scale really add a failure mode; does it create a temporary contract / state
model / implementation that will be thrown away; is its output reused by the Target Capability;
would direct-to-target plus scale-down diagnosis on failure cost less in total; is its iteration tax
justified.

<!-- principle-id: home-and-criteria -->
This file is the authoritative home for the Outcome-Oriented Generalization Principle. Completion
criteria are satisfied when prompts and reviews select compact principle guidance by stable marker ID
instead of inlining this full document every time.
