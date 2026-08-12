# Decision-007: OpenCode Go統合作業からのLesson Candidate（MVP進行停止の教訓）

**Importance Level: 2**
**Status: lesson_candidate（正式Ruleではない）**
**Date: 2026-08-12**

---

## これは何か

これは正式な開発Decision/Ruleではなく、**Lesson Candidate**（教訓候補）の記録である。
将来Self Diagnosis Framework / Improvement Planner / Distill（`specs/13_future_system_architecture.md`
5b-4〜5b-10）が実装された段階で、本記録をEvidenceの1つとしてCEO Proposalの材料に使うことを想定する。
**本記録の内容を、この記録をもって直ちに正式Ruleとして適用しない。**

---

## Observation

OpenCode Go（DeepSeek V4 Flash系）をCheap AIとして接続するという比較的小さいMVP作業が、次のように拡大した。

- raw REST API（`https://opencode.ai/zen/go/v1/chat/completions`）が401 Invalid API keyを返す原因調査
- model / hosting policy（China-hosted opt-in等）の切り分け
- secret安全性確認（isolated HOME/workdir、env allowlist、permission:deny設定の検証）
- raw `fetch()`からCLI transportへの切り替え設計・実装・レビュー
- pnpm install環境問題（`allowBuilds`プレースホルダ不正、stale dev-serverプロセスによる長時間ハング）
- better-sqlite3のNODE_MODULE_VERSION不整合によるAPIテスト大量失敗の原因調査
- live smoke test（VPS上でのcold/warm実測）
- timeout値調整（30秒→60秒への変更とその実測根拠収集）

各確認自体には個別の合理性があったが、結果としてMVP本線（Cheap AI接続という本来のTask）の完了までの
所要時間が大幅に伸びた。

## Lesson Candidate

安全性・品質を損なわない代替経路（フォールバック）が確立した場合、MVP本線を長時間停止して根本原因調査を
継続せず、未解決の根本原因はbacklog / future investigationとして残し、本線を再開することを優先する。

## Exception（安易に後回しにしない対象）

以下に該当する場合は、フォールバックが確立していても調査打ち切りを自動適用しない。

- secret漏洩疑い
- DB破損 / データ喪失
- Trust Boundary破綻
- security incident
- 高確率で再発する重大障害
- 後回しにすると安全性・品質を維持できない問題

## Status

これは現時点では**正式な開発Ruleではなく「Lesson Candidate」**である。

正式Rule化する場合は、将来実装されるSelf Diagnosis / Improvement Planner / Distill等の自己改善ループを
通じてCEO Proposalとして提示し、CEOの明示承認後にのみOperationalize（Rule / Prompt / Workflow /
Roadmap等への正式反映）する（`specs/13_future_system_architecture.md` 5b-5の改訂内容を参照）。
本記録自体はConstitutionやWorkflowへ即座に正式Ruleとして追加するものではない。

---

*Created by: Claude Code — OpenCode Go Cheap AI統合作業の振り返り（CEO指示によるLesson Candidate記録）*
