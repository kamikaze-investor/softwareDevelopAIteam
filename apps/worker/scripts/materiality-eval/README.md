# Materiality M5 evaluation data (frozen 2026-10-23)

Labels for the M5 offline evaluation of `apps/worker/src/metaReviewer/designMateriality.ts`.
They were frozen **before** any detector run, and the detector never reads them.

- **Frame:** the last 300 first-parent commits of master at `bbe3b746`. The stratum F (any S1–S4 fired) is a census of 55 commits. The stratum N (no signal fired) is 80 of 245 commits, sampled with seed `20261023`. Regenerate it with `designMaterialityEval.ts frame --head bbe3b746`.
- **Labeller:** Codex Sol. It saw the diff (capped at 20k chars per commit) and base design-record excerpts, but no detector output.
  - First pass: `rubric-broad.md` (`material`, `introducesOnly`).
  - Second pass: `rubric-narrow.md` (`approvedResponsibilityAtRisk`, plus `material` again).
  - The two passes agreed on `material` for 125 of 134 commits. `secondPassOnly` marks the one commit the first pass did not return.
- **Use:** `designMaterialityEval.ts score --labels apps/worker/scripts/materiality-eval/labels-2026-10-23.json`.

## Running M5 (manual workflow)

`materiality-eval.workflow.yml` is the reviewed workflow for running `detect` on the existing `GEMINI_API_KEY` repo secret. It has gone through three independent review rounds and the last one approved it.

The AI bot's GitHub token deliberately has no `workflow` scope, so a human (the Code Owner) installs the file:

1. Copy the file unchanged to `.github/workflows/materiality-eval.yml` on master. The file is inert at its current path.
2. Trial run: Actions → "Materiality M5 evaluation (manual)" → Run workflow with `max_calls` = 4.
3. Full run: repeat with `max_calls` = 60, passing the previous run id as `previous_run_id` each time, until the step summary says `complete`.

**Bounds** (enforced by the workflow and the evaluator):
- one run at a time;
- at least 20 s between calls;
- 1–60 calls per run;
- an immediate stop on any quota, billing or auth error;
- waiting while a Meta Review run is queued or in progress.

The key reaches only the detect step. It never appears in logs, artifacts or results.
