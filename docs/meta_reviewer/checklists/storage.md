# チェックリスト: apps/api/src/storage/

対象: `apps/api/src/storage/` 配下の全ファイル

---

## 🔴 CRITICAL（1件でも違反 → blocked）

- [ ] SQL インジェクションの脆弱性がない（プレースホルダー `?` を使っている）
- [ ] `IStorage` インターフェースを破壊する変更がない（既存メソッドの削除・シグネチャ変更）
- [ ] `.env` / APIキー等の機密情報をDBに保存するフィールドが追加されていない

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] スキーマ変更が `runMigrations()` に対応する `MIGRATION_STATEMENTS` を持っている
- [ ] 新しいカラムが NULL 許容 or DEFAULT 値を持っている（既存データを壊さない）
- [ ] デシリアライズ関数が NULL / undefined を安全に処理している
- [ ] JSON シリアライズ対象のフィールドで `JSON.parse(null)` が発生しない
- [ ] `packages/shared/src/types/` の最新型定義と整合している

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] `:memory:` DB でのテストが存在する
- [ ] 新しいフィールドの serialize / deserialize がテストされている
- [ ] `WAL` モードの設定が維持されている（同時アクセス性能）
