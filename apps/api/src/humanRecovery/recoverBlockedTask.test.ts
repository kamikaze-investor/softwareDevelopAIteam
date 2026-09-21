/**
 * Human Recovery の契約。
 *
 * 固定する load-bearing invariant:
 *   1. **入口条件** — `blocked` かつ Job 0 件のときだけ受理する。Job があるものは
 *      既存 `resumeBlockedTask()` の責務であり、ここで二重の復旧経路を作らない
 *   2. **やることは1つだけ** — `blocked` → `pending` と audit 記録のみ。Job も Review も
 *      Approval も作らない（CEO 決定・2026-09-18「Implementation Job を直接生成せず」）
 *   3. **有界。ただし生涯上限ではない** — 連打を止めるのは入口条件（`blocked` かつ Job 0 件）で、
 *      再受理にはシステムが独立に dead state へ再突入している必要がある。自動ループの予算
 *      （`PL_MAX_REMEDIATION_ATTEMPTS` 等）は消費もリセットもしない
 *   4. **park を黙って取り消さない**
 *   5. **再投入後に何が動くかを正直に返す**（`nextDriver`）
 *   6. **PL から到達できない** — 語彙も配線も存在せず、後段 Approval の証拠にもならない
 */

import { describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { buildSystemState } from '../state/systemState'
import { occupiesProject } from '@ai-team/shared'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'
import { PL_ACTION_KINDS, resolvePlActionPolicy } from '@ai-team/shared'
import { runPlTick } from '../pl/executionLoop'
import { WORKER_ALLOWLIST } from '../auth/workerAllowlist'
import {
  countRemediationAttempts,
  PL_MAX_REMEDIATION_ATTEMPTS,
  recordRemediationFailure,
} from '../pl/remediationStep'
import { latestHumanRecoveryId, recoverBlockedTask } from './recoverBlockedTask'
import { recoveryReleasesProjectSlot } from './recoveryAudit'

interface Seeded {
  storage: IStorage
  taskId: string
  projectId: string
}

function seed(options: {
  taskStatus?: 'pending' | 'blocked' | 'done'
  projectStatus?: 'running' | 'archived' | 'paused'
  roadmapTaskKey?: string
  withJob?: boolean
  /** 診断まで進む `job_blocked` attention を作る（Job があるので recover 自体は対象外）。 */
  withBlockedJob?: boolean
  /** 自律ループから到達できない Task（`roadmapActive=false`）を作る。 */
  unreachable?: boolean
} = {}): Seeded {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: options.projectStatus ?? 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: '止まった Task',
    description: 'body',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src'],
    acceptanceCriteria: ['c'],
    // 既定は「自律ループから到達できる」形にする。到達できない Task も受理するが（断ると
    // 出口が無くなる）、そちらは nextDriver: 'none' になる。下のテスト参照。
    roadmapActive: options.unreachable !== true,
    ...(options.roadmapTaskKey !== undefined ? { roadmapTaskKey: options.roadmapTaskKey, phase: 1 } : {}),
  } as Parameters<IStorage['tasks']['create']>[0])

  if (options.withJob === true) {
    storage.jobs.create({
      taskId: task.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
    } as never)
  }
  if (options.withBlockedJob === true) {
    const job = storage.jobs.create({
      taskId: task.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'noop' },
      aiCliMode: 'implement',
      aiCliProvider: 'claude_code',
      aiCliPrompt: 'p',
    } as never)
    storage.jobs.update(job.id, { status: 'blocked', stderr: 'guard violation' } as never)
  }

  storage.tasks.update(task.id, { status: options.taskStatus ?? 'blocked' })
  return { storage, taskId: task.id, projectId: project.id }
}

/** その Task の直近 Design Review を CONFLICT で終端させる（Remediation 対象の形）。 */
function completeReviewAsConflict(storage: IStorage, taskId: string): void {
  const task = storage.tasks.findById(taskId)!
  const designText = buildInitialImplementAiCliPrompt(task)
  const run = storage.designReviewRuns.create({
    taskId,
    taskTitle: task.title,
    designText,
    designTextHash: computeDesignTextHash(designText),
    changedFiles: [],
  })
  const claimed = storage.designReviewRuns.claim(run.id, 3)
  storage.designReviewRuns.complete(
    run.id,
    claimed.claimToken as string,
    'succeeded',
    JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
  )
}

