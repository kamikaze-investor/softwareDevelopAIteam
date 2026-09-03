# Outcome-Oriented Generalization Principle

<!-- principle-id: evidence-not-spec -->
■ Top-level principle: define "what must ultimately be guaranteed for this to be a success" before "how
to implement it." Within Required Outcomes / Non-Negotiable Invariants, preserve maximum Implementation
Freedom. Current implementation is evidence, not specification. Priority: Goal -> Design Philosophy ->
Policy/Approval Policy -> Required Outcomes -> Non-Negotiable Invariants -> Stable Contract -> Current
Implementation.

<!-- principle-id: standard-design-frame -->
■ Standard design frame (before significant design/fix): 1) Required Outcomes, 2) Non-Negotiable
Invariants, 3) Implementation Freedom/Change Tolerance, 4) Relaxation Risks, 5) Risk Treatment
(Prevent/Detect/Recover/Accept), 6) Constraint Cost. Before adding a constraint: name the specific
failure it prevents, that failure's impact, what it makes harder to change, whether a Stable Contract
could guarantee the same outcome instead, whether Detect/Recover/Accept would suffice instead of
Prevent. A constraint that can't name the specific failure it prevents should generally not be added.

<!-- principle-id: stable-contract-first -->
■ Stable Contract First: depend on things in priority order -- Public/Formal API > Formal Service
Interface > Formal Script/Command > Explicit Schema/Storage Contract > Internal Module Interface >
Process Structure > argv/wrapper/filesystem-layout incidental details. If a higher-level contract
achieves the goal, don't inspect/pin lower-level internals.

<!-- principle-id: deterministic-vs-heuristic -->
■ Deterministic vs Heuristic: Deterministic (may gate): required check PASS, hash match, git ancestor,
backup service success, health OK, Review verdict, unique constraint. Heuristic (Warning/Diagnostic/
Investigation-trigger only, not a gate without explicit stated safety justification): process name,
argv, wrapper structure, filename-based inference, inferring runtime from source code patterns.

<!-- principle-id: honest-unverifiable -->
■ Honest about unverifiable: don't force something into "verified" via guesswork when there's no formal
interface to prove it. State NOT_VERIFIABLE / VERIFICATION_NOT_AVAILABLE / NOT_IMPLEMENTED where needed.
Prefer honest unverified state over false PASS from an incomplete heuristic.

<!-- principle-id: boundary-strictness -->
■ Boundary Strictness / Internal Flexibility: strict at Security, Authorization, Approval, Policy,
External Contract, Data Integrity, Idempotency, Evidence Freshness, safety-critical state transitions.
Flexible at helper composition, launchers, wrappers, process hierarchy, provider implementation, file
organization, internal algorithms, temporary representations. Few strong invariants; strict boundaries;
flexible internals.

<!-- principle-id: observable-behavior -->
■ Test principle: prefer observable behavior, final state, invariants, idempotency, error semantics,
recovery behavior. Avoid asserting exact internal call counts, private function structure, internal
call order, process topology. Example -- Bad: "internal function A is called 3 times." Better: "even
with 2 transient failures, exactly one final Job is created."

<!-- principle-id: review-integration -->
■ Design Review integration: survey existing Design Review; do not build a duplicate review engine;
integrate implementation_coupling / over_constraint / unverifiable_assumption checks (as defined above)
into the appropriate existing review path(s); investigate integration with the existing focus system
rather than adding a duplicate focus.

<!-- principle-id: scale-to-risk -->
■ Scale to risk: Lightweight (small local fix) -> brief Outcome/Invariant/coupling check. Standard
(normal feature/workflow change) -> Outcome/Invariant/Freedom/Risks/Constraint Cost. High Risk
(Production/Security/Approval/Policy/DB migration/Review Gate) -> review all items explicitly. Don't
force a giant template onto a small change.

<!-- principle-id: existing-code-grandfather -->
■ Existing code: don't mass-rewrite because this principle was introduced. Grandfather existing code;
improve incrementally on touch/incident/review-finding.

<!-- principle-id: home-and-criteria -->
This file is the authoritative home for the Outcome-Oriented Generalization Principle. Completion
criteria are satisfied when prompts and reviews select compact principle guidance by stable marker ID
instead of inlining this full document every time.
