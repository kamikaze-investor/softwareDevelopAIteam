/**
 * 「blocked かつ Job 0 件」を**見えるようにした**ことの検証。
 *
 * この状態は 2026-09-18 の read-only 調査で、`:memory:` storage に同じ状態を作って
 * `attention = []` / `resumeBlockedTask() = "No jobs exist for this task"` を実測した。
 * 直す対象は「復旧経路が無い」ことだけでなく、**誰にも見えない**ことでもある。
 *
 * 固定する invariant:
 *   1. blocked かつ Job 0 件の Task は attention に出る
 *   2. PL はそれを **notify-only** として扱う（診断も Gate も経ず、1回通知して終わる）
 *   3. 通知本文は「あなたの操作だけが解ける」ことを伝える
 *   4. 既存の attention の出方を変えていない
 */

import { describe, expect, it } from 'vitest'
import type { IStorage } from '../storage/interface'
import { createSQLiteStorage } from '../storage/sqlite'
import { buildSystemState } from '../state/systemState'
import { runPlTick, type PlLoopDeps } from '../pl/executionLoop'
import { recoverBlockedTask } from './recoverBlockedTask'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'
import { buildInitialImplementAiCliPrompt } from '../ctoAi/initialImplementWorkflow'

function seedBlockedWithoutJob(options: {
  projectStatus?: 'running' | 'paused'
  withJob?: boolean
  parked?: boolean
  /** 自律ループから到達できる形か（`roadmapActive`）。既定は到達できる。 */
  reachable?: boolean
} = {}): { storage: IStorage; taskId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS',
    goal: 'g',
    designPhilosophy: [],
    status: options.projectStatus ?? 'running',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'continuation が非 retryable に skip した Task',
    description: 'body',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: options.reachable !== false,
  } as Parameters<IStorage['tasks']['create']>[0])

  if (options.withJob === true) {
    storage.jobs.create({
      taskId: task.id,
      projectId: project.id,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'noop' },
    } as never)
  }
  if (options.parked === true) {
    storage.auditLog.record({
      actor: 'api',
      operation: 'task_aborted',
      entityType: 'task',
      entityId: task.id,
      result: 'success',
      detail: 'parked',
    })
  }

  storage.tasks.update(task.id, { status: 'blocked' })
  return { storage, taskId: task.id }
}

function deps(over: Partial<PlLoopDeps> = {}): PlLoopDeps {
  return {
    escalate: async () => {},
    readLedger: () => '',
    diagnose: async () => {
      throw new Error('notify-only の attention で diagnose を呼んではならない')
    },
    proposeAdoption: async () => {
      throw new Error('attention が残っているうちは採用へ進んではならない')
    },
    ...over,
  }
}

describe('attention: task_blocked_without_job', () => {
  it('blocked かつ Job 0 件の Task が attention に出る', () => {
    const { storage, taskId } = seedBlockedWithoutJob()

    const state = buildSystemState(storage)

    expect(state.attention).toHaveLength(1)
    expect(state.attention[0]).toMatchObject({ kind: 'task_blocked_without_job', taskId })
  })

  it('Job があるものはこの kind では出さない（既存 job_blocked の担当のまま）', () => {
    const { storage } = seedBlockedWithoutJob({ withJob: true })

    const kinds = buildSystemState(storage).attention.map((item) => item.kind)

    expect(kinds).not.toContain('task_blocked_without_job')
    expect(kinds).toContain('job_blocked')
  })

  it('park された Task は出さない（解消できる者がいないものを鳴らし続けない）', () => {
    const { storage } = seedBlockedWithoutJob({ parked: true })

    expect(buildSystemState(storage).attention).toHaveLength(0)
  })

  it('running でない Project は出さない（CEO がまだ進めると決めていない）', () => {
    const { storage } = seedBlockedWithoutJob({ projectStatus: 'paused' })

    expect(buildSystemState(storage).attention).toHaveLength(0)
  })
})

