# Outcome-Oriented Generalization Principle

<!-- principle-id: evidence-not-spec -->
<!-- principle-oneliner: Define required outcomes first; current implementation is evidence, not specification. -->
■ Top-level principle: define "what must ultimately be guaranteed for this to be a success" before "how
to implement it." Within Required Outcomes / Non-Negotiable Invariants, preserve maximum Implementation
Freedom. Current implementation is evidence, not specification. Priority: Goal -> Design Philosophy ->
Policy/Approval Policy -> Required Outcomes -> Non-Negotiable Invariants -> Stable Contract -> Current
Implementation.

<!-- principle-id: standard-design-frame -->
<!-- principle-oneliner: Name the failure a constraint prevents before adding it. -->
■ Standard design frame (before significant design/fix): 1) Required Outcomes, 2) Non-Negotiable
Invariants, 3) Implementation Freedom/Change Tolerance, 4) Relaxation Risks, 5) Risk Treatment
(Prevent/Detect/Recover/Accept), 6) Constraint Cost. Before adding a constraint: name the specific
failure it prevents, that failure's impact, what it makes harder to change, whether a Stable Contract
could guarantee the same outcome instead, whether Detect/Recover/Accept would suffice instead of
Prevent. A constraint that can't name the specific failure it prevents should generally not be added.

<!-- principle-id: stable-contract-first -->
<!-- principle-oneliner: Prefer public APIs and stable contracts over incidental internals. -->
■ Stable Contract First: depend on things in priority order -- Public/Formal API > Formal Service
Interface > Formal Script/Command > Explicit Schema/Storage Contract > Internal Module Interface >
Process Structure > argv/wrapper/filesystem-layout incidental details. If a higher-level contract
achieves the goal, don't inspect/pin lower-level internals.

<!-- principle-id: deterministic-vs-heuristic -->
<!-- principle-oneliner: Use deterministic facts for gates; keep heuristics diagnostic unless justified. -->
■ Deterministic vs Heuristic: Deterministic (may gate): required check PASS, hash match, git ancestor,
backup service success, health OK, Review verdict, unique constraint. Heuristic (Warning/Diagnostic/
Investigation-trigger only, not a gate without explicit stated safety justification): process name,
argv, wrapper structure, filename-based inference, inferring runtime from source code patterns.

<!-- principle-id: honest-unverifiable -->
<!-- principle-oneliner: Report unverifiable claims honestly instead of turning guesses into PASS. -->
■ Honest about unverifiable: don't force something into "verified" via guesswork when there's no formal
interface to prove it. State NOT_VERIFIABLE / VERIFICATION_NOT_AVAILABLE / NOT_IMPLEMENTED where needed.
Prefer honest unverified state over false PASS from an incomplete heuristic.

<!-- principle-id: boundary-strictness -->
<!-- principle-oneliner: Keep security and data boundaries strict while preserving internal flexibility. -->
■ Boundary Strictness / Internal Flexibility: strict at Security, Authorization, Approval, Policy,
External Contract, Data Integrity, Idempotency, Evidence Freshness, safety-critical state transitions.
Flexible at helper composition, launchers, wrappers, process hierarchy, provider implementation, file
organization, internal algorithms, temporary representations. Few strong invariants; strict boundaries;
flexible internals.

<!-- principle-id: observable-behavior -->
<!-- principle-oneliner: Test observable behavior and invariants, not private structure. -->
■ Test principle: prefer observable behavior, final state, invariants, idempotency, error semantics,
recovery behavior. Avoid asserting exact internal call counts, private function structure, internal
call order, process topology. Example -- Bad: "internal function A is called 3 times." Better: "even
with 2 transient failures, exactly one final Job is created."

<!-- principle-id: review-integration -->
<!-- principle-oneliner: Extend existing review paths instead of creating duplicate review engines. -->
■ Design Review integration: survey existing Design Review; do not build a duplicate review engine;
integrate implementation_coupling / over_constraint / unverifiable_assumption checks (as defined above)
into the appropriate existing review path(s); investigate integration with the existing focus system
rather than adding a duplicate focus.

<!-- principle-id: whole-artifact-consistency -->
<!-- principle-oneliner: Before declaring multi-fix work done, check the whole artifact once against accepted outcomes and invariants — not just the latest diff — then stop. -->
■ Whole-Artifact Consistency Before Completion: incremental fixes that are each locally correct do not
guarantee the final artifact is correct as a whole. Once a round of fixes is otherwise complete, before
declaring completion, check the whole artifact — not just the latest diff — once against every
previously accepted Required Outcome, Non-Negotiable Invariant, and explicitly accepted requirement for
this task. Look specifically for: an earlier accepted requirement that has since disappeared, a later
fix that silently reverted an earlier one, a stale value or stale assumption left behind by an earlier
step, a change that is locally correct but breaks the overall outcome, and contradictions between
successive fixes. This is a single bounded check, not a license for repo-wide re-investigation, new
design, a new Gate, a repeated review loop, or scope expansion. Applies identically to Developer AI
self-completion judgment, PL completion judgment, and Reviewer guidance — one authoritative source, not
three. If every accepted outcome and invariant is satisfied, stop there; do not use this check as a
reason to start additional improvement.

<!-- principle-id: scale-to-risk -->
<!-- principle-oneliner: Scale design detail to risk; do not force large templates onto small changes. -->
■ Scale to risk: Lightweight (small local fix) -> brief Outcome/Invariant/coupling check. Standard
(normal feature/workflow change) -> Outcome/Invariant/Freedom/Risks/Constraint Cost. High Risk
(Production/Security/Approval/Policy/DB migration/Review Gate) -> review all items explicitly. Don't
force a giant template onto a small change.

<!-- principle-id: existing-code-grandfather -->
<!-- principle-oneliner: Grandfather existing code and improve it incrementally when touched. -->
■ Existing code: don't mass-rewrite because this principle was introduced. Grandfather existing code;
improve incrementally on touch/incident/review-finding.

<!-- principle-id: home-and-criteria -->
This file is the authoritative home for the Outcome-Oriented Generalization Principle. Completion
criteria are satisfied when prompts and reviews select compact principle guidance by stable marker ID
instead of inlining this full document every time.
