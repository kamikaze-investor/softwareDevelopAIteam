# task-016: Worker — Job 状態遷移ルール + 復旧ロジック

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-008 ✅ task-009 ✅  
**ブランチ**: `ai/task-016`（master から作成）  
**コミット形式**: `[codex task-016] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/env-notes.md`
4. `apps/worker/src/jobRunner.ts` — 既存の実行エンジン
5. `apps/worker/src/index.ts` — 既存のポーリングループ
6. `packages/shared/src/types/job.ts` — Job 型・JobStatus

---

## ブランチ作成

```bash
git checkout master && git pull origin master
git checkout -b ai/task-016
```

---

## タスクスコープ

**Job の状態遷移を FSM（有限状態機械）で管理し、Worker 異常終了からの復旧を実装する。**

---

## 状態遷移ルール

```
queued → running    （Worker が Job を取得したとき）
running → success   （exitCode === 0 && fileGuard.allowed）
running → failed    （exitCode !== 0）
running → blocked   （Guard が拒否）
blocked → queued    （CEO 承認後にリキュー可能 ← 今回は定義のみ）
```

**不正な遷移は拒否する。**

---

## ファイル構成

```
apps/worker/src/
  jobStateManager.ts   ← 新規（状態遷移 + 復旧）
  index.ts             ← 既存を更新（起動時復旧を呼び出す）
```

---

## 実装指示

### ファイル1: `apps/worker/src/jobStateManager.ts`（新規作成）

```typescript
/**
 * Job 状態遷移マネージャー
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * FSM（有限状態機械）で Job のステータス遷移を管理する。
 * 不正な遷移を防ぎ、Worker 異常終了後の復旧を担う。
 */

import type { JobStatus } from '@ai-team/shared'

// 許可された状態遷移マップ
const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued:   ['running'],
  running:  ['success', 'failed', 'blocked'],
  success:  [],                    // 終端状態
  failed:   ['queued'],            // 手動リトライ時のみ
  blocked:  ['queued'],            // CEO 承認後のリキュー
}

/**
 * 状態遷移が許可されているか確認する
 */
export function isTransitionAllowed(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * 遷移を検証して許可されていない場合は Error を投げる
 */
export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!isTransitionAllowed(from, to)) {
    throw new Error(
      `不正な状態遷移: ${from} → ${to}。` +
      `許可: ${ALLOWED_TRANSITIONS[from]?.join(', ') || 'なし'}`
    )
  }
}

/**
 * Worker 起動時の復旧処理
 *
 * running 状態のまま残っている Job は Worker の異常終了を示す。
 * これらを failed にリセットして再実行可能な状態にする。
 */
export async function recoverStaleJobs(apiBaseUrl: string): Promise<number> {
  let recovered = 0

  try {
    // Project 一覧を取得
    const projectsRes = await fetch(`${apiBaseUrl}/api/projects`)
    if (!projectsRes.ok) return 0
    const projects = await projectsRes.json() as Array<{ id: string }>

    for (const project of projects) {
      const tasksRes = await fetch(`${apiBaseUrl}/api/tasks?projectId=${project.id}`)
      if (!tasksRes.ok) continue
      const tasks = await tasksRes.json() as Array<{ id: string }>

      for (const task of tasks) {
        const jobsRes = await fetch(`${apiBaseUrl}/api/jobs?taskId=${task.id}`)
        if (!jobsRes.ok) continue
        const jobs = await jobsRes.json() as Array<{ id: string; status: JobStatus }>

        for (const job of jobs) {
          if (job.status === 'running') {
            // running のまま残っている = 前回の Worker が異常終了した
            await fetch(`${apiBaseUrl}/api/jobs/${job.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                status: 'failed',
                stderr: '[Worker] 前回の Worker が異常終了したため failed にリセットしました',
                completedAt: new Date().toISOString(),
              }),
            })
            recovered++
            console.log(`[Recovery] Job ${job.id} を running → failed にリセット`)
          }
        }
      }
    }
  } catch (err) {
    console.error('[Recovery] 復旧処理中にエラー:', err)
  }

  return recovered
}
```

### ファイル2: `apps/worker/src/index.ts`（既存を更新）

既存のファイルの `pollJobs()` 呼び出し前に `recoverStaleJobs()` を追加する。

```typescript
// 追加する import
import { recoverStaleJobs } from './jobStateManager.js'

// pollJobs() の前に追加
const recovered = await recoverStaleJobs(API_BASE)
if (recovered > 0) {
  console.log(`[Worker] ${recovered} 件の stale Job を復旧しました`)
}
```

また、`jobRunner.ts` の `runJob()` を呼ぶ前後に状態遷移の検証を追加する。

```typescript
// 追加する import
import { assertTransition } from './jobStateManager.js'

// running に更新する前に
assertTransition(job.status as JobStatus, 'running')

// result を保存する前に  
assertTransition('running', result.status as JobStatus)
```

---

## テスト: `apps/worker/src/jobStateManager.test.ts`（新規作成）

```typescript
import { describe, it, expect } from 'vitest'
import { isTransitionAllowed, assertTransition } from './jobStateManager'

describe('isTransitionAllowed', () => {
  it('queued → running は許可', () => {
    expect(isTransitionAllowed('queued', 'running')).toBe(true)
  })

  it('running → success は許可', () => {
    expect(isTransitionAllowed('running', 'success')).toBe(true)
  })

  it('running → failed は許可', () => {
    expect(isTransitionAllowed('running', 'failed')).toBe(true)
  })

  it('running → blocked は許可', () => {
    expect(isTransitionAllowed('running', 'blocked')).toBe(true)
  })

  it('success → running は禁止', () => {
    expect(isTransitionAllowed('success', 'running')).toBe(false)
  })

  it('queued → success は禁止', () => {
    expect(isTransitionAllowed('queued', 'success')).toBe(false)
  })
})

describe('assertTransition', () => {
  it('不正な遷移は Error を投げる', () => {
    expect(() => assertTransition('success', 'running')).toThrow('不正な状態遷移')
  })

  it('正常な遷移はエラーなし', () => {
    expect(() => assertTransition('queued', 'running')).not.toThrow()
  })
})
```

---

## 完了チェックリスト

```bash
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/worker typecheck
corepack pnpm --filter @ai-team/worker test
```

変更ファイル:
- `apps/worker/src/jobStateManager.ts`（新規）
- `apps/worker/src/jobStateManager.test.ts`（新規）
- `apps/worker/src/index.ts`（recoverStaleJobs 追加）

---

## 完了後

```bash
git add apps/worker/src/jobStateManager.ts apps/worker/src/jobStateManager.test.ts apps/worker/src/index.ts
git commit -m "[codex task-016] feat: Job状態遷移FSM + Worker異常終了からの復旧ロジック"
git push origin ai/task-016
```

---

## やってはいけないこと

- `guards/` の変更
- `packages/shared/` の変更
- `apps/api/` の変更
- rollback の実際の git 操作実装（それは task-009 の範囲外で別途設計）
