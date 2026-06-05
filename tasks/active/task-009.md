# task-009: Worker — Job 実行エンジン

**担当**: Codex  
**設計**: Claude Code  
**依存**: task-008（Job Queue API）✅ マージ済み  
**ブランチ**: `ai/task-009`（master から作成）  
**コミット形式**: `[codex task-009] feat: ...`

---

## セッション開始前に必ず読むこと

1. `AGENTS.md` — ワークツリー境界・品質ルール・自律修正ループ
2. `CLAUDE.md` — 禁止事項
3. `docs/env-notes.md` — pnpm 実行方法
4. `apps/worker/src/index.ts` — 現在の Worker の骨格
5. `apps/worker/src/guards/permissionGuard.ts` — Guard の使い方
6. `apps/worker/src/guards/fileChangeGuard.ts` — Guard の使い方
7. `apps/worker/src/commandResolver.ts` — SafeCommand → argv 変換
8. `packages/shared/src/types/job.ts` — Job 型
9. `packages/shared/src/types/command.ts` — SafeCommand 型

---

## ブランチ作成

```bash
git checkout master && git pull origin master
git checkout -b ai/task-009
```

---

## タスクスコープ

**Worker の Job 実行エンジンを実装する。**

Worker は以下のサイクルを繰り返す：
1. API から `status: queued` の Job を取得
2. Permission Guard で SafeCommand を検証
3. commandResolver で SafeCommand → argv に変換
4. `execFileSync` で実行（`shell: false` 必須）
5. File Change Guard で変更ファイルを検証
6. 結果を API で更新（status, exitCode, stdout, stderr, changedFiles）

**注意**: AI CLI の呼び出し（Claude Code / Codex CLI）は task-022 以降。
今回はコマンド（git, pnpm test等）の実行エンジンのみ実装する。

---

## ファイル構成

```
apps/worker/src/
  jobRunner.ts   ← 新規作成（Job実行ロジック）
  index.ts       ← 既存を更新（pollJobs をジョブ実行ループに変更）
```

---

## 実装指示

### ファイル1: `apps/worker/src/jobRunner.ts`（新規作成）

```typescript
/**
 * Job Runner — Job 実行エンジン
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 1Job = 1SafeCommand を安全に実行して結果を返す。
 * AI CLI の呼び出しは task-022 以降で実装する。
 */

import { execFileSync } from 'node:child_process'
import type { Job, JobGuardResult } from '@ai-team/shared'
import { permissionGuard } from './guards/permissionGuard.js'
import { fileChangeGuard } from './guards/fileChangeGuard.js'
import { resolveCommand } from './commandResolver.js'

const JOB_TIMEOUT_MS = 120_000  // 2分

export interface JobRunResult {
  status: 'success' | 'failed' | 'blocked'
  exitCode?: number
  stdout?: string
  stderr?: string
  changedFiles?: string[]
  guardResult: JobGuardResult
  startedAt: string
  completedAt: string
}

/**
 * Job を実行して結果を返す
 * - Permission Guard → commandResolver → execFileSync → File Change Guard
 */
export async function runJob(job: Job): Promise<JobRunResult> {
  const startedAt = new Date().toISOString()

  // 1. Permission Guard
  const guardCheck = permissionGuard(job.safeCommand, job.agentRole)
  const guardResult: JobGuardResult = {
    permissionAllowed: guardCheck.allowed,
    permissionReason: guardCheck.reason,
    fileChangeAllowed: true,
    fileViolations: [],
  }

  if (!guardCheck.allowed) {
    return {
      status: 'blocked',
      guardResult,
      startedAt,
      completedAt: new Date().toISOString(),
    }
  }

  // 2. SafeCommand → argv
  const resolved = resolveCommand(job.safeCommand)

  // 3. 実行
  let exitCode = 0
  let stdout = ''
  let stderr = ''

  if (!job.dryRun) {
    try {
      stdout = execFileSync(resolved.argv[0], resolved.argv.slice(1), {
        cwd: job.safeCommand.workingDir,
        shell: false,           // ⚠️ シェルインジェクション防止
        timeout: JOB_TIMEOUT_MS,
        encoding: 'utf-8',
      })
    } catch (err: any) {
      exitCode = typeof err.status === 'number' ? err.status : 1
      stdout   = typeof err.stdout === 'string' ? err.stdout : ''
      stderr   = typeof err.stderr === 'string' ? err.stderr : String(err)
    }
  }

  // 4. File Change Guard
  const changedFiles = getChangedFiles(job.safeCommand.workingDir)
  const fileGuard = fileChangeGuard(changedFiles)
  guardResult.fileChangeAllowed = fileGuard.allowed
  guardResult.fileViolations = fileGuard.violations ?? []

  return {
    status: exitCode === 0 && fileGuard.allowed ? 'success' : 'failed',
    exitCode,
    stdout: stdout.slice(0, 10_000),  // 最大10KB
    stderr: stderr.slice(0, 10_000),
    changedFiles,
    guardResult,
    startedAt,
    completedAt: new Date().toISOString(),
  }
}

function getChangedFiles(workingDir: string): string[] {
  try {
    const result = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: workingDir, encoding: 'utf-8', shell: false,
    })
    return result.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}
```

