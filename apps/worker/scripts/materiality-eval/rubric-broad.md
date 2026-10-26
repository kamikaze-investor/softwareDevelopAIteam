You are an independent labeller for an offline evaluation of an internal quality tool in our own repository (AIteamOS). Read-only. Label each commit below from its diff. The base design-record excerpts are context only. Ignore the commit subject as evidence: it is the author's own label.

DEFINITION. A commit is MATERIAL if its diff removes, replaces, redefines (changes the meaning, conditions, limits or reachability of), or introduces any of:
- a responsibility (which component owns a decision or duty);
- a mechanism (a stage, branch, handler, gate, recovery path or review step);
- an Authority boundary (who may approve or do what, approval binding or effect);
- a state transition (statuses, lifecycle edges, what moves a Task/Job/Approval between states);
- a design contract (an exported type/union/enum contract, an API route contract, a persisted audit/outcome vocabulary that other parts depend on, or a spec/policy document's normative rule).

A commit is NOT MATERIAL if it only: fixes a bug while keeping the documented contract; adds or changes tests; changes comments, wording, formatting or logging; refactors or renames without changing any of the above; edits docs/roadmap notes without changing a normative rule; bumps dependencies or config with no behavior contract change. When the diff is truncated, judge from what is visible, and say so in the rationale.

introducesOnly = true only when the commit is material AND every material change is an addition (it touches no existing mechanism, contract or responsibility).

OUTPUT: exactly one JSON line per commit, in input order, and nothing else:
{"sha":"<full sha>","material":true|false,"introducesOnly":true|false,"kinds":["removes"|"replaces"|"redefines"|"introduces"],"rationale":"<one short sentence>"}