describe('PL は task_blocked_without_job を通知するだけで、自分では解かない', () => {
  it('診断も Gate も経ずに1回だけ Escalate する', async () => {
    const { storage, taskId } = seedBlockedWithoutJob()
    const sent: Array<{ title: string; body: string }> = []

    const result = await runPlTick(storage, deps({
      escalate: async (payload) => { sent.push(payload) },
    }))

    expect(result.status).toBe('escalated')
    expect(result.target?.kind).toBe('task_blocked_without_job')
    expect(sent).toHaveLength(1)
    // **「あなたの操作だけが解ける」ことを伝える。**
    expect(sent[0].body).toContain('/recover')
    expect(sent[0].body).toContain('Job を1件も持っておらず')
    // PL は状態を動かしていない。
    expect(storage.tasks.findById(taskId)?.status).toBe('blocked')
    expect(storage.jobs.findByTaskId(taskId)).toHaveLength(0)
  })

  it('2 tick 目は通知を繰り返さない', async () => {
    const { storage } = seedBlockedWithoutJob()
    let sends = 0
    const d = deps({ escalate: async () => { sends += 1 } })

    await runPlTick(storage, d)
    const second = await runPlTick(storage, d)

    expect(sends).toBe(1)
    expect(second.status).toBe('idle')
  })

  it('**#255 形の CONFLICT（top-level finalDecision 無し）でも Human Recovery を案内する**', async () => {
    // `readLatestDesignReview()` の `decision` は top-level `finalDecision` の生値である。
    // #255 が書く CONFLICT はこの欄を持たないので、生値で比較すると**本番で最も多い形が漏れる**。
    // 判定は `recomputeDecision()` を通すこと（独立レビュー round 3）。
    const { storage, taskId } = seedBlockedWithoutJob()
    const task = storage.tasks.findById(taskId)!
    const designText = buildInitialImplementAiCliPrompt(task)
    const run = storage.designReviewRuns.create({
      taskId, taskTitle: task.title, designText,
      designTextHash: computeDesignTextHash(designText), changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(
      run.id, claimed.claimToken as string, 'succeeded',
      // **top-level finalDecision を意図的に持たせない。**
      JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
    )
    const sent: Array<{ title: string; body: string }> = []

    await runPlTick(storage, deps({ escalate: async (p) => { sent.push(p) } }))

    expect(sent[0].body).toContain('design_review_conflict')
    expect(sent[0].body).toContain('/recover')
    // 「証拠不足」で終わらせない。
    expect(sent[0].body).not.toContain('原因を機械的事実から特定できませんでした')
    // **分類と本文・証拠が同じ値を指すこと。** 分類だけ再計算して本文へ生値を出すと、
    // この形では「Design Review は undefined」と書かれた報告になる（round 4 指摘）。
    expect(sent[0].body).toContain('Design Review は CONFLICT')
    expect(sent[0].body).not.toContain('undefined')
    expect(sent[0].body).not.toContain('finalDecision = unknown')
  })

  it('**到達できない Task にも、実行できる出口を案内する**', async () => {
    // 一度「到達不能なら `/recover` を案内しない」にしたが、それは dead-end を作った:
    // park も採用し直しも `pending` を要求するので、案内を消すと**どれも実行できなく**なる
    // （独立レビュー指摘・2026-09-21）。再投入は到達不能でも Project の枠を解放するため、
    // まず戻す、が正しい案内である。
    const { storage, taskId } = seedBlockedWithoutJob({ reachable: false })
    const task = storage.tasks.findById(taskId)!
    const designText = buildInitialImplementAiCliPrompt(task)
    const run = storage.designReviewRuns.create({
      taskId, taskTitle: task.title, designText,
      designTextHash: computeDesignTextHash(designText), changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(
      run.id, claimed.claimToken as string, 'succeeded',
      JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
    )
    const sent: Array<{ title: string; body: string }> = []

    await runPlTick(storage, deps({ escalate: async (p) => { sent.push(p) } }))

    // 先に戻すこと、戻せば枠が解放されることが書いてある。
    expect(sent[0].body).toContain('/recover')
    expect(sent[0].body).toContain('枠は解放される')
    // park も採用し直しも `pending` が前提であることを明示している。
    expect(sent[0].body).toContain('TASK_NOT_PARKABLE')
    // 案内どおり叩けば実際に通る（案内と endpoint が食い違わない）。
    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }).ok).toBe(true)
  })

  it('**CONFLICT と断定できないときも、park より先に戻せと案内する**', async () => {
    // 原因を CONFLICT と特定できないと `rootCauseClass='unknown'` になる。汎用の選択肢へ
    // 落とすと **park を勧めておきながら `TASK_NOT_PARKABLE` で弾かれる**
    // （独立レビュー round 5 指摘）。分岐の鍵は原因ではなく attention の kind である。
    const { storage, taskId } = seedBlockedWithoutJob()   // Design Review run を作らない
    const sent: Array<{ title: string; body: string }> = []

    await runPlTick(storage, deps({ escalate: async (p) => { sent.push(p) } }))

    expect(sent[0].body).toContain('/recover')
    expect(sent[0].body).toContain('TASK_NOT_PARKABLE')
    // 案内どおり叩けば実際に通る。
    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }).ok).toBe(true)
  })

  it('**Remediation の対象条件を満たさない CONFLICT で、Remediation を約束しない**', async () => {
    // 到達可能で予算も残っているが `roadmapTaskKey` が無いので
    // `findRemediationSubject()` は undefined を返す。「到達可能 かつ 予算あり」だけで
    // 判定していたときは、ここで Remediation を約束して endpoint と食い違っていた
    // （独立レビュー round 5 指摘）。
    const { storage, taskId } = seedBlockedWithoutJob()
    const task = storage.tasks.findById(taskId)!
    const designText = buildInitialImplementAiCliPrompt(task)
    const run = storage.designReviewRuns.create({
      taskId, taskTitle: task.title, designText,
      designTextHash: computeDesignTextHash(designText), changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(run.id, 3)
    storage.designReviewRuns.complete(
      run.id, claimed.claimToken as string, 'succeeded',
      JSON.stringify({ focusedReviewResults: [{ focus: 'scope_simplicity', decision: 'CONFLICT' }] }),
    )
    const sent: Array<{ title: string; body: string }> = []

    await runPlTick(storage, deps({ escalate: async (p) => { sent.push(p) } }))

    // 案内と endpoint が同じ値を指している。
    const result = recoverBlockedTask(storage, { taskId, reason: 'r' })
    expect(result).toMatchObject({ ok: true, nextDriver: 'attention_only' })
    expect(sent[0].body).not.toContain('Independent Remediation が fresh Design Review を起こす')
    expect(sent[0].body).toContain('戻しても自動では進まない')
  })

  it('**再投入して再び同じ状態に落ちたら、もう一度通知する**', async () => {
    // `hasEscalated()` は生涯キーで重複通知を抑止する。attention の identity を Task だけに
    // すると、2回目のエピソードが永久に通知されない（独立レビュー指摘・2026-09-18）。
    const { storage, taskId } = seedBlockedWithoutJob()
    let sends = 0
    const d = deps({ escalate: async () => { sends += 1 } })

    await runPlTick(storage, d)
    expect(sends).toBe(1)

    // CEO が再投入し、その後システムが独立に同じ dead state へ戻った。
    expect(recoverBlockedTask(storage, { taskId, reason: 'r' }).ok).toBe(true)
    storage.tasks.update(taskId, { status: 'blocked' })

    const second = await runPlTick(storage, d)

    expect(second.status).toBe('escalated')
    expect(sends).toBe(2)
  })
})
