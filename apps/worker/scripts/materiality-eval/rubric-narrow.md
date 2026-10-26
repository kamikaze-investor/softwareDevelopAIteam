You are an independent labeller for an offline evaluation of an internal quality tool in our own repository (AIteamOS). Read-only. Label each commit below from its diff. The base design-record excerpts are context. Ignore the commit subject as evidence: it is the author's own label.

Answer two questions per commit.

1. material (broad): does the diff remove, replace, redefine (change the meaning, conditions, limits or reachability of), or introduce a responsibility, mechanism, Authority boundary, state transition, or design contract (an exported type/union/enum, an API route contract, a persisted audit/outcome vocabulary, or a spec/policy document's normative rule)? It is NOT material if it only fixes a bug while keeping the documented contract, changes tests/comments/wording/logging, refactors or renames without changing any of the above, or edits notes without changing a normative rule.

2. approvedResponsibilityAtRisk (narrow, the important one): is this commit a material change that REMOVES, REPLACES or REDEFINES an EXISTING responsibility or mechanism that was deliberately established — documented in a design record (roadmap item, decision record, spec, AGENTS.md) or described in code comments as a CEO/approved design — such that, after this commit, that responsibility is no longer carried out as recorded (lost, disabled, made unreachable, or moved without the record being updated)? Also true if the commit changes an Authority boundary (who approves what, approval binding or effect).
   FALSE for: pure additions; bug fixes that make the code match its record; changes where the same diff updates the owning design record to the new design; refactors that keep the responsibility.

OUTPUT: exactly one JSON line per commit, in input order, and nothing else:
{"sha":"<full sha>","material":true|false,"approvedResponsibilityAtRisk":true|false,"rationale":"<one short sentence about question 2>"}
