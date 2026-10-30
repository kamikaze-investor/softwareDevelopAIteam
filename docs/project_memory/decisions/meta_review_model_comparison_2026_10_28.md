# Meta Review model comparison (Gemini / Codex / Claude) — 2026-10-28

**Status:** measurement record. **No production change.**
- The Meta Review model stays `gemini-2.5-flash`.
- M4 stays disabled.
- No Q2 Registry was added.

## Why
The CEO asked for a fair comparison of Gemini, Codex and Claude as the Meta Review model, and of how to pair implementer and reviewer AIs. It had to reuse the M5 assets: frozen labels, the PR #404 case, mutants, prompts and scoring.

## Conditions
- **Items:** 70, listed in `apps/worker/scripts/materiality-eval/compare-items-2026-10-27.json`:
  - 4 known positives;
  - 13 mutants;
  - all 11 narrow-label positives;
  - 20 seeded random not-at-risk commits;
  - 22 repeat runs.
- **Prompts:** detection `9ebe1bbbbd5e`, evaluation `d4cd72c253e5` (the M5 versions). Diffs, record excerpts, criteria and output format are byte-identical across models.
- **Models:**

  | Model | Version | How it ran |
  |---|---|---|
  | Gemini | `gemini-2.5-flash`, temperature 0.1 | M5 final workflow run 40456487451; no new calls |
  | Codex | `gpt-5.6-sol@medium`, codex-cli 0.146.0 | existing ChatGPT login |
  | Claude | `claude-sonnet-5-5`, Claude Code 2.1.308 | existing claude.ai login |

- **Tool use:** 0 in every run.
- **Bias:**
  - The frame labels were produced by `gpt-5.6-sol`, so Codex's agreement with them is inflated.
  - The **mutants are the unbiased ground truth.**
  - Codex carried about 4–13k tokens of its own agent instructions per call. Claude's system prompt was replaced by a one-line neutral prompt.
- **Raw scoring fields:** `apps/worker/scripts/materiality-eval/model-compare-2026-10-28.json`.

## Results
| Metric | Gemini | Codex | Claude |
|---|---|---|---|
| Mutant + positive runs flagged, current rule (unbiased) | 26/36 | 25/36 | 28/36 |
| Wrong flags on negative mutants (rename / test / comment) | 0/3 | 0/3 | 0/3 |
| Not-at-risk commits flagged, current rule | 12/20 | 12/20 | 10/20 |
| Narrow positives / not-at-risk flagged, `reversal_only` rule | 5/11, 6/20 | 8/11 (biased), 5/20 | 10/11, 5/20 |
| Disabling without deletion: early return / handler remap / writer no-op / consumer no-op | 1 of 2 valid / 0/3 / 1/3 / 1/3 | 0/3 / 0/3 / 1/3 / 0/3 | 2/3 / 0/3 / 2/3 / 0/3 |
| Unavailable (format / API) | 3/70 | 0/70 | 0/70 |
| Flag flips across 11 repeated items | 4 | 1 | 2 |
| Latency p50 | 42 s | 50 s | 45 s |
| Tokens per item (p50) | 18k | 43k | 23k |
| Cost | ~$0.03 per PR (API) | subscription quota | ~$0.20 per item API-equivalent (subscription quota) |

- **Gap between models:** 2–3 of 36 unbiased runs, which is not significant at this sample size.

## Errors shared by all three models
**Classified as record retrieval or criteria, not as model error.**
- **Misses:** m03 handler remap and m04b consumer no-op. The removed responsibility's roadmap passage is not in the excerpts, because the changed lines lack its tokens. This is **record retrieval**.
- **False flags:**
  - Under the current rule, 8 of 20 not-at-risk commits are flagged by all three. They are additive changes, or changes that updated their record in the same PR.
  - The triggers are "CEO-directed area" treated as a reversal, and authority-boundary edits that DA and CODEOWNERS already cover.
  - This is **criteria**.
- **Under `reversal_only`:**
  - 714b1bb7 (a narrowed CEO-approval trigger) is missed. That is criteria/provenance.
  - feb4dffc is missed because the rule excludes additions. That is criteria.

## Decision and recommendation
- **Keep Gemini** as the production Meta Review model. No measured gain justifies a new CI credential or billing; Codex or Claude in CI would need an API key, which is a CEO decision.
- **Pairing:**
  - **Normal changes:** the existing Gemini Meta Review only.
  - **Important changes** (Level 2–3, CODEOWNERS/DA paths, removing or disabling a responsibility): Gemini Meta Review plus an advisory local independent Challenger from a different vendor than the implementer.
    - Claude reviews Codex-implemented changes; it is strongest on disabling without deletion.
    - Codex reviews Claude-implemented changes.
  - The CEO keeps the DA decision.
- **Next step with no model change**, re-measured with the same harness:
  - `reversal_only`;
  - provenance only from pre-existing records that name a CEO decision for that responsibility;
  - record retrieval that follows a removed symbol to its roadmap or decision passage.

## Evaluator security review (PR #426)
The base-run Meta Review BLOCKED the CLI providers as a permissionGuard bypass, DA (2) and a sandbox removal.

**Independent Codex review (gpt-5.6-sol, high): approved.**
- permissionGuard / commandResolver / SafeCommand govern Worker Job commands (`jobRunner.ts`). Production AI CLIs already run outside them by design (`aiCli/adapter.ts`).
- The evaluator cannot be reached from the Worker/API build (`tsconfig` include is `src`), the Dockerfile, or CI (`materiality-eval.yml` passes no `--provider`).
- No Approval Tuple changes, so no DA trigger applies.

**A real gap was found and fixed:** Codex's read-only sandbox had left the user-config plugins, MCP apps, browser use and file reads available to a prompt built from untrusted diffs. Fixes:
- Codex runs with user config and rules ignored and its tool features disabled.
- The CLI environment is allowlisted.
- Tool use or a nonzero exit fails closed.
- Model and effort arguments are allowlisted.

**SafeCommand is not the right abstraction here.** Using it would mean adding a model-CLI CommandKind to the production Job protocol.