describe('recoverBlockedTask — 入口条件', () => {
  it('blocked かつ Job 0 件のときに受理し、pending へ戻す', () => {
    const { storage, taskId } = seed()

    const result = recoverBlockedTask(storage, { taskId, reason: 'CONFLICT を確認したので再投入する' })

    expect(result.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
  })

  it('**Job を1件でも作らない。** 再投入するだけで、実装は既存ループに委ねる', () => {
    const { storage, taskId } = seed()

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
    expect(storage.approvalRequests.findByTaskId(taskId)).toHaveLength(0)
  })

  it('Job を持つ Task は断り、既存 resume 経路へ案内する', () => {
    const { storage, taskId } = seed({ withJob: true })

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'TASK_HAS_JOBS' })
    expect(result.ok === false && result.reason).toContain('/resume')
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
  })

  it('blocked でない Task は断る', () => {
    const { storage, taskId } = seed({ taskStatus: 'pending' })

    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'TASK_NOT_BLOCKED' })
  })

  it('存在しない Task は断る', () => {
    const { storage } = seed()

    expect(recoverBlockedTask(storage, { taskId: 'nope', reason: 'r' }))
      .toMatchObject({ ok: false, code: 'TASK_NOT_FOUND' })
  })

  it('archived Project の Task は断る', () => {
    const { storage, taskId } = seed({ projectStatus: 'archived' })

    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }))
      .toMatchObject({ ok: false, code: 'PROJECT_UNAVAILABLE' })
  })

  it('**自律ループから到達できない Task も受理する。** 断ると出口が無くなる', () => {
    // 一度 `TASK_NOT_REACHABLE` で断る実装にしたが、それは dead-end を作った:
    // `abort_task`（park）も採用し直し（`syncRoadmapTasks`）も `pending` を要求するため、
    // 断ると **`/recover` も park も採用し直しもできない Task** が残る
    // （独立レビュー指摘・2026-09-21）。
    const { storage, taskId } = seed({ unreachable: true })

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
    // **何も拾わないことを正直に返す。** `attention_only` と言うと嘘になる
    // （`isReadyTaskWithoutJob()` は roadmapActive を要求するので attention も立たない）。
    expect(result).toMatchObject({ nextDriver: 'none' })
  })

  it('**到達できない Task でも、再投入すれば Project の枠は解放される**', () => {
    // `occupiesProject()` は `blocked` を無条件に占有と数え、`pending` は roadmapActive の
    // ときだけ占有と数える。だから到達不能でも再投入には意味がある。
    const { storage, taskId } = seed({ unreachable: true })
    expect(occupiesProject(storage.tasks.findById(taskId)!)).toBe(true)

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(occupiesProject(storage.tasks.findById(taskId)!)).toBe(false)
  })

  it('park された Task は断る（復旧の副作用で park を取り消さない）', () => {
    const { storage, taskId } = seed()
    storage.auditLog.record({
      actor: 'api',
      operation: 'task_aborted',
      entityType: 'task',
      entityId: taskId,
      result: 'success',
      detail: 'parked by CEO',
    })

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: false, code: 'TASK_PARKED' })
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
  })
})

