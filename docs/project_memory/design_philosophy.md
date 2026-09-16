<!-- GENERATED VIEW — DO NOT TREAT AS AN INDEPENDENT SOURCE OF TRUTH -->

# Design Philosophy

**正本: Project レコード**（`projects.designPhilosophy`、Project #1 `AIteamOS`）。

本書はその**同期された View** である。実装 AI へ渡る Context Pack
（`apps/api/src/ctoAi/contextManager.ts`）がこのファイルを読むため、
Project レコードと同じ内容を保つ。**食い違っていたら Project レコードを正とする。**

内容を変えたいときは、ここではなく Project レコードを更新し、本書へ反映すること。

---
Design Philosophy
1. AIteamOS自身でAIteamOSを育てる
AIteamOSは単なる開発支援ツールではなく、AIteamOS自身を含むProjectを継続的に開発できる自律開発基盤を目指す。
可能な限り、AIteamOSの改善・機能追加・検証そのものをAIteamOSの通常Projectフローで実行する。
自己開発だけのための特殊な開発経路を増やさず、通常Projectにも使える仕組みを優先する。
---
2. 稼働中の自分を直接壊さない
AIteamOS自身を開発する場合でも、現在正常稼働しているStable環境を直接変更しながら動作を継続しない。
変更は安全に隔離されたCandidateとして作成・検証し、十分な確認後にStableへPromotionする。
自己改善能力よりも、復旧可能性と安全性を優先する。
---
3. 今後すべての開発に効く改善を優先する
個別Projectだけに効く改善より、
- 開発成功率
- 安定性
- 検証能力
- 復旧能力
- 観測能力
- モデル利用効率
- 人間介入削減
など、今後ほぼすべてのProjectに継続的な効果を持つ改善を優先する。
ただし将来役立つ可能性だけを理由に過剰な基盤を先行実装しない。
---
4. 正常系より「壊れたとき」を設計する
正常に完了することだけでは十分ではない。
AIteamOSは、
- AI provider failure
- timeout
- partial failure
- process crash
- inconsistent state
- duplicate execution
- stuck job
- dirty workspace
- deployment failure
- network / tool failure
などが発生することを前提に設計する。
障害を完全に防ぐことより、
Detect
→ Contain
→ Preserve State
→ Diagnose
→ Resume / Retry / Rollback / Escalate
できることを重視する。
---
5. 実際に動いたことを完成条件とする
コード生成、テスト成功、Review承認だけを完成条件にしない。
変更した機能は可能な限り実際の利用入口から実行し、意図した目的が達成されたことを確認する。
内部実装の正しさだけでなく、End-to-Endで利用可能であることを完成の基準とする。
---
6. 事実を観測可能にする
AIにも人間にも、システム内部で何が起きているか分からない状態を作らない。
Project、Task、Job、Session、Review、Approval、Runtime、Recovery等の状態は可能な限り明示的・永続的・機械可読にする。
Progress表示や説明は推測ではなく、実際のbackend stateとeventをSource of Truthとする。
---
7. 役割とモデルを分離する
PL、Implementer、Reviewer、Researcher、Explainer等の責務を、特定のAI providerやmodelそのものと同一視しない。
役割に必要な能力に応じて、
- provider
- model
- reasoning level
- fallback
- cost policy
を変更可能にする。
高性能モデルを必要のない仕事へ固定しない一方、重要な設計判断には必要な推論能力を確保する。
また、生成者と独立Reviewerなど、独立性が品質に重要な役割は適切に分離する。
---
8. 技術判断と人間向け説明を分離する
技術的に優れたモデルが、必ずしも非エンジニアへの説明に最適とは限らない。
技術判断・実装・Reviewとは別に、確定した事実をCEOが理解できる形へ変換するExplainer責務を持てるようにする。
Explainerは判断結果を変更・推測せず、
- 何が起きたか
- 何ができるようになったか
- 何が問題なのか
- 人間の判断が必要か
を平易に説明する。
人間がAIteamOSを理解・監督できることもシステム品質の一部と考える。
---
9. Project同士を独立させる
AIteamOSは単一Project専用システムとして設計しない。
各Projectの、
- Roadmap
- Task
- Job
- Session
- Workspace
- Runtime state
- Logs
- Cost
- Metrics
は明確なProject境界を持つ。
一つのProjectの障害や状態汚染が、他Projectへ波及しにくい構造を優先する。
---
10. 共通化するが、無理に一般化しない
複数Projectで繰り返される問題は共通機構として解決する。
一方、将来必要かもしれないという理由だけで巨大な抽象化や汎用Frameworkを作らない。
既存機能、既存Rule、既存Prompt、既存Workflowを改善することで十分なら、それを優先する。
最も単純で自然な設計を選ぶ。
---
11. 外部能力を交換可能にする
AI provider、MCP、外部Tool、Repository、Deployment environment等は、AIteamOS本体へ過度に密結合させない。
将来新しい能力を追加するとき、AIteamOS全体を書き換えず接続できる構造を目指す。
ただし特定技術の採用そのものを目的化しない。
MCP等も既存Tool abstractionより合理的な場合に利用する。
---
12. AIcompanyOSへ渡せるProjectを作る
AIteamOSはAIcompanyOSそのものにはならない。
AIteamOSの責務は、高品質なProjectを開発し、運用可能な状態へ持っていくことである。
一方、作成されたProjectについて、
- Goal
- Success Metrics
- Capabilities
- Data
- Dependencies
- Lifecycle
- Operational Metrics
- Cost
- Events
- Learnings
などを将来AIcompanyOSから機械的に理解できる余地を残す。
AIcompanyOSのBusiness Management責務を先回りしてAIteamOSへ取り込まない。
---
13. 人間は常時監視者ではなく、重要判断者になる
AIteamOSの目的は、人間が毎Taskを監視することではない。
通常の技術判断、実装、Review、Recoveryは可能な限りAIteamOS内で完結させる。
人間へのEscalationは、
- Design Philosophy
- Safety boundary
- 権限変更
- 重要な不可逆操作
- Business / CEO判断
- AIだけでは合理的に判断できない事項
へ集中させる。
---
14. 改善は測定可能であること
「良くなったはず」で終わらせない。
可能な範囲で、
- success rate
- failure rate
- retry / rework
- development time
- cost
- human intervention
- recovery success
- runtime reliability
等を変更前後で比較できるようにする。
AIteamOS自身の改善も、通常Projectと同じく結果で評価する。
---
15. 自律性より制御可能性を優先する
高度な自律性は重要だが、制御不能な自律性を目標にしない。
AIteamOSは常に、
- 現在何をしているか分かる
- なぜその判断をしたか追跡できる
- 必要なら停止できる
- 状態を失わず再開できる
- 問題があれば以前の安全な状態へ戻せる
ことを優先する。
自律性は、この安全性・観測可能性・復旧可能性の上に構築する。

---

*Synced from the Project record: 2026-09-16*
