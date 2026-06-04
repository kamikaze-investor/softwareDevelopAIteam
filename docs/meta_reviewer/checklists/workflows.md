# チェックリスト: .github/workflows/ / .github/CODEOWNERS

対象: `.github/workflows/` 配下の全ファイル、`.github/CODEOWNERS`

---

## 🔴 CRITICAL（1件でも違反 → blocked）

- [ ] `GEMINI_API_KEY` / `GITHUB_TOKEN` 等のシークレットが `run:` ステップでログに出力されない
- [ ] `run:` ステップにシェルインジェクションの可能性がない（外部入力を直接展開しない）
- [ ] 必須チェック（`Typecheck & Test`）が削除されていない
- [ ] `CODEOWNERS` から保護対象ファイル（`guards/` / `sandbox/` / `CLAUDE.md` 等）が削除されていない
- [ ] CI が `blocked` を正しく検出・報告するロジックが維持されている

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] ワークフローの `permissions:` が最小限になっている（不必要な `write` がない）
- [ ] `actions/checkout@v4` 等のアクションバージョンが固定されている（`@main` を避ける）
- [ ] 秘密情報は必ず `${{ secrets.XXX }}` 経由で渡している（ハードコードしない）

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] 各ステップに `name:` がついている（デバッグしやすい）
- [ ] 失敗時も実行するステップに `if: always()` が付いている
