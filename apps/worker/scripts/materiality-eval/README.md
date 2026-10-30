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

`detect` runs in a manually dispatched GitHub Actions workflow (`.github/workflows/materiality-eval.yml`) that uses the existing Gemini API key repo secret. That workflow went through three independent review rounds and the last one approved it.

The workflow file is **not part of this directory**. The AI bot's GitHub token deliberately has no `workflow` scope, so the Code Owner adds the reviewed file in a PR of their own.

1. Trial run: Actions → "Materiality M5 evaluation (manual)" → Run workflow with `max_calls` = 4.
2. Full run: repeat with `max_calls` = 60, passing the previous run id as `previous_run_id` each time, until the step summary says `complete`.

**Bounds** (enforced by the workflow and the evaluator):
- one run at a time;
- at least 20 s between calls;
- 1–60 calls per run;
- an immediate stop on any quota, billing or auth error;
- waiting while a Meta Review run is queued or in progress.

The API key reaches only the detect step. It never appears in logs, artifacts or results.

## Model comparison (local CLI providers)

`detect --provider codex|claude` sends the same prompts, diffs and record excerpts to another model through an existing local login. It is used only for offline model comparison and is run by an operator on their own machine. CI and `materiality-eval.yml` never pass `--provider`, so they always use Gemini.

```bash
# from apps/worker; frame.json and mutants.json copied into OUT first
tsx scripts/designMaterialityEval.ts detect --provider codex --model gpt-5.6-sol --effort medium \
  --repo <repo> --out <OUT> --items scripts/materiality-eval/compare-items-2026-10-27.json --max-calls 150 --min-interval-ms 20000
CLAUDE_CLI=<path to claude executable> tsx scripts/designMaterialityEval.ts detect --provider claude --model claude-sonnet-5-5 \
  --repo <repo> --out <OUT> --items scripts/materiality-eval/compare-items-2026-10-27.json --max-calls 150 --min-interval-ms 20000
```

**Isolation.** The prompt carries repository diffs, which are untrusted text:
- **Working directory:** each CLI runs in an empty temporary directory.
- **Environment:** the child process gets an allowlisted environment, so other credentials are not inherited.
- **Codex:** `--ignore-user-config --ignore-rules --sandbox read-only --ephemeral`, with shell, apps, plugins, browser and computer use disabled.
- **Claude:** `--tools "" --strict-mcp-config --disable-slash-commands --no-session-persistence` and a neutral system prompt.
- **Stopping:** any tool use or permission denial discards the response and stops the run (`policy`). A nonzero exit is an error. Quota and auth stop the run as for Gemini.

**Data.**
- `compare-items-2026-10-27.json`: the 70 items.
- `model-compare-2026-10-28.json`: the scoring fields of every observation, for all three models.
- Results: `docs/project_memory/decisions/meta_review_model_comparison_2026_10_28.md`.