### ファイル2: `apps/worker/src/index.ts`（既存を更新）

```typescript
/**
 * AI Development Team OS — Worker
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 役割:
 * - API から queued Job をポーリング
 * - Permission Guard で検証
 * - commandResolver で argv に変換
 * - execFileSync で実行（shell: false）
 * - File Change Guard で diff を検証
 * - 結果を API で更新
 */

import { runJob } from './jobRunner.js'

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3000'
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000)

console.log('Worker starting...')
console.log(`API: ${API_BASE}, poll interval: ${POLL_INTERVAL_MS}ms`)

async function fetchQueuedJob() {
  // queued な Job を1件取得する
  // 注: 現在は taskId なしで全 Job は取れない。
  //     task-009 の暫定実装として project/task 一覧から queued を探す。
  const res = await fetch(`${API_BASE}/api/projects`)
  if (!res.ok) return null
  const projects = await res.json() as Array<{ id: string }>

  for (const project of projects) {
    const tasksRes = await fetch(`${API_BASE}/api/tasks?projectId=${project.id}`)
    if (!tasksRes.ok) continue
    const tasks = await tasksRes.json() as Array<{ id: string }>

    for (const task of tasks) {
      const jobsRes = await fetch(`${API_BASE}/api/jobs?taskId=${task.id}`)
      if (!jobsRes.ok) continue
      const jobs = await jobsRes.json() as Array<{ id: string; status: string }>
      const queued = jobs.find(j => j.status === 'queued')
      if (queued) return queued
    }
  }
  return null
}

async function updateJob(jobId: string, data: Record<string, unknown>) {
  await fetch(`${API_BASE}/api/jobs/${jobId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function pollJobs() {
  while (true) {
    try {
      const job = await fetchQueuedJob() as any
      if (job) {
        console.log(`[Worker] Job ${job.id} (${job.safeCommand?.kind}) を実行します`)

        // running に更新
        await updateJob(job.id, { status: 'running', startedAt: new Date().toISOString() })

        // 実行
        const result = await runJob(job)

        // 結果を保存
        await updateJob(job.id, {
          status: result.status,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          changedFiles: result.changedFiles,
          completedAt: result.completedAt,
          guardResult: result.guardResult,
        })

        console.log(`[Worker] Job ${job.id}: ${result.status}`)
      }
    } catch (err) {
      console.error('[Worker] ポーリングエラー:', err)
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

pollJobs()
```

---

## .env.example への追記

```
# Worker が API と通信するベース URL
API_BASE_URL=http://localhost:3000
```

---

## 完了チェックリスト

```bash
$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN='false'
corepack pnpm --filter @ai-team/worker typecheck
corepack pnpm --filter @ai-team/worker test
```

変更ファイル:
- `apps/worker/src/jobRunner.ts`（新規）
- `apps/worker/src/index.ts`（更新）
- `.env.example`（API_BASE_URL 追記）

---

## 完了後

```bash
git add apps/worker/src/jobRunner.ts apps/worker/src/index.ts .env.example
git commit -m "[codex task-009] feat: Worker Job実行エンジンを実装"
git push origin ai/task-009
```

---

## やってはいけないこと

- AI CLI（claude / codex / gemini）の呼び出し実装（task-022以降）
- Guard のロジック変更（`guards/` は読み取りのみ）
- `packages/shared/` の変更
- `apps/api/` の変更
- `shell: true` でのコマンド実行
