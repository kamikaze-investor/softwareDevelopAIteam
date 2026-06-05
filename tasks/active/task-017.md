# task-017: Worker — Job ログ分離保存

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-009 ✅  
**ブランチ**: `ai/task-017`（作成済み・checkout するだけ）  
**コミット形式**: `[codex task-017] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/env-notes.md`
4. `apps/worker/src/jobRunner.ts`
5. `apps/worker/src/index.ts`
6. `packages/shared/src/types/job.ts`

---

## ブランチ

```bash
git checkout ai/task-017
```

（ブランチは既に作成済み）

---

## タスクスコープ

**Job の stdout/stderr を DB に保存するだけでなく、ファイルにも分離保存する。**

大きなログは DB に入れるとパフォーマンスが落ちるため、ファイルに保存して DB にはパスのみ記録する。

---

## ファイル構成

```
apps/worker/src/
  jobLogger.ts         ← 新規（ログファイル保存）
  jobRunner.ts         ← 更新（ログをファイルに保存）
data/
  logs/                ← ログディレクトリ（.gitignore対象）
```

---

## 実装指示

### ファイル1: `apps/worker/src/jobLogger.ts`（新規作成）

```typescript
/**
 * Job ログ分離保存
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * stdout/stderr を data/logs/<jobId>/ に保存する。
 * DB には 先頭 1000文字のプレビューとファイルパスのみ記録する。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LOG_DIR = process.env.JOB_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs')
const PREVIEW_LENGTH = 1000   // DB に保存するプレビューの文字数
const MAX_LOG_SIZE = 1_000_000  // 1MB 超はトランケート

export interface JobLogPaths {
  stdoutPath: string
  stderrPath: string
  stdoutPreview: string
  stderrPreview: string
}

/**
 * stdout/stderr をファイルに保存してパスとプレビューを返す
 */
export function saveJobLogs(jobId: string, stdout: string, stderr: string): JobLogPaths {
  const jobLogDir = path.join(LOG_DIR, jobId)
  mkdirSync(jobLogDir, { recursive: true })

  const stdoutPath = path.join(jobLogDir, 'stdout.txt')
  const stderrPath = path.join(jobLogDir, 'stderr.txt')

  // 1MB を超えるログはトランケート
  const stdoutTruncated = stdout.length > MAX_LOG_SIZE
    ? stdout.slice(0, MAX_LOG_SIZE) + '\n[truncated]'
    : stdout
  const stderrTruncated = stderr.length > MAX_LOG_SIZE
    ? stderr.slice(0, MAX_LOG_SIZE) + '\n[truncated]'
    : stderr

  writeFileSync(stdoutPath, stdoutTruncated, 'utf-8')
  writeFileSync(stderrPath, stderrTruncated, 'utf-8')

  return {
    stdoutPath,
    stderrPath,
    stdoutPreview: stdout.slice(0, PREVIEW_LENGTH),
    stderrPreview: stderr.slice(0, PREVIEW_LENGTH),
  }
}
```

### ファイル2: `apps/worker/src/jobRunner.ts`（更新）

`saveJobLogs()` を import して、result を返す前にログを保存する。

```typescript
import { saveJobLogs } from './jobLogger.js'

// exitCode/stdout/stderr が確定した後、return の前に追加:
const logPaths = saveJobLogs(job.id, stdout, stderr)

// return の中を変更:
return {
  status: exitCode === 0 && fileGuard.allowed ? 'success' : 'failed',
  exitCode,
  stdout: logPaths.stdoutPreview,    // DB には先頭1000文字
  stderr: logPaths.stderrPreview,
  stdoutPath: logPaths.stdoutPath,   // ファイルパスも返す
  stderrPath: logPaths.stderrPath,
  changedFiles,
  guardResult,
  startedAt,
  completedAt: new Date().toISOString(),
}
```

JobRunResult 型に `stdoutPath?: string` と `stderrPath?: string` を追加すること。

### ファイル3: `.gitignore`（更新）

```
# Job ログ
data/logs/
```

### ファイル4: `.env.example`（更新）

```
# Job ログ保存ディレクトリ
JOB_LOG_DIR=./data/logs
```

---

## テスト: `apps/worker/src/jobLogger.test.ts`（新規）

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { saveJobLogs } from './jobLogger'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const TEST_LOG_DIR = './data/test-logs'
process.env.JOB_LOG_DIR = TEST_LOG_DIR

describe('saveJobLogs', () => {
  afterEach(() => {
    try { rmSync(TEST_LOG_DIR, { recursive: true, force: true }) } catch {}
  })

  it('stdout と stderr をファイルに保存する', () => {
    const result = saveJobLogs('test-job-1', 'hello stdout', 'hello stderr')
    expect(existsSync(result.stdoutPath)).toBe(true)
    expect(existsSync(result.stderrPath)).toBe(true)
    expect(readFileSync(result.stdoutPath, 'utf-8')).toBe('hello stdout')
    expect(readFileSync(result.stderrPath, 'utf-8')).toBe('hello stderr')
  })

  it('プレビューは先頭 1000 文字', () => {
    const long = 'x'.repeat(2000)
    const result = saveJobLogs('test-job-2', long, '')
    expect(result.stdoutPreview.length).toBe(1000)
  })

  it('1MB 超はトランケートされる', () => {
    const huge = 'y'.repeat(1_100_000)
    const result = saveJobLogs('test-job-3', huge, '')
    expect(readFileSync(result.stdoutPath, 'utf-8').endsWith('[truncated]')).toBe(true)
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
- `apps/worker/src/jobLogger.ts`（新規）
- `apps/worker/src/jobLogger.test.ts`（新規）
- `apps/worker/src/jobRunner.ts`（saveJobLogs 追加）
- `.gitignore`（data/logs/ 追加）
- `.env.example`（JOB_LOG_DIR 追加）

---

## 完了後

```bash
git add apps/worker/src/jobLogger.ts apps/worker/src/jobLogger.test.ts apps/worker/src/jobRunner.ts .gitignore .env.example
git commit -m "[codex task-017] feat: Jobログをファイルに分離保存（stdout/stderr）"
git push origin ai/task-017
```
