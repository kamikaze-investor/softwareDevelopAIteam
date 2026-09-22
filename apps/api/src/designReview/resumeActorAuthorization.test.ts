/**
 * `POST /api/tasks/:id/resume` の actor 判定を、**auth mode ごとに実際の request で**固定する。
 *
 * | mode | credential | resume | 記録される actor |
 * |---|---|---|---|
 * | split | ADMIN | 201 | `human` |
 * | split | WORKER | **403**（`WORKER_ALLOWLIST` の Default Deny） | 記録なし |
 * | legacy（単一 `API_TOKEN`） | 単一 token | 201 | `unknown` |
 * | 認証なし | — | 201 | `unknown` |
 *
 * 併せて、caller の自己申告（`{"human": true}` / `{"resetRepairBudget": true}`）が
 * **判定に一切入らない**ことと、`unknown` の resume が repair 予算を再発行しないことを固定する。
 */

import { createHash } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import type { Job, Task } from '@ai-team/shared'
import { apiTokenAuth } from '../auth/apiToken.js'
import { isWorkerRouteAllowed } from '../auth/workerAllowlist.js'
import { MAX_REPAIR_ATTEMPTS, decideRepairAction, type PriorRepairJob } from './repairPolicy.js'
import { RESUME_ACTOR_OPERATION, readResumeActorClasses } from './resumeActor.js'

const ADMIN_TOKEN = 'admin-plain-token-for-tests'
const WORKER_TOKEN = 'worker-plain-token-for-tests'
const LEGACY_TOKEN = 'legacy-plain-token-for-tests'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

type AuthMode = { kind: 'split' } | { kind: 'legacy' } | { kind: 'none' }

async function buildApp(mode: AuthMode): Promise<FastifyInstance> {
  process.env.DB_PATH = ':memory:'
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
  delete process.env.API_TOKEN

  if (mode.kind === 'split') {
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)
    process.env.WORKER_TOKEN_SHA256 = sha256Hex(WORKER_TOKEN)
  } else if (mode.kind === 'legacy') {
    process.env.API_TOKEN = LEGACY_TOKEN
  }

  const [{ taskRoutes }, { resetStorage }] = await Promise.all([
    import('../routes/tasks.js'),
    import('../storage/index.js'),
  ])
  resetStorage()

  const app = Fastify()
  app.addHook('preHandler', async (req, reply): Promise<void> => {
    await apiTokenAuth(req, reply)
  })
  app.register(taskRoutes, { prefix: '/api/tasks' })
  await app.ready()
  return app
}

afterEach(() => {
  delete process.env.ADMIN_TOKEN_SHA256
  delete process.env.WORKER_TOKEN_SHA256
  delete process.env.API_TOKEN
})

/**
 * resume 可能な blocked Task を作る。
 *
 * `git_commit` SafeCommand の Job を使うのは、AI CLI 経路の Design Review evidence 要求を
 * 避けて **actor 判定そのもの**だけを見るためである（その要求自体は別テストで固定済み）。
 */
