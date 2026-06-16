import { describe, it, expect, beforeEach } from 'vitest'
import { writeRoadmap } from './roadmapWriter.js'
import type { Roadmap } from './roadmapGenerator.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'

const MOCK_ROADMAP: Roadmap = {
  phases: [
    {
      number: 1,
      name: '基盤構築',
      goal: '型定義とDBを揃える',
      tasks: ['task-001'],
    },
  ],
  tasks: [
    {
      id: 'task-001',
      title: '共有型定義',
      description: 'packages/shared に型を追加',
      phase: 1,
      assignee: 'developer_ai',
      dependencies: [],
      acceptanceCriteria: ['型エラーがない'],
      allowedPaths: ['packages/shared/src/'],
      estimatedComplexity: 'small',
    },
  ],
  totalTasks: 1,
  estimatedWeeks: 1,
}

describe('writeRoadmap', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `roadmap-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  it('docs/roadmap.md と tasks/task_graph.md を生成する', () => {
    const result = writeRoadmap(MOCK_ROADMAP, tmpDir)

    expect(result.writtenFiles).toHaveLength(2)
    expect(existsSync(path.join(tmpDir, 'docs', 'roadmap.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'tasks', 'task_graph.md'))).toBe(true)
  })

  it('roadmap.md にフェーズ名とタスクが含まれる', () => {
    writeRoadmap(MOCK_ROADMAP, tmpDir)
    const content = readFileSync(path.join(tmpDir, 'docs', 'roadmap.md'), 'utf-8')
    expect(content).toContain('基盤構築')
    expect(content).toContain('task-001')
    expect(content).toContain('共有型定義')
    expect(content).toContain('型エラーがない')
  })

  it('task_graph.md にマークダウンテーブルが含まれる', () => {
    writeRoadmap(MOCK_ROADMAP, tmpDir)
    const content = readFileSync(path.join(tmpDir, 'tasks', 'task_graph.md'), 'utf-8')
    expect(content).toContain('| task-001 |')
    expect(content).toContain('[ ]')
    expect(content).toContain('developer_ai')
  })

  it('targetDir を返す', () => {
    const result = writeRoadmap(MOCK_ROADMAP, tmpDir)
    expect(result.targetDir).toBe(tmpDir)
  })
})