describe('recoverBlockedTask — audit と有界性', () => {
  it('成功したときだけ audit を1行残す', () => {
    const { storage, taskId } = seed()

    recoverBlockedTask(storage, { taskId, reason: 'ledger 本文を訂正したので再投入' })

    const entries = storage.auditLog.findByEntity('task', taskId)
      .filter((entry) => entry.operation === 'task_human_recovered')
    expect(entries).toHaveLength(1)
    expect(entries[0].detail).toContain('ledger 本文を訂正したので再投入')
    expect(entries[0].result).toBe('success')
  })

  it('断ったときは audit を残さない（予算だけが減らない）', () => {
    const { storage, taskId } = seed({ withJob: true })

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(latestHumanRecoveryId(storage, taskId)).toBeUndefined()
  })

  it('続けて2回は叩けない（入口条件が idempotency guard になっている）', () => {
    const { storage, taskId } = seed()

    expect(recoverBlockedTask(storage, { taskId, reason: '1' })).toMatchObject({ ok: true })
    expect(recoverBlockedTask(storage, { taskId, reason: '2' }))
      .toMatchObject({ ok: false, code: 'TASK_NOT_BLOCKED' })
  })

  it('**訂正されずに blocked へ戻っても、再投入を拒否して deadlock にしない**', () => {
    // 独立レビュー round 1 を受けて「同一 designTextHash では1回だけ」を入れたが、
    // round 2 で deadlock が判明して撤回した経緯を固定する:
    //   design text は description + allowedPaths 由来 → **訂正しなければ hash は同じ**
    //   訂正には `syncRoadmapTasks()` が要る → それは `pending` を要求する
    //   `pending` にするにはこの関数が要る
    // よって同一 hash で拒否すると、訂正する手段ごと失われる。
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    completeReviewAsConflict(storage, taskId)

    expect(recoverBlockedTask(storage, { taskId, reason: '1回目' }).ok).toBe(true)

    // 何も変わらないまま、また同じ状態へ落ちた（最も普通のケース）。
    storage.tasks.update(taskId, { status: 'blocked' })

    const again = recoverBlockedTask(storage, { taskId, reason: '2回目' })
    expect(again).toMatchObject({ ok: true })
    expect(storage.tasks.findById(taskId)?.status).toBe('pending')
  })

  it('再投入のたびに、対象だった design text を audit へ残す（後から数えるため）', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    completeReviewAsConflict(storage, taskId)

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    const entry = storage.auditLog.findByEntity('task', taskId)
      .find((e) => e.operation === 'task_human_recovered')
    // 門にはしないが、同じテキストのまま何度戻したかは後から数えられる。
    expect(entry?.detail).toMatch(/dth=[0-9a-f]{16}/)
  })

  it('自動ループの予算を消費もリセットもしない', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    // #255 の Remediation 予算を使い切った状態を作る。
    for (let i = 0; i < PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      recordRemediationFailure(storage, taskId, `stage=remediation rejected ${i}`)
    }
    const before = countRemediationAttempts(storage, taskId)

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    // 再投入しても Remediation 予算は元のまま。再投入で自動ループが延命しない。
    expect(countRemediationAttempts(storage, taskId)).toBe(before)
    expect(before).toBe(PL_MAX_REMEDIATION_ATTEMPTS)
  })

  it('却下済み spec の履歴を消さない（Review laundering の経路にしない）', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    recordRemediationFailure(storage, taskId, 'stage=remediation spec=deadbeefdeadbeef rejected')
    const historyBefore = storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    const historyAfter = storage.auditLog.findByEntity('pl_remediation', `remediate:${taskId}`)
    expect(historyAfter).toHaveLength(historyBefore.length)
    expect(historyAfter.map((e) => e.detail)).toEqual(historyBefore.map((e) => e.detail))
  })

  it('**blocked のままでは採用し直しが SYNC_FAILED になる** —— 生涯上限を置けない理由', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    const before = storage.tasks.findById(taskId)!
    const correctedSpec = {
      projectId: before.projectId,
      tasks: [{
        roadmapTaskKey: 'some-item',
        title: '訂正後のタイトル',
        description: '訂正後の説明',
        phase: 1,
        assignee: 'developer_ai',
        category: 'implementation',
        dependencies: [],
        acceptanceCriteria: ['c'],
        allowedPaths: ['apps/api/src/humanRecovery'],
      }],
    }

    // `syncRoadmapTasks()` の可変条件は `jobs.length === 0 && status === 'pending'`。
    // blocked の Task は isUnstarted を満たさず、「着手済み Task の spec 変更」として**失敗する**。
    const refused = storage.tasks.syncRoadmapTasks(correctedSpec as never)
    expect(refused.ok).toBe(false)
    expect(refused.failureReason).toContain('started/completed tasks')
    expect(storage.tasks.findById(taskId)?.title).toBe(before.title)

    // Human Recovery で pending へ戻して初めて、訂正版 spec が適用できる。
    // **つまり再投入は訂正経路の前提条件であり、ここに生涯上限を置くと
    //   訂正版 spec を適用する手段ごと失われる。**
    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }).ok).toBe(true)
    const applied = storage.tasks.syncRoadmapTasks(correctedSpec as never)
    expect(applied.ok).toBe(true)
    expect(storage.tasks.findById(taskId)?.title).toBe('訂正後のタイトル')
  })
})

