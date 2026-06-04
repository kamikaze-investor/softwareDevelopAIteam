# チェックリスト: sandbox/

対象: `docker-compose.yml` / `Dockerfile` / `sandbox/` 配下の全ファイル

---

## 🔴 CRITICAL（1件でも違反 → blocked）

### docker-compose.yml
- [ ] Control Repository のマウントに `:ro`（read-only）が付いている
- [ ] `cap_drop: [ALL]` が維持されている
- [ ] `no-new-privileges: true` が維持されている
- [ ] `working_dir: /workspace/target` が維持されている
- [ ] Docker socket（`/var/run/docker.sock`）のマウントが追加されていない
- [ ] `/workspace/target` 以外への書き込みマウントが追加されていない
- [ ] ホストの root ファイルシステムへのマウントが追加されていない

### Dockerfile
- [ ] root 以外のユーザーで実行している（`USER aiworker` 等）
- [ ] 不審なパッケージ・ツールが追加されていない（`curl` / `wget` / `ssh` 等）

---

## 🟡 IMPORTANT（違反 → changes_requested）

- [ ] 環境変数で機密情報（APIキー等）をコンテナに直接渡していない
- [ ] 新しいネットワーク設定が意図した範囲に収まっている
- [ ] ヘルスチェックが適切に設定されている

---

## ⚪ ADVISORY（指摘するが blocking しない）

- [ ] イメージのバージョンが固定されている（`latest` タグを避ける）
- [ ] 不要なポートが公開されていない