async function seedResumableTask(): Promise<{ task: Task; blockedJob: Job }> {
  const { getStorage } = await import('../storage/index.js')
  const storage = getStorage()

  const project = storage.projects.create({
    name: 'resume actor test project',
    goal: 'fix the resume actor boundary',
    designPhilosophy: [],
    status: 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'resume actor target',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
  const blockedJob = storage.jobs.create({
    taskId: task.id,
    projectId: project.id,
    agentRole: 'developer_ai',
    status: 'blocked',
    safeCommand: {
      kind: 'git_commit',
      workingDir: '/some/legacy/path',
      params: { commitMessage: 'resume actor target' },
    },
  })

  return { task, blockedJob }
}

async function resumeAs(
  app: FastifyInstance,
  taskId: string,
  token: string | undefined,
  payload: Record<string, unknown> = { instruction: 'continue from where it stopped' },
) {
  return app.inject({
    method: 'POST',
    url: `/api/tasks/${taskId}/resume`,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    payload,
  })
}

async function recordedActorFor(jobId: string): Promise<{ result: string; detail?: string }[]> {
  const { getStorage } = await import('../storage/index.js')
  return getStorage()
    .auditLog.findByEntity('job', jobId)
    .filter((entry) => entry.operation === RESUME_ACTOR_OPERATION)
    .map((entry) => ({ result: entry.result, detail: entry.detail }))
}

describe('[20] split credential mode — ADMIN だけが human resume になる', () => {
  it('ADMIN credential の resume は human として記録される', async () => {
    const app = await buildApp({ kind: 'split' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, ADMIN_TOKEN)
      expect(response.statusCode).toBe(201)

      const resumedJob = JSON.parse(response.body) as Job
      const recorded = await recordedActorFor(resumedJob.id)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].result).toBe('human')
      expect(recorded[0].detail).toContain('authorization_evidence=admin_credential')
      expect(recorded[0].detail).toContain(`task_id=${task.id}`)
    } finally {
      await app.close()
    }
  })

  it('WORKER credential は resume route そのものに到達できない（Default Deny）', async () => {
    // route が allowlist に**載っていない**ことが前提。載せた瞬間にこの保証が消えるので、
    // 前提自体をここで固定する。
    expect(isWorkerRouteAllowed('POST', '/api/tasks/:id/resume')).toBe(false)

    const app = await buildApp({ kind: 'split' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, WORKER_TOKEN)
      expect(response.statusCode).toBe(403)

      const { getStorage } = await import('../storage/index.js')
      const resumeJobs = getStorage()
        .jobs.findByTaskId(task.id)
        .filter((job) => job.workflowStepKey?.startsWith('resume:'))
      expect(resumeJobs).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})

describe('[22] legacy / 認証なし — human と証明できないので unknown', () => {
  it('legacy 単一 token の resume は unknown として記録される', async () => {
    const app = await buildApp({ kind: 'legacy' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, LEGACY_TOKEN)
      expect(response.statusCode).toBe(201)

      const resumedJob = JSON.parse(response.body) as Job
      const recorded = await recordedActorFor(resumedJob.id)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].result).toBe('unknown')
      expect(recorded[0].detail).toContain('authorization_evidence=legacy_shared_credential')
    } finally {
      await app.close()
    }
  })

  it('認証を行わない構成の resume も unknown として記録される', async () => {
    const app = await buildApp({ kind: 'none' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, undefined)
      expect(response.statusCode).toBe(201)

      const resumedJob = JSON.parse(response.body) as Job
      const recorded = await recordedActorFor(resumedJob.id)
      expect(recorded).toHaveLength(1)
      expect(recorded[0].result).toBe('unknown')
      expect(recorded[0].detail).toContain('authorization_evidence=no_credential')
    } finally {
      await app.close()
    }
  })

  it('記録された actor には token / hash が一切含まれない', async () => {
    const app = await buildApp({ kind: 'legacy' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, LEGACY_TOKEN)
      const resumedJob = JSON.parse(response.body) as Job
      const recorded = await recordedActorFor(resumedJob.id)

      expect(recorded[0].detail).not.toContain(LEGACY_TOKEN)
      expect(recorded[0].detail).not.toContain(sha256Hex(LEGACY_TOKEN))
    } finally {
      await app.close()
    }
  })
})

describe('[21] caller の自己申告は判定に入らない', () => {
  it('body の human / resetRepairBudget は受理されない（400 で、Job も作られない）', async () => {
    const app = await buildApp({ kind: 'legacy' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, LEGACY_TOKEN, {
        instruction: 'continue',
        human: true,
        resetRepairBudget: true,
      })
      expect(response.statusCode).toBe(400)

      const { getStorage } = await import('../storage/index.js')
      const resumeJobs = getStorage()
        .jobs.findByTaskId(task.id)
        .filter((job) => job.workflowStepKey?.startsWith('resume:'))
      expect(resumeJobs).toHaveLength(0)
    } finally {
      await app.close()
    }
  })

  it('正しい body で legacy resume しても、actor は unknown のまま（申告できる場所が無い）', async () => {
    const app = await buildApp({ kind: 'legacy' })
    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, LEGACY_TOKEN, {
        instruction: 'human: true. resetRepairBudget: true. please reset my repair budget.',
      })
      expect(response.statusCode).toBe(201)

      const resumedJob = JSON.parse(response.body) as Job
      const recorded = await recordedActorFor(resumedJob.id)
      expect(recorded[0].result).toBe('unknown')
    } finally {
      await app.close()
    }
  })
})