describe('recoverBlockedTask — nextDriver は再投入後に何が動くかを正直に返す', () => {
  it('roadmap 採用 Task が CONFLICT で止まっていれば Independent Remediation が引き取る', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    completeReviewAsConflict(storage, taskId)

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'pl_independent_remediation' })
  })

  it('roadmap 由来でない Task は自動で動く経路が無く、attention だけになる', () => {
    const { storage, taskId } = seed()

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'attention_only' })
  })

  it('**running でない Project では、通知が出るとすら言わない**', () => {
    // paused では PL tick も attention 導出も動かない。`pl_independent_remediation` は
    // もちろん嘘だが、`attention_only` も嘘である —— attention 導出は
    // `project.status === 'running'` を要求するので、通知は1件も出ない
    // （独立レビュー round 4 指摘）。
    const { storage, taskId } = seed({ projectStatus: 'paused', roadmapTaskKey: 'some-item' })
    completeReviewAsConflict(storage, taskId)

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'project_not_running' })
    // 実測で裏を取る: 再投入後も attention は1件も立たない。
    expect(buildSystemState(storage).attention).toHaveLength(0)
  })

  it('**Remediation 予算を使い切っていたら remediation を約束しない**', () => {
    const { storage, taskId } = seed({ roadmapTaskKey: 'some-item' })
    completeReviewAsConflict(storage, taskId)
    for (let i = 0; i < PL_MAX_REMEDIATION_ATTEMPTS; i += 1) {
      recordRemediationFailure(storage, taskId, `attempt ${i}`)
    }

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'attention_only' })
    expect(countRemediationAttempts(storage, taskId)).toBe(PL_MAX_REMEDIATION_ATTEMPTS)
  })

  it('**到達できても roadmapActive のままなら、枠が空くとは言わない**', () => {
    // `occupiesProject()` は `roadmapActive` だけを見る。assignee が違うだけの Task は
    // 自律ループから到達できないのに、`pending` でも枠を占有し続ける（round 4 指摘）。
    const { storage, taskId } = seed()
    storage.tasks.update(taskId, { assignee: 'cto_ai' } as never)

    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })

    expect(result).toMatchObject({ ok: true, nextDriver: 'none' })
    // 戻しても枠は空かない。「戻せば枠が解放される」と言ってはならない場合である。
    expect(recoveryReleasesProjectSlot(storage.tasks.findById(taskId)!)).toBe(false)
    expect(occupiesProject(storage.tasks.findById(taskId)!)).toBe(true)
  })
})

describe('遷移と audit は分割できない', () => {
  it('audit の書き込みが失敗したら status も戻らない（記録の無い復旧を作らない）', () => {
    const { storage, taskId } = seed()
    const original = storage.auditLog.record
    // 同一 transaction であることを、audit 側を失敗させて確かめる。
    storage.auditLog.record = () => { throw new Error('disk full') }

    expect(() => recoverBlockedTask(storage, { taskId, reason: 'r' })).toThrow(/disk full/)

    storage.auditLog.record = original
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    expect(latestHumanRecoveryId(storage, taskId)).toBeUndefined()
  })
})

