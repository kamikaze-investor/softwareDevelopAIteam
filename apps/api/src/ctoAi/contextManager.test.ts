import { describe, it, expect, beforeEach } from 'vitest'
import { buildContextPack, taskToContextPackSummary } from './contextManager.js'
import type { TaskSummary } from './contextManager.js'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import type { Task } from '@ai-team/shared'

function makeTmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
}

const SAMPLE_TASK: TaskSummary = {
  id: 'task-001',
  title: '共有型定義',
  description: 'packages/shared に型を追加する',
  phase: 1,
  assignee: 'developer_ai',
  dependencies: [],
  acceptanceCriteria: ['型エラーがない', 'テストが通る'],
  allowedPaths: ['packages/shared/src/'],
  estimatedComplexity: 'small',
}

function dbTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'uuid-task-001',
    projectId: 'project-001',
    title: 'DB task',
    description: 'DB description',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
    allowedPaths: ['apps/api/src/'],
    acceptanceCriteria: ['done'],
    roadmapTaskKey: 'task-001',
    phase: 1,
    roadmapActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildContextPack', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  it('基本的なContextPackを生成できる', () => {
    const pack = buildContextPack(SAMPLE_TASK, tmpDir)

    expect(pack.task.id).toBe('task-001')
    expect(pack.targetProjectRoot).toBe(tmpDir)
    expect(pack.generatedAt).toBeTruthy()
    expect(pack.instruction).toContain('task-001')
    expect(pack.instruction).toContain('共有型定義')
  })

  it('acceptanceCriteria がインストラクションに含まれる', () => {
    const pack = buildContextPack(SAMPLE_TASK, tmpDir)
    expect(pack.instruction).toContain('型エラーがない')
    expect(pack.instruction).toContain('テストが通る')
  })

  it('allowedPaths がインストラクションに含まれる', () => {
    const pack = buildContextPack(SAMPLE_TASK, tmpDir)
    expect(pack.instruction).toContain('packages/shared/src/')
  })

  it('Constitution 3.14〜3.15 の原則本文がインストラクションに含まれる', () => {
    const pack = buildContextPack(SAMPLE_TASK, tmpDir)

    expect(pack.instruction).toContain('## 3.14 Minimum Sufficient Validation')
    expect(pack.instruction).toContain('必要最小限の独立した反証レビュー')
    expect(pack.instruction).toContain('CEO確認は、原則として次の場合に限る')
  })

  it('存在しないパスは isNew: true で返す', () => {
    const pack = buildContextPack(SAMPLE_TASK, tmpDir)
    const newFile = pack.relevantFiles.find(f => f.isNew)
    expect(newFile).toBeTruthy()
    expect(newFile!.isNew).toBe(true)
  })

  it('既存ファイルの内容を読み込む', () => {
    // tmpDir に実際のファイルを作成
    const srcDir = path.join(tmpDir, 'packages', 'shared', 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1')

    const task = { ...SAMPLE_TASK }
    const pack = buildContextPack(task, tmpDir)

    const found = pack.relevantFiles.find(f => f.relativePath.includes('index.ts'))
    expect(found).toBeTruthy()
    expect(found!.content).toContain('export const x = 1')
    expect(found!.isNew).toBe(false)
  })

  it('Project Memory (goal.md) が存在すれば読み込む', () => {
    const memDir = path.join(tmpDir, 'docs', 'project_memory')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(
      path.join(memDir, 'goal.md'),
      '# Goal\n\nコンテンツ自動配信システムを構築する\n\nよりよいもの',
    )

    const pack = buildContextPack(SAMPLE_TASK, tmpDir)
    expect(pack.projectMemory.goal).toContain('コンテンツ自動配信システム')
    expect(pack.instruction).toContain('コンテンツ自動配信システム')
  })

  it('Project Memory がなくてもエラーにならない', () => {
    const pack = buildContextPack(SAMPLE_TASK, tmpDir)
    expect(pack.projectMemory).toBeDefined()
    expect(pack.projectMemory.goal).toBeUndefined()
  })

  it('dependencies がインストラクションに含まれる', () => {
    const task = { ...SAMPLE_TASK, dependencies: ['task-000'] }
    const pack = buildContextPack(task, tmpDir)
    expect(pack.instruction).toContain('task-000')
  })

  it('converts a DB Task to a Context Pack TaskSummary with medium complexity', () => {
    const summary = taskToContextPackSummary(dbTask(), [dbTask()])

    expect(summary).toMatchObject({
      id: 'task-001',
      title: 'DB task',
      description: 'DB description',
      phase: 1,
      assignee: 'developer_ai',
      dependencies: [],
      acceptanceCriteria: ['done'],
      allowedPaths: ['apps/api/src/'],
      estimatedComplexity: 'medium',
    })
  })

  it('converts dependency UUIDs to roadmapTaskKey values and ignores unresolved IDs', () => {
    const dependency = dbTask({
      id: 'uuid-task-001',
      roadmapTaskKey: 'task-001',
    })
    const task = dbTask({
      id: 'uuid-task-002',
      roadmapTaskKey: 'task-002',
      dependencies: ['uuid-task-001', 'missing-task'],
    })

    const summary = taskToContextPackSummary(task, [dependency, task])

    expect(summary.id).toBe('task-002')
    expect(summary.dependencies).toEqual(['task-001'])
  })
})
