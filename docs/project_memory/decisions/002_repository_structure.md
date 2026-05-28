# Decision-002: Repository Structure

**Importance Level: 3**
**Status: active**
**Date: 2026-05-28**

---

## Decision

リポジトリを以下の構造で管理する。

```
ai-team-backend (Control Repository) = このリポジトリ
  → AIが触れない領域

target-project/ (Target Repository) = 各プロジェクトごとに別リポジトリ
  → AIが実装する領域
```

## Rationale

仕様書 `11_runtime_environment.md` の `AI Cannot Modify Its Own Cage` 原則に基づく。

AIが自分の制御システムを改変できないよう、物理的に分離する。

## Implication

- `apps/api/`, `apps/worker/` はAI編集禁止
- `sandbox/` のDocker設定はAI編集禁止
- ユーザーがターゲットプロジェクトを作成する際は別リポジトリを使用

---

*Created by: CTO AI (initial setup)*
