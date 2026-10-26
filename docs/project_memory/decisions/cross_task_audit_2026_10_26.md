# Cross-Task Audit 2026-10-26（Production deploy d7b3ee15 → 97567fd1）

<!-- cross-task-audit base=d7b3ee15795f2f445ae768d7b8165bdb9e46ea17 head=97567fd1b4883ecf81dd07bfbf1bc364c705d335 -->

**Importance Level: 2**
**Status: active**

手順と判断基準は `cross_task_drift_audit_design.md`。本記録は 1 回目の監査で、上の marker が chain の起点になる
（次回の window は `97567fd1..` から始まる。本記録を入れる PR は window から除外される）。

## 1. Window と発火

| 項目 | 値 |
|---|---|
| window | `d7b3ee15..97567fd1`（first-parent master、12 変更 = #395〜#408） |
| 境界 | 2026-10-22 の Production deploy（d7b3ee15）から 2026-10-26 の Production deploy（97567fd1）まで |
| 発火理由（`evaluateDue()`） | deploy boundary 97567fd1 / fix chain: #408 が #403・#404・#407 を引用 / CODEOWNERS surface を 2 変更が触った（#405 `gitCommitEvidence.ts`・`approvalGate.ts`、#408 `specs/22`） |
| churn 上位（lift） | `apps/mobile/lib/taskAbort.ts` 50.2、`apps/api/src/pl/conflictResolutionStep.ts` 16.7、`apps/api/src/pl/remediationStep.ts` 10.8、`apps/mobile/app/approvals.tsx` 10.0、`apps/mobile/app/tasks/[id].tsx` 7.5、`executionLoop.ts` 1.3 |
| window 内で増えた budget / cap / timeout 定数 | 9（`PL_MAX_TECHNICAL_FAILURES_PER_STAGE`、`PL_MAX_LIFETIME_TECHNICAL_FAILURES_PER_STAGE`、`CONFLICT_RECOVERY_RUNNER_TIMEOUT_MS`、`SAFE_COMMAND_TIMEOUT_*` 等） |
| packet | 88,944 文字、hotspot 6 ファイルの combined diff を全部収載、**切り捨て 0** |
| Production observation | **未提供**（production の読み取りは auto-mode classifier で止まるため）。`production_divergence` は uncertain |
| Challenger | 1 回。PL の推論を渡さない別 context の Claude（Codex は本 account で全 model `model_not_found`、OpenCode Go は model 0 件。**vendor 分離なし**） |

## 2. Finding と処分

| id | 問い | 重大度 | routing（機械） | PL の確認 | 処分 |
|---|---|---|---|---|---|
| `xta-d7b3ee1-01` | duplicate_owner | medium | technical | **確認**（master `c6be983c` で `classifyConflictRecoveryRow()` と `isArtifactRow()` を読んで一致） | 採用 → `conflict-recovery-judgment-owner-split` |
| `xta-d7b3ee1-02` | surviving_failure_class | medium | technical | **確認**（01 の帰結。flagship 候補は2つ） | 採用 → 同上（Acceptance Criteria の先頭） |
| `xta-d7b3ee1-03` | cross_layer_reinterpretation | low | technical | **確認**（`nextDriver()` は `hasRemediationBudgetLeft()`、PL は `selectConflictStage()`） | 採用 → 同上 |
| `xta-d7b3ee1-04` | unnecessary_mechanism | low | technical | 未検証 | 採用 → 同上（着手時に確認して結果を書く） |

- **checkedClean**: incidental_representation / principle_contradiction / authority_tuple_drift / complexity_growth
  （Challenger 申告: abort 1-tap と specs/22 追記の authority drift は軽く見ただけ）
- **uncertain**: production_divergence（観測データ未提供）
- **DA 候補: 0 件**。CODEOWNERS surface に当たる evidence も、approval / authority を語る claim も無かった。CEO へ上げるものは無い
- **false positive**: 0 件（4 件中 3 件をコードで確認、1 件は未検証のまま）

**所見**: per-Task review は CONFLICT recovery の 4 PR（#403・#404・#407・#408）をそれぞれ通している。
02 は #404 が `runner_failed` について閉じた停止が、#408 の会計変更で別 outcome に**移った**もので、1 PR ずつ見る限り
どちらの PR にも誤りは無い。設計時に想定した「組合せでだけ見える欠陥」の実例である。

## 3. 前回 finding の追跡 / escaped

初回のため無し。

## 4. 仕組みについての観測（3 回目の評価の材料）

- 発火: 3 条件すべてが同時に成立した。deploy 境界が無くても fix chain だけで発火していた
- churn の lift 順位は、手で選ぶなら選んだはずのファイル（CONFLICT recovery と Mobile abort）を上位に出し、hub の `executionLoop.ts` を最下位にした
- 2 層以上に新しく現れた literal: 0 件（この window では信号にならなかった）
- コスト: Challenger 1 回、packet 89k 文字
- **ledger の遅れを 1 件観測**（問いの対象外）: `termination-guarantee-audit` は記録が #397 で merge 済みなのに `state=planned` のまま。
  roadmap の `state=done` を発火に使わなかった理由（設計 4 章）の実例でもある
