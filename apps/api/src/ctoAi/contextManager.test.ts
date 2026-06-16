import { describe, it, expect, beforeEach } from 'vitest'
import { buildContextPack } from './contextManager.js'
import type { TaskSummary } from './contextManager.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

function makeTmp(): string {
  const dir = path.join(os.tmpdir(), `ctx-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
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
})
