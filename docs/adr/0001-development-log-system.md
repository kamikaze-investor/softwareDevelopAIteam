> **正本について**: 新しい設計判断は `docs/project_memory/decisions/` へ記録する（コードから
> 参照される現行の正本）。`docs/adr/` はこのファイルと0002のみの過去記録であり、新規ADRの
> 追加先ではない。

# ADR-0001: 開発ログ機能の導入

**ステータス:** Accepted  
**日付:** 2026-06-19  
**決定者:** CEO  
**実装担当:** Claude Code (CTO/Developer)

---

## 背景と課題

開発AIOSでは Claude Code / Codex CLI / Gemini Meta Review など複数のAIが連携して開発を進める。
AIが自律的に作業するほど以下の問題が顕在化していた。

- どの仕様が最新かわからなくなる
- なぜその実装になったのかわからなくなる
- どの相談がどの実装につながったかわからなくなる
- コミットと設計判断が結びつかない
- Meta Review・テスト結果が後から追えない
- AIが過去の判断を忘れて再び同じ問題を起こす
- 非エンジニアCEOが現在地を把握しにくい

---

## 決定

**開発ログ機能を開発AIOSの中核機能として導入する。**

単なる時系列メモではなく「意思決定の系譜」として設計する。

```
相談 → 課題発見 → 設計判断 → 実装方針 → AI実装
→ テスト → レビュー → コミット → 次タスク
```

---

## ログ種別と保存先

| 種別 | 保存先 | Git管理 |
|------|--------|---------|
| Raw Conversation Log | `logs/conversations/` | **しない**（個人情報・APIキーリスク） |
| Consultation Log | `logs/consultations/` | 重要なもののみ |
| Development Log | `logs/dev-sessions/` | 重要なもののみ（既存） |
| Implementation Log | `logs/implementation/` | **しない**（詳細ログ） |
| ADR / Decision Log | `docs/adr/` | **する** |
| Project Current State Map | `docs/PROJECT_CURRENT_STATE.md` | **する**（既存） |
| Idea Evolution Timeline | `docs/IDEA_EVOLUTION_TIMELINE.md` | **する** |
| Review Packet | `docs/review-packets/` | **する**（承認記録） |

---

## ID設計

| ID種別 | 形式例 |
|--------|--------|
| consultation_id | `consult-20260619-001` |
| dev_session_id | `dev-20260619-codex-meta-review-recovery` |
| implementation_log_id | `impl-20260619-213cd64` |
| review_packet_id | `rp-20260619-001` |

---

## 停止条件（自律開発が必ず止まる条件）

- Control Layer 変更（adapter / guard / permission / sandbox）
- DB schema / auth / secrets / env 変更
- Gemini Meta Review が NOT ALIGNED
- テスト連続失敗
- 仕様変更を伴う提案
- 初期仕様にない大きな機能追加

---

## 採用しなかった案

- **全ログをGit管理する**: 長文・個人情報・APIキー混入リスクで却下
- **外部ログSaaS**: 自律AIチームからのデータ送信リスクで却下
- **毎回人間確認**: 開発速度が落ちるため、低リスクは自律実行を維持

---

## 影響範囲

- `packages/shared/src/types/dev_log.ts` — 新規型定義
- `apps/api/src/storage/schema.ts` — テーブル追加（Phase 2以降）
- `apps/api/src/routes/` — ログ系エンドポイント追加（Phase 2以降）
- `apps/worker/` — Implementation Log 自動生成（Phase 2以降）
- `docs/` — ADR / Timeline ディレクトリ追加
- `logs/` — ディレクトリ構造追加

---

## MVP実装順（フェーズ分割）

| Phase | 内容 | 優先度 |
|-------|------|--------|
| 1 | コピペ型ログMVP（Consultation Log / Review Packet 型定義） | 高 |
| 2 | Development Log 連携（dev_session_id / コミット紐付け） | 高 |
| 3 | Review Inbox（Review Packet 生成・ChatGPT連携） | 中 |
| 4 | Idea Evolution Timeline | 中 |
| 5 | 自律連携（Worker停止時に自動生成） | 低 |
| 6 | Managed Runner 連携 | 低 |
