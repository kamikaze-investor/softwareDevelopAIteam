# チェックリスト: apps/api/src/routes/

対象: `apps/api/src/routes/` 配下の全ファイル、`apps/api/src/index.ts`

---

## 🔴 CRITICAL（1件でも違反 → blocked）

- [ ] `.env` / APIキー / DBパスワード / 秘密鍵を返すエンドポイントがない
- [ ] Guard ロジック（permissionGuard / fileChangeGuard）を迂回できるエンドポイントがない
- [ ] ファイルシステムへの直接アクセス（`fs.readFile` 等）を行うエンドポイントがない
- [ ] Control Repository（`/workspace/control` 配下）の内容を返すエンドポイントがない

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] Zod（または同等のバリデーション）でリクエスト入力を検証している
- [ ] レスポンスのHTTPステータスコードが適切（404/400/201/200等）
- [ ] ルートハンドラにビジネスロジックを直接書いていない（`getStorage()` 経由のみ）
- [ ] 全エンドポイントに対応するテストがある
- [ ] 存在しないリソースへのアクセスは `404` を返している
- [ ] 不正な入力は `400` を返している（5xx にしない）
- [ ] `apps/api/src/storage/` 以外から直接 DB に触れていない

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] エラーメッセージがユーザーにわかりやすい（内部エラーを丸出しにしない）
- [ ] レスポンス構造が他のルートと一貫している
- [ ] リスト系エンドポイントにフィルタリング・ページネーションの考慮がある