describe('Human Recovery は AI/PL から到達できない（CEO 決定・2026-09-18）', () => {
  it('PL の action 語彙に Human Recovery が存在しない', () => {
    // 語彙に無い kind は `resolvePlActionPolicy()` が未知値として forbidden にする。
    expect(PL_ACTION_KINDS.some((kind) => kind.includes('human'))).toBe(false)
    expect(PL_ACTION_KINDS.some((kind) => kind.includes('recover'))).toBe(false)
  })

  it('WORKER credential から recover route を呼べない（Default Deny のまま）', () => {
    expect(WORKER_ALLOWLIST.some((entry) => entry.url.includes('/recover'))).toBe(false)
  })

  it('Human Recovery 相当の action は Policy が forbidden にする', () => {
    // 語彙に無い値は素通しではなく `forbidden` へ倒れる（fail-closed）。
    for (const kind of ['recover_task', 'human_recovery', 'recover_blocked_task']) {
      const decision = resolvePlActionPolicy({ kind })
      expect(decision.disposition).toBe('forbidden')
      // BLOCK されたとき PL が取れる行動に override は無い。
      expect(decision.allowedResponsesWhenBlocked).not.toContain('override_gate_block')
    }
  })

  it('**PL が Human Recovery 相当を提案しても、状態は動かない**（公開 behavior で確認）', async () => {
    // ファイルの中身ではなく、**PL ループを実際に回して**到達不能であることを見る。
    // blocked Job の attention は診断まで進むので、そこで未知 action を提案させる。
    const { storage, taskId } = seed({ withBlockedJob: true })

    const result = await runPlTick(storage, {
      escalate: async () => {},
      readLedger: () => '',
      // PL が「Human Recovery したい」と言い出した状況を作る。
      diagnose: async () => JSON.stringify({
        actionKind: 'recover_task',
        rationale: 'blocked かつ Job 0 件なので再投入したい',
        riskLevel: 'LOW',
      }),
      proposeAdoption: async () => { throw new Error('attention が残るうちは採用しない') },
    })

    // Gate で止まる。実行段階（`executeAction()`）へ到達しない。
    expect(result.status).toBe('blocked')
    expect(result.proposedKind).toBe('recover_task')
    // **状態遷移が起きていない。**
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    // **human recovery の audit も書かれていない。**
    expect(latestHumanRecoveryId(storage, taskId)).toBeUndefined()
  })

  it('**本当に recover 可能な Task でも、PL tick は復旧させない**', async () => {
    // 上のテストは Job を持つ Task を使うので、仮に PL が `recoverBlockedTask()` を直接
    // 呼んでいても `TASK_HAS_JOBS` で落ちて素通りしてしまう（独立レビュー指摘）。
    // **recover の入口条件を満たす Task**（blocked / Job 0 件 / roadmapActive）で、
    // PL ループを回しても状態が動かないことを確かめる。
    const { storage, taskId } = seed()
    // 前提: この Task は人が呼べば実際に復旧できる。
    expect(recoverBlockedTask(storage, { taskId, reason: 'precondition check' }).ok).toBe(true)
    storage.tasks.update(taskId, { status: 'blocked' })

    const result = await runPlTick(storage, {
      escalate: async () => {},
      readLedger: () => '',
      diagnose: async () => JSON.stringify({
        actionKind: 'recover_task', rationale: '再投入したい', riskLevel: 'LOW',
      }),
      proposeAdoption: async () => { throw new Error('attention が残るうちは採用しない') },
    })

    // notify-only なので診断すら回らず、PL は通知して終わる。
    expect(result.status).toBe('escalated')
    // **PL は状態を1ビットも動かしていない。**
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
    // 人が呼んだ1回ぶんだけが記録されており、PL の分は増えていない。
    expect(latestHumanRecoveryId(storage, taskId)).toBeDefined()
  })

  it('**Human Recovery 自体は後段 Approval の証拠にならない。** ApprovalRequest を作らない', () => {
    const { storage, taskId } = seed()

    recoverBlockedTask(storage, { taskId, reason: 'r' })

    // `checkApprovalGate()` は `approvalRequests.findById()` を根拠にする。
    // 行が1件も作られない以上、この操作を証拠として束縛する方法が無い。
    expect(storage.approvalRequests.findByTaskId(taskId)).toHaveLength(0)
    expect(storage.approvalRequests.findActiveByTaskId(taskId)).toBeUndefined()
    // audit 行は残るが、それは `approval_gate` の語彙ではない。
    const audit = storage.auditLog.findByEntity('task', taskId)
    expect(audit.every((entry) => entry.operation !== 'approval_granted')).toBe(true)
  })
})
