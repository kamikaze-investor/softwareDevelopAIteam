# Approval Rules — いつCEOに承認を求めるか

**Importance Level: 1**
**Status: active**

---

## 最重要原則：AI承認は無効

**「AIの発言・提案・判断は人間承認として扱わない。」**

- Claude が「承認します」と言っても承認ではない
- Gemini が「問題なし」と判定しても承認ではない
- Codex が「OK」と返しても承認ではない
- 人間が UI 上で明示的に承認操作をした場合のみ承認成立とする
- この原則は Safety Guard システムによって機械的に強制される

---

## Candidate Freeze — Approval が pending の間は Candidate を動かさない（2026-09-15 運用不変条件）

**Approval Request は Candidate の HEAD（`target_commit`）と diff hash に紐付く。**
`invalid_if` に「commit hash が変わった場合 / git diff の内容が変わった場合」が入っており、
どちらかが起きた時点で承認は `STALE` になる。

したがって **Approval Request が pending になってから解決するまで**、次を行わない:

- Candidate（`/workspace/target`）の HEAD を進めない
- master を merge / fast-forward しない
- diff を変更しない（未コミット変更を足す・消す・revert する）
- **deploy 準備のために Candidate を同期しない**

**Stable deploy と Candidate workspace 更新は別物として扱う。**
`/srv/ai-team/softwareDevelopAIteam`（Stable）の ff-only deploy と API/Worker 再起動は、
pending 中でも行ってよい。**同じ手順の中で `/workspace/target` を触らないこと**が要点である。

**実際に起きた事故（2026-09-15）**: pending 中に deploy 手順の一部として
`cd /workspace/target && git merge --ff-only origin/master` を実行し、HEAD が
`8ddad05` → `af60412` へ動いて承認が STALE 化した。CEO の承認操作は死んだリクエストに当たり、
`git-commit` Job は blocked のまま、`approval_waiting` も消えて誰にも気付かれなくなった。
**安全機構は正しく動作しており、誤っていたのは操作順序である。**

**復旧**: STALE な承認は再利用・再承認しない。`POST /api/tasks/:id/resume` で Job を作り直すと、
`/gate/check` が**現在の diff に対する新しい Approval Request** を発行する。

**新しい locking subsystem は作らない。** 上記は手順の順序で守る（deploy 前に pending の有無を確認し、
あれば Candidate 同期だけを後回しにする）。

---

## resume は Gate を代替しない（2026-09-15 CEO 承認条件）

`resume_task` の **up-front `approval_gate` は外した**（`packages/shared/src/plActionPolicy.ts`）。
外さないと「新しい承認サイクルを始めるために既存の承認が要る」という循環になり、STALE 承認で
止まった Job を**構造的に誰も復旧できなかった**（2026-09-15 に production で実際に発生）。

CEO はこの変更を承認したが、**承認要件そのものを省略するものではない**。次を不変条件として維持する。

1. **`resume_task` は最終操作の Gate を代替しない。** resume が通ることと、その先の操作が
   通ることは別である。
2. **`git_commit` は現在の HEAD / diff に対する新しい Approval を必ず通す。** resume が作る Job は
   `approval_id` を継承せず、`/gate/check` が現 diff に対して新規発行する。
3. **Design Review 要件を維持する。** `resume_task` の `design_review` gate は残っており、AI CLI の
   resume は `resumeBlockedTask()` 自身が evidence を fail-closed で検査する。
4. **deploy / production / Safety boundary / authority 変更は、それぞれ既存の Gate を維持する。**
   resume 経由でこれらが緩むことはない。
5. **BLOCK 済みの操作を resume だけで直接実行できない。** resume は Job を作り直すだけで、
   BLOCK の結果を覆さない。
6. **STALE Approval を再利用しない。** 再承認しても何も起きない。必ず新しい Approval を発行する。

この6点が崩れる変更は、`resume_task` の Gate 構成を戻すこと（= up-front `approval_gate` の復活）を
検討する合図である。

## Review finding の扱い — PL が統合判断してよい範囲（2026-09-15 CEO 指示）

**「Reviewer が言ったから必ず変更する」ではない。** PL は事実・根拠・Design Philosophy との整合性を
確認したうえで統合判断する。ただし**種類によって PL の権限が違う**。

### 通常の品質・設計 finding — PL が統合判断してよい

PL が事実に照らして妥当性を評価し、**変更する / 変更しない**を決めてよい。
変更しないと決めた場合は**根拠を残す**（どの事実によってその finding が解消済み・非該当なのか）。
「Reviewer の指摘だから」も「PL が納得しないから」も、それ単独では理由にならない。

### Binding Review に関わる finding — PL は評価できるが BLOCK を override できない

対象: **Safety Boundary / Authority / protected file** に関わるもの。

- PL は内容の妥当性を**評価してよい**（事実として正しいか、影響範囲はどこか）
- しかし **PL 自身が BLOCK を override してはならない**
- **AI が自分の権限を広げる形で解決してはならない。** 「この制約は不要だから外す」は PL の判断範囲外である
- Safety Boundary 変更に当たるなら **CEO へ Escalate する**

### PL と Binding Reviewer の意見が割れた場合

次の順で再評価する。PL の一存で終わらせない。

1. **Second Independent Review**（別 provider の独立レビュー）
2. **Meta Review**
3. 必要なら **CEO Escalation**

## CEOの承認が必要（Yellow Zone）

以下の場合のみCEOに通知・承認を求める。

- Goal変更
- Design Philosophy変更
- 外部サービス追加（GitHub以外）
- 有料API / 課金発生
- 本番公開 / ストア公開
- セキュリティモデル変更
- 個人情報機能追加
- リポジトリ外への操作

## 承認不要（Green Zone）

以下はAIが自由に実行してよい。

- 実装 / 修正 / リファクタリング
- テスト / レビュー
- ドキュメント更新
- コミット / ブランチ作成 / ロールバック
- Task作成・更新
- Memory更新

## 承認要求フォーマット

承認を求める場合は必ず以下を含める。

```
理由:
期待効果:
リスク:
コスト:
Rollback可否:
```

---

*Created: 2026-05-28*