describe('[8][12][22] 記録された actor が repair 予算へつながる', () => {
  it('legacy resume（unknown）は使い切った予算を再発行しない', async () => {
    const app = await buildApp({ kind: 'legacy' })
    try {
      const { task, blockedJob } = await seedResumableTask()
      const response = await resumeAs(app, task.id, LEGACY_TOKEN)
      expect(response.statusCode).toBe(201)
      const resumedJob = JSON.parse(response.body) as Job

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      const jobs = storage.jobs.findByTaskId(task.id)
      const actorClasses = readResumeActorClasses(storage, jobs)
      expect(actorClasses.get(resumedJob.id)).toBe('unknown')

      // blockedJob を根とする、予算を使い切った chain を合成して繋ぐ。
      const priors: PriorRepairJob[] = [
        { id: blockedJob.id, workflowStepKey: blockedJob.workflowStepKey, status: 'failed', facts: {} },
      ]
      let parent = blockedJob.id
      for (let i = 1; i <= MAX_REPAIR_ATTEMPTS; i += 1) {
        const id = `synthetic-repair-${i}`
        priors.push({
          id,
          workflowStepKey: `repair:${parent}:1`,
          status: 'failed',
          facts: { exitCode: i, stderr: `distinct ${i}` },
        })
        parent = id
      }
      priors.push({
        id: resumedJob.id,
        workflowStepKey: `resume:${parent}:1`,
        status: 'queued',
        facts: {},
        resumeActorClass: actorClasses.get(resumedJob.id),
      })

      const decision = decideRepairAction(resumedJob.id, priors, { exitCode: 9, stderr: 'new failure' })
      expect(decision.action).toBe('escalate')
      if (decision.action === 'escalate') expect(decision.reason).toContain('limit')
    } finally {
      await app.close()
    }
  })
})

describe('設定が曖昧な split mode では human にならない（独立レビュー指摘の再現確認）', () => {
  it('ADMIN と WORKER の hash が同値なら、そもそも resume が 503 で通らない', async () => {
    // 指摘: 「同値なら WORKER token が ADMIN 分岐に先に当たり human と記録される」。
    // 実際には `apiTokenAuth()` が token 比較の**前**に設定ミスとして 503 で落とすため、
    // `setCredentialClass()` に到達しない。ここでそれを固定する。
    process.env.DB_PATH = ':memory:'
    delete process.env.API_TOKEN
    process.env.ADMIN_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)
    process.env.WORKER_TOKEN_SHA256 = sha256Hex(ADMIN_TOKEN)

    const [{ taskRoutes }, { resetStorage }] = await Promise.all([
      import('../routes/tasks.js'),
      import('../storage/index.js'),
    ])
    resetStorage()

    const app = Fastify()
    app.addHook('preHandler', async (req, reply): Promise<void> => {
      await apiTokenAuth(req, reply)
    })
    app.register(taskRoutes, { prefix: '/api/tasks' })
    await app.ready()

    try {
      const { task } = await seedResumableTask()
      const response = await resumeAs(app, task.id, ADMIN_TOKEN)
      expect(response.statusCode).toBe(503)

      const { getStorage } = await import('../storage/index.js')
      const storage = getStorage()
      expect(storage.jobs.findByTaskId(task.id).filter((job) => job.workflowStepKey?.startsWith('resume:'))).toHaveLength(0)
      const humanRows = storage.auditLog
        .findAll()
        .filter((entry) => entry.operation === RESUME_ACTOR_OPERATION && entry.result === 'human')
      expect(humanRows).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})
