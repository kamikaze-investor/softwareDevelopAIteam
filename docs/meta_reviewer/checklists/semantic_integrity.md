# チェックリスト: Semantic Integrity（canonical-domain-meaning）

対象: 原則 `canonical-domain-meaning`（`specs/21`）が選ばれた review。
変更ファイルの場所ではなく、**変更が domain fact を判断しているか**で適用する。
domain fact = authority / safety / lifecycle state / completion / current・superseded /
lineage / entity 間の関係 / candidate selection / error の意味。

この checklist の責務は「domain の意味をどこから得ているか」だけである。
一般 architecture・security・style・performance はここで判定しない（他の checklist / focus の責務）。

---

## 🟡 IMPORTANT（違反 → changes_requested）

domain fact の判断（authority / safety / lifecycle / completion / supersession / selection）に
関わる場合に限る。

- [ ] **Semantic question**: このコードが判断している domain fact を1文で言える
- [ ] **Canonical authority**: その意味を所有する既存の spec / policy / type / function を特定でき、
      このコードはそこへ問い合わせている（同じ判断を自前で組み立てていない）
- [ ] **Representation relied upon**: string shape / prefix・suffix / ID format / naming /
      ordering・"latest" / timestamp / message text / fixture の形を、意味の代わりにしていない
- [ ] **Representation classification**: 依存している表現が contractual（persisted schema /
      external API / event format / stable identifier）か incidental かを区別している。
      判別できない persisted / 外部観測可能な表現は contractual として扱い、
      それを変える変更には migration / compatibility strategy がある
- [ ] **Unknown / ambiguous behavior**: 解釈できない・曖昧な入力で、許可しない / 遷移しない /
      完了とみなさない / 置き換えたとみなさない / 推測で選ばない側へ倒れる。
      かつ、その理由が既存の観測可能な経路（typed error / review finding / Attention /
      escalation）に出る。silent fallback・silent stall・invisible hang・retry loop になっていない
- [ ] **Explicit relation**: current / superseded / parent / lineage を順序や時刻から推測していない
      （chronology 自体が domain rule の場合を除く。そのときはその rule を名指しできる）
- [ ] **Error semantics**: human-readable error message の文字列で program logic を分岐していない
      （typed error / error code / typed state を使う）

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] **Duplicate authority**: 同じ意味を複数の consumer がそれぞれ解釈していない
      （新たに増やす変更なら IMPORTANT として扱う）
- [ ] **Test adequacy**: semantic boundary のテストが両方向ある
  - same meaning / different representation → same result
  - similar representation / different meaning → different result

---

## 判定のしかた

- 構文（`startsWith` / `split` / 正規表現 / `ORDER BY ... DESC LIMIT 1` / `.message` 等）は
  **違反の証拠ではなく、確認の手がかり**である。canonical owner 自身が自分の contractual
  format を parse すること、path・CLI 引数の処理、chronology が rule そのものの処理は違反ではない
- finding を出すときは **Semantic question と canonical owner（無ければ「無い」）を必ず書く**。
  書けないなら finding にしない
- 既存コードは一括で書き換えさせない（`existing-code-grandfather`）。今回の変更が
  新たに再推論を持ち込む / 広げる箇所を対象にする
- finding は既存 category `implementation_coupling` で報告し、message の先頭に
  `[semantic_reinference]` を付ける。新しい category・status は使わない
- 新しい resolver / abstraction / Gate / status / workflow の追加を、この checklist を理由に
  求めない。既存の owner で自然に表現できるならそれを使わせる

---

## 例（説明用。特定の実装・形式を仕様として固定するものではない）

### current release

- before: `releases` を `created_at DESC LIMIT 1` で取り、それを「現在の release」とする
- after: 現在の release を決める既存の relation（current pointer / deploy 記録など、
  その責務を持つもの）を見る
- 双方向テスト:
  - 古い artifact を再 deploy して current にした（created_at は古い）→ current と判定される
  - 最も新しく作られたが health check に失敗し current にならなかった release → current ではない

### error の意味

- before: `if (err.message.includes('not found')) return emptyResult()`
- after: typed error / error code（例: `code === 'NOT_FOUND'` を返す owner の契約）で分岐する
- 双方向テスト:
  - 同じ code で message の locale が違う（英語 / 日本語）→ 同じ扱い
  - message に "not found" を含むが別の domain error（上流 proxy の 404 ページ、
    設定ファイルが見つからない等）→ 別の扱い（空結果にしない）
