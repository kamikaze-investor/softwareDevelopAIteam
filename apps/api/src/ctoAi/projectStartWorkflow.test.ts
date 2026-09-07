import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@ai-team/shared'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { ProjectInitializationError } from './projectInitialization'
import {
  awaitProjectStartForTest,
  kickProjectStart,
  recoverInterruptedProjectStarts,
  resetInFlightProjectStartsForTest,
} from './projectStartWorkflow'

/**
 * Project開始workflowのdurability契約。
 *
 * ここで固定するのは、CEOが要求した5点:
 *   1. Start応答後にMobileが一切pollしなくてもworkflowが完走する
 *   2. API process restart後も途中stageから安全に再開する
 *   3. 同じstartを二重kickしてもTask/Roadmapが重複しない
 *   4. blocked（CEO判断待ち）は勝手に再開しない
 *   5. Project-startのstageは読み取りだけでは進まない
 *      （「GETが全面的にread-onlyである」ことは主張しない。既存のTask continuationは
 *      GETをretry driverとして使っており、その副作用は別roadmap項目で扱う。
 *      ルート層の検証は`routes/projects.test.ts`側にある）
 */
describe('Project開始workflowのdurability', () => {
  let storage: IStorage

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    resetInFlightProjectStartsForTest()
  })

  function createProject(status: Project['status'] = 'running'): Project {
    return storage.projects.create({
      name: 'P',
      goal: 'G',
      designPhilosophy: [],
      status,
    })
  }

  /** roadmapActiveなTaskを1件作る＝開始workflowが完了した状態を作る。 */
  function seedRoadmapTask(projectId: string): void {
    storage.tasks.syncRoadmapTasks({
      projectId,
      tasks: [{
        roadmapTaskKey: 'task-001',
        title: 'T',
        description: 'D',
        phase: 1,
        assignee: 'developer_ai',
        category: 'implementation',
        dependencies: [],
        acceptanceCriteria: [],
        allowedPaths: ['src/'],
      }],
      phases: [{ phaseNumber: 1, name: 'P1', goal: 'g' }],
    })
  }

  it('1. Start受理は即座に返り、その後Mobileが一切pollしなくてもworkflowは完走する', async () => {
    const project = createProject()
    // workflowの完了タイミングをテスト側で握る。これが無いとモックが同期的に完走してしまい、
    // 「受理してから継続する」という非同期契約そのものを検証できない。
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    const initialize = vi.fn(async (_s, p: Project, _root, options) => {
      await gate
      options.onStage?.('deterministic_validation')
      options.onStage?.('task_sync')
      seedRoadmapTask(p.id)
    })

    const accepted = kickProjectStart(storage, project, {}, { initialize: initialize as never })

    // まだworkflowは終わっていないのに、受理は完了している
    expect(accepted).toBe(true)
    expect(storage.projects.findById(project.id)?.startStage).toBe('roadmap_generation')

    // ここから先、GETは一度も呼ばない
    release()
    await awaitProjectStartForTest(project.id)

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(storage.projects.findById(project.id)?.startStage).toBe('completed')
  })

  it('2. 中断されたstartは起動時recoveryで再kickされ、途中stageから再開する', async () => {
    const project = createProject()
    // 前プロセスがroadmap_generationまで進んで落ちた状態を再現する
    storage.projects.updateStartStage(project.id, 'roadmap_generation')

    const initialize = vi.fn(async (_s, p: Project) => { seedRoadmapTask(p.id) })
    const { rekicked, resumed } = await recoverInterruptedProjectStarts(storage, { initialize: initialize as never })

    expect(rekicked).toEqual([project.id])
    await awaitProjectStartForTest(project.id)
    expect(storage.projects.findById(project.id)?.startStage).toBe('completed')
  })

  it('2b. Roadmapがsync済みならRoadmapを再生成せず、初回Jobの保証だけをresumeして完了する', async () => {
    // Roadmap GeneratorはLLMなので、resumeで再生成するとcrash前と別内容になりうる。
    // 既にsync済みのRoadmapがあるならそれが権威で、残りの安全な境界だけを埋める。
    const project = createProject()
    storage.projects.updateStartStage(project.id, 'task_sync')
    seedRoadmapTask(project.id)

    const initialize = vi.fn()
    const ensureInitialWorkflows = vi.fn(async () => [])
    const { rekicked, resumed } = await recoverInterruptedProjectStarts(storage, {
      initialize: initialize as never,
      ensureInitialWorkflows: ensureInitialWorkflows as never,
    })

    // Roadmapは再生成しない
    expect(initialize).not.toHaveBeenCalled()
    expect(rekicked).toEqual([])
    // 初回Jobの保証だけを行って完了させる
    expect(ensureInitialWorkflows).toHaveBeenCalledTimes(1)
    expect(resumed).toEqual([project.id])
    expect(storage.projects.findById(project.id)?.startStage).toBe('completed')
  })

  it('2b-2. resume中のエラーはblockedで安全停止する', async () => {
    const project = createProject()
    storage.projects.updateStartStage(project.id, 'task_sync')
    seedRoadmapTask(project.id)

    const { resumed } = await recoverInterruptedProjectStarts(storage, {
      ensureInitialWorkflows: (async () => { throw new Error('job creation failed') }) as never,
    })

    expect(resumed).toEqual([])
    const blocked = storage.projects.findById(project.id)
    expect(blocked?.startStage).toBe('blocked')
    expect(blocked?.startBlockedReason).toBe('job creation failed')
  })
  it('2c. pause/archiveされたProjectは起動時recoveryで再開しない', async () => {
    const paused = createProject('paused')
    storage.projects.updateStartStage(paused.id, 'roadmap_generation')

    const initialize = vi.fn()
    const { rekicked, resumed } = await recoverInterruptedProjectStarts(storage, { initialize: initialize as never })

    expect(rekicked).toEqual([])
    expect(initialize).not.toHaveBeenCalled()
  })

  it('2d. stageが無いrunning Projectは再開対象にしない（legacy Projectを巻き込まない）', async () => {
    // status遷移と開始stageは同一storage writeで書かれるため、「runningだがstageが無い」は
    // crashの痕跡ではなく「開始要求を受けていない」を意味する。start_stage列導入前から
    // 存在するlegacy running Projectを、deploy直後に誤って再初期化してはいけない。
    const legacy = createProject()
    expect(storage.projects.findById(legacy.id)?.startStage).toBeUndefined()

    const initialize = vi.fn()
    const { rekicked, resumed } = await recoverInterruptedProjectStarts(storage, { initialize: initialize as never })

    expect(rekicked).toEqual([])
    expect(resumed).toEqual([])
    expect(initialize).not.toHaveBeenCalled()
  })

  it('2e. stageが無く、既にRoadmapとTaskを持つlegacy Projectも触らない', async () => {
    const legacy = createProject()
    seedRoadmapTask(legacy.id)

    const initialize = vi.fn()
    const ensureInitialWorkflows = vi.fn()
    const { rekicked, resumed } = await recoverInterruptedProjectStarts(storage, {
      initialize: initialize as never,
      ensureInitialWorkflows: ensureInitialWorkflows as never,
    })

    expect(rekicked).toEqual([])
    expect(resumed).toEqual([])
    expect(initialize).not.toHaveBeenCalled()
    expect(ensureInitialWorkflows).not.toHaveBeenCalled()
    expect(storage.projects.findById(legacy.id)?.startStage).toBeUndefined()
  })
  it('3. 同じstartを二重kickしてもTask/Roadmapは重複しない', async () => {
    const project = createProject()
    const initialize = vi.fn(async (_s, p: Project) => { seedRoadmapTask(p.id) })

    const first = kickProjectStart(storage, project, {}, { initialize: initialize as never })
    const second = kickProjectStart(storage, project, {}, { initialize: initialize as never })

    expect(first).toBe(true)
    // 実行中の重複kickは受理されない
    expect(second).toBe(false)

    await awaitProjectStartForTest(project.id)

    // 完了後にもう一度kickしても、既にRoadmapがあるので受理されない
    expect(kickProjectStart(storage, project, {}, { initialize: initialize as never })).toBe(false)

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(storage.tasks.findByProjectId(project.id)).toHaveLength(1)
  })

  it('4. blockedはCEO判断待ちの安全停止であり、起動時recoveryで自動再開しない', async () => {
    const project = createProject()
    const initialize = vi.fn(async () => {
      throw new ProjectInitializationError('ロードマップの検証に失敗しました', 422, { issues: ['x'] })
    })

    kickProjectStart(storage, project, {}, { initialize: initialize as never })
    await awaitProjectStartForTest(project.id)

    const blocked = storage.projects.findById(project.id)
    expect(blocked?.startStage).toBe('blocked')
    expect(blocked?.startBlockedReason).toContain('ロードマップの検証に失敗しました')

    resetInFlightProjectStartsForTest()
    const rekickInitialize = vi.fn()
    const { rekicked } = await recoverInterruptedProjectStarts(storage, { initialize: rekickInitialize as never })

    expect(rekicked).toEqual([])
    expect(rekickInitialize).not.toHaveBeenCalled()
    expect(storage.projects.findById(project.id)?.startStage).toBe('blocked')
  })

  it('5. Project-startのstageは読み取りだけでは進まない', async () => {
    const project = createProject()
    storage.projects.updateStartStage(project.id, 'focused_review')

    const before = storage.projects.findById(project.id)
    for (let i = 0; i < 5; i += 1) {
      storage.projects.findById(project.id)
      storage.projects.findAll()
    }
    const after = storage.projects.findById(project.id)

    expect(after).toEqual(before)
    expect(after?.startStage).toBe('focused_review')
  })

  it('blocked以外へ遷移したら前回のblocked理由は消える', () => {
    const project = createProject()
    storage.projects.updateStartStage(project.id, 'blocked', '前回の停止理由')
    expect(storage.projects.findById(project.id)?.startBlockedReason).toBe('前回の停止理由')

    storage.projects.updateStartStage(project.id, 'roadmap_generation')

    expect(storage.projects.findById(project.id)?.startBlockedReason).toBeUndefined()
  })
})
