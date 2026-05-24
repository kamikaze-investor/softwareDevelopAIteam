# AI Development Team OS
## Runtime Environment & Sandbox Design v1.0

---

# 1. Purpose

本ドキュメントは、AI Development Team OS の運用環境・実行基盤・安全設計を定義する。

本システムでは、AIが自律的に開発を進めるため、バックエンドとWorkerにコマンド実行権限が必要になる。

そのため、最重要方針は以下である。

```text
AIに守らせるのではなく、
OS / Docker / Git / 権限設計で物理的に守る
```

---

# 2. Core Principle

## AI Cannot Modify Its Own Cage

AIは自分の檻を改造できない。

AIが変更できる対象と、AIを制御する実行基盤は必ず分離する。

```text
ai-team-backend  →  AIが触れない
target-project   →  AIが触れる
```

---

# 3. High Level Architecture

```text
Mobile App
  ↓ HTTPS
Backend API
  ↓ Job登録
Queue
  ↓
Worker
  ↓
Docker Sandbox
  ↓
Mounted Target Repo
```

---

# 4. Server Components

## Backend API

**役割**
```text
スマホアプリからの操作受付
Project管理 / Task管理 / Job登録
Dashboard用データ提供
```

AIはBackend APIのコードを変更できない。

## Worker

**役割**
```text
QueueからJob取得
Docker Sandbox起動
許可コマンド実行
ログ保存 / 結果保存
```

AIはWorkerのコードを変更できない。

## Docker Sandbox

**役割**
```text
AI実行環境
Claude Code / Codex / Gemini CLI 実行
テスト実行 / Git操作
```

AIが触れるのはSandbox内のみ。

---

# 5. Repository Separation

## Control Repository

AI Development Team OS本体。`ai-team-backend/`

**含むもの**
```text
Backend API / Worker / Permission Guard
Docker設定 / Queue設定 / 認証情報管理
```

**AI編集禁止。**

## Target Repository

AIが開発する対象プロジェクト。`target-project/`

**含むもの**
```text
アプリコード / docs/ / project_memory/ / tasks/ / tests/
```

**AI編集可能。**

---

# 6. Workspace Boundary

Workerは必ず固定作業ディレクトリで実行する。

```text
/workspace/project
```

AIがアクセス可能な範囲はこの配下のみ。

**禁止**
```text
/home / /root / /etc / ~/.ssh
他プロジェクト / Backend本体 / Worker本体
```

---

# 7. Docker Mount Policy

SandboxにはTarget Repositoryのみをマウントする。

```yaml
volumes:
  - /srv/ai-team/repos/target-project:/workspace/project
```

**禁止**
```text
Docker socket mount
host root mount
~/.ssh mount
.env mount
/var/run/docker.sock
```

---

# 8. Environment Variable Policy

## .env保護

`.env` はAIに見せない。AIが触れるのは以下のみ。

```text
.env.example / README / docs
```

**禁止**
```text
.env / .env.local / .env.production
secret.json / service-account.json
```

## Secret Injection

APIキーや秘密情報はBackend/Worker側で管理する。

Sandboxへ渡す場合は、必要最小限の環境変数のみ一時的に注入する。

---

# 9. Command Allowlist

Workerは許可されたコマンドのみ実行する。

## Allowed

```text
git status / git diff / git checkout / git commit / git revert
npm install / npm test / npm run build / npm run typecheck
pnpm test
python -m pytest
claude / codex / gemini
```

## Forbidden

```text
sudo / su / rm -rf /
curl | sh / wget | sh
chmod 777 / chown
ssh / scp / rsync
docker run / docker compose
systemctl / ufw
apt install / brew install
```

---

# 10. Network Policy

初期MVPではSandboxからのネットワークアクセスは必要最小限にする。

| | 候補 |
|---|---|
| 許可 | GitHub / npm registry / package registry / AI API endpoint |
| 禁止 | 任意URLアクセス / 外部送信 / メール送信 / SNS投稿 / 本番API操作 |

---

# 11. Git Safety Policy

AIは必ず作業ブランチで作業する。

```text
main
  ↓
ai/task-xxxx
```

mainへ直接pushしない。

## Commit Policy

```text
1 task = 1 commit
大きいタスクは 1 subtask = 1 commit
```

## Rollback Policy

各Job完了時に保存する。

```text
commit hash / 変更ファイル一覧 / 変更要約
実行コマンド / テスト結果 / rollback方法
```

---

# 12. Permission Guard

Workerの前段にPermission Guardを置く。

**役割**
```text
コマンド検査
作業ディレクトリ検査
変更ファイル検査
禁止ファイル検査
リポジトリ境界検査
```

---

# 13. File Change Guard

AIが変更したファイルを検査する。

**禁止ファイル**
```text
.env / .env.*
*.pem / *.key
id_rsa / id_ed25519
service-account.json
docker-compose.prod.yml
backend permission files
worker permission files
```

リポジトリ外変更を検知した場合、Jobを失敗扱いにする。

---

# 14. Backend Self-Protection

AIは以下を編集できない。

```text
Backend API / Worker / Permission Guard
Dockerfile / docker-compose.yml
.env / secret files / deployment scripts
```

これらはControl Repositoryに置き、Target Repositoryとは分離する。

---

# 15. Job Execution Flow

```text
User starts task
  ↓
Backend creates Job
  ↓
Worker receives Job
  ↓
Permission Guard validates Job
  ↓
Docker Sandbox starts
  ↓
Allowed command runs
  ↓
File Change Guard checks diff
  ↓
Tests run
  ↓
Commit created
  ↓
Result saved
  ↓
Dashboard updated
```

---

# 16. Logging Policy

すべての実行ログを保存する。

**保存対象**
```text
Job ID / Task ID / Command / Working directory
Start time / End time / Exit code
stdout / stderr / changed files / commit hash
```

秘密情報はログ出力前にマスクする。

---

# 17. Failure Handling

| 種別 | 動作 |
|---|---|
| Command Failed | Job failed / ログ保存 / Summary生成 / 次の修正Job作成可能 |
| Guard Violation | Job blocked / 理由保存 / CEOへ通知 |
| Sandbox Timeout | Job stopped / partial logs saved / retry可能 |

---

# 18. MVP Runtime Scope

**MVPで実装するもの**
```text
Backend API / Worker / Docker Sandbox
Target Repo mount / Command Allowlist
File Change Guard / Job Logs
Git branch/commit / Dashboard update
```

**MVPで実装しないもの**
```text
高度なネットワーク制御 / 複数ユーザー
チーム権限管理 / 本番デプロイ
課金 / 外部公開自動化
```

---

# 19. Success Criteria

```text
AIがリポジトリ内では自由に開発できる
AIがリポジトリ外へ影響を与えられない
AIがBackend/Worker/Permission Guardを改変できない
失敗してもGitで戻せる
スマホからターミナルを触らずにJobを開始・確認できる
```

---

# Most Important Principle

**AIにルールを守らせるのではない。**

**AIがルールを破れない環境を作る。**
