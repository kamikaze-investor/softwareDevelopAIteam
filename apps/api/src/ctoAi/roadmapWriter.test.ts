import { describe, it, expect, beforeEach } from 'vitest'
import { writeRoadmap } from './roadmapWriter.js'
import type { Roadmap } from './roadmapGenerator.js'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'

/** target-project は実運用では常にgit repoであるため、テストでも同じ前提を再現する */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
}

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
    tmpDir = path.join(os.tmpdir(), `roadmap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    initGitRepo(tmpDir)
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

  // 2026-08-23 live E2Eで再現: 書き込んだファイルがuncommittedのまま残ると、
  // 直後にauto-startされる実装JobのFile Change Guardがこれらを誤って
  // 「Taskによる変更」として検出しallowedPaths外でblockしてしまっていた。
  it('書き込んだファイルをその場でcommitし、working treeをcleanな状態にする', () => {
    writeRoadmap(MOCK_ROADMAP, tmpDir)

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: tmpDir }).toString()
    expect(status.trim()).toBe('')

    const log = execFileSync('git', ['log', '--oneline'], { cwd: tmpDir }).toString()
    expect(log).toContain('chore(cto-ai): update roadmap docs')
  })

  it('2回連続で呼んでも（差分が同一でも）エラーにならない', () => {
    writeRoadmap(MOCK_ROADMAP, tmpDir)
    expect(() => writeRoadmap(MOCK_ROADMAP, tmpDir)).not.toThrow()
  })
})
