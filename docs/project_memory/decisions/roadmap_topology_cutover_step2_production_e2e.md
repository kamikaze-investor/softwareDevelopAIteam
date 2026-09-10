# Step 2 完了記録 — Roadmap topology cutover の Production E2E

**日付**: 2026-09-10
**deploy**: `bd6be44`
**Project**: "Production E2E test 3" (`f74d721f`)
**判定**: **Step 2 DONE**（CEO確認済み）

これは回帰記録である。ここに書いてあるのは「通ったこと」ではなく、
**何を根拠に通ったと判断したか**である。次に壊れたとき、同じ根拠を再取得して比較する。

---

## 切り替えた内容

```
旧: Claude Haiku Generator → Gemini reviews    → Codex independent review
新: Codex gpt-5.6-sol/xhigh → Gemini focused ×3 → Claude claude-opus-5 integration
```

Roadmap kind のみ変更。**task kind の topology は変更していない**
（Gemini + Codex independent、task-kind Claude gate も維持）。

generator を変えた理由はモデルの好みではない。Anthropic SDK 経由のモデルは
**ファイルを開けない**ため、旧 generator は対象リポジトリを一度も見ずに計画していた。
Codex CLI は `-C <target repo>` を読みながら計画できる。

---

## 実測した証拠（Production、通常のMobile Start入口から）

| 確認項目 | 証拠 |
|---|---|
| Roadmap生成attempt数 | **1回**（retry不要。parse失敗ログ0件） |
| generator = `gpt-5.6-sol` / `xhigh` | 生成時の実argv |
| Codexが実repoを読んだ | Roadmapが `test.js` を対象にし `allowedPaths: ["test.js"]`。**promptに無いrepo固有事実** |
| Codexがrepoを書き換えていない | capture artifact無し。Codex由来のcommit無し |
| Gemini focused ×3 | Claude自身のprompt内に3件のALIGNED（strategic_alignment / scope_simplicity / architecture_responsibility） |
| Claude finalが `claude-opus-5` | 実プロセスargv `claude --print … --model claude-opus-5` |
| integration reviewであること | prompt: "Review only the combination of focused review outcomes" |
| **旧Roadmap Codex independentが走っていない** | evidence行 `independent_review_required = 0` / `independent_review_verdict = null` |
| deterministic decision | evidence `decision = ALIGNED` / `review_load = critical` / run `succeeded` / `attempt_count = 1` |
| Task syncがRoadmapと一致 | Task 1件・`roadmap_active = 1` |
| dependency未達TaskへJobを先行作成しない | `deps = []` で即eligible。未達Taskは存在しない |
| **first real Job** | implement Job `cb18e687` → **success** |
| start_stageが実工程と一致 | `roadmap_generation → deterministic_validation → focused_review → task_sync → completed` |
| `integration_review` / `feasibility_review` | **発火せず**（APIから観測できない境界／OpenCode保留のため意図的） |
| secret/token/env | 出力に無し |

### DONE条件より先まで進んだ部分

implement成功後、review Job（`qa_ai`）成功 → `git_commit` Job が Approval Gate で
`WAITING_FOR_USER` / `risk_level = LOW` で停止。CEO承認後に commit 成功
（`0483536 test.jsに目的説明コメントを追加`、`changed_files = ["test.js"]`）、
target repo は clean、approval は `CONSUMED`、Task は `done`。

---

## 到達までに直した実際の不具合

**1. cutoverが起動不能だった（PR C review指摘）**
Worker が roadmap kind の Codex independent review を作らなくなったのに、API 側 2箇所
（`designReviewCoordinator` の recompute と `designReviewEvidencePolicy`）が依然それを要求していた。
全 Gemini + Claude が ALIGNED でも API が UNCERTAIN を再計算し evidence を登録せず Project は blocked。
**新 topology は一度も成立しない状態だった。** requirement を kind-aware にして解消。

**2. review gateを迂回できるproduction routeが存在した**
`POST /api/cto/generate-roadmap` が `writeProjectMemory` 無しで `initializeApprovedProject()` を呼び、
review を一切通さず Task sync まで到達できた。consumer は自身のテストのみだったため **route を削除**。
`writeProjectMemory` を渡す修正はしていない（同一 workflow への入口が2つ残ると drift 源になる）。

**3. Roadmap生成の1フィールド型違いでProject startが即死していた**
Codex が `estimatedWeeks` を小数で返し、schema parse が throw。その例外が bounded regeneration loop の
**外**を通っていたため、retry上限3回が一度も使われず BLOCKED。2日にわたり2回再現。
生成失敗も既存 loop で扱うようにし、parse error を feedback として次 attempt へ渡す。
**ただし retry するのは `RoadmapContentError`（JSON not found / JSON.parse失敗 / schema不一致）だけ**で、
ProviderSeparationError・quota/auth/timeout/CLI・infrastructure・programming/abort は
attempt を消費せず原型のまま伝播する。判定は message 一致ではなく型で行う。

---

## 残っている制約（DONEに含めていない）

- **retry経路はproductionで未発動**。今回は1回目が valid だったため、実際の float に対しては未検証。
- **「Mobileを閉じてもProject全体が自律完走する」ことは未証明。**
  `continuation-get-liveness-dependency` が未解決のため、CEO判断で Step 2 の DONE 条件から除外している。
  解消後に「Mobile を閉じる → Task実行 → review → commit → continuation → 次Task → Project完了」の
  完全 E2E を別途行う。
- **Landlock は暫定経路**。`use_legacy_landlock=true` は deprecated であり、Codex の upgrade 一回で
  失われうる（roadmap: `codex-sandbox-off-deprecated-landlock`）。
- **task kind の Codex reviewer は周辺 repo を読めていない**（別課題として登録済み）。

---

## 次に壊れたときの再取得手順

1. `design_review_evidence` の該当 subject 行 — `decision` / `independent_review_required`
2. `design_review_runs` — `status` / `attempt_count`
3. review 実行中の `ps -u ai-team -o etime,cmd` — Claude の実 argv に `--model claude-opus-5` があるか
4. API ログの生成 argv — `gpt-5.6-sol` / `xhigh` / `use_legacy_landlock`
5. 生成された Roadmap に **prompt に無い repo 固有の file/function 名**が入っているか
6. `/workspace/target` の `git status` と capture artifact の有無
