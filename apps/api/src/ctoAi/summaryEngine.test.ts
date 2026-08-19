import { describe, it, expect, beforeEach } from 'vitest'
import { updateDashboard } from './summaryEngine.js'
import type { DeveloperAiResult } from './developerAiOrchestrator.js'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

function makeTmp(): string {
  // `Date.now()` だけだと、実行が速い環境（CI）で複数のテストが同一ミリ秒になり
  // 同じディレクトリを共有してしまう。前のテストが書いた dashboard.md が残るため
  // entriesInDashboard が期待値より多くなる（CIで expected 3 to be 2 として観測）。
  // 実装ではなくテストのfixtureがCI環境依存だったので、一意なディレクトリを使う。
  const dir = mkdtempSync(path.join(os.tmpdir(), 'summary-test-'))
  return dir
}

const MOCK_RESULT: DeveloperAiResult = {
  status: 'mock',
  taskId: 'task-001',
  provider: 'claude',
  stdout: '[MOCK] claude が task-001 を処理しました。\n実装完了。',
  changedFiles: ['src/types.ts', 'src/index.ts'],
  exitCode: 0,
  executedAt: '2026-06-16T10:00:00.000Z',
  completedAt: '2026-06-16T10:00:05.000Z',
  durationMs: 5000,
}

describe('updateDashboard', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmp()
  })

  it('docs/dashboard.md を生成する', () => {
    updateDashboard(MOCK_RESULT, tmpDir)
    expect(existsSync(path.join(tmpDir, 'docs', 'dashboard.md'))).toBe(true)
  })

  it('dashboard.md にタスクIDと実行ステータスが含まれる', () => {
    updateDashboard(MOCK_RESULT, tmpDir)
    const content = readFileSync(path.join(tmpDir, 'docs', 'dashboard.md'), 'utf-8')
    expect(content).toContain('task-001')
    expect(content).toContain('mock')
    expect(content).toContain('claude')
  })

  it('dashboard.md に changedFiles が含まれる', () => {
    updateDashboard(MOCK_RESULT, tmpDir)
    const content = readFileSync(path.join(tmpDir, 'docs', 'dashboard.md'), 'utf-8')
    expect(content).toContain('src/types.ts')
    expect(content).toContain('src/index.ts')
  })

  it('entriesInDashboard が 1 を返す', () => {
    const result = updateDashboard(MOCK_RESULT, tmpDir)
    expect(result.entriesInDashboard).toBe(1)
  })

  it('2回実行すると entriesInDashboard が 2 になる', () => {
    updateDashboard(MOCK_RESULT, tmpDir)
    const result2 = updateDashboard({ ...MOCK_RESULT, taskId: 'task-002' }, tmpDir)
    expect(result2.entriesInDashboard).toBe(2)
  })

  it('status=success のとき task_graph.md を [x] に更新する', () => {
    const tasksDir = path.join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(
      path.join(tasksDir, 'task_graph.md'),
      '| task-001 | 共有型定義 | [ ] | — | developer_ai |\n',
    )

    // [codex-review P2修正] mock ではなく success を使う
    const result = updateDashboard({ ...MOCK_RESULT, status: 'success' }, tmpDir)
    expect(result.taskStatusUpdated).toBe(true)

    const content = readFileSync(path.join(tasksDir, 'task_graph.md'), 'utf-8')
    expect(content).toContain('[x]')
    expect(content).not.toContain('[ ]')
  })

  it('task_graph.md がなくても taskStatusUpdated は false でエラーにならない', () => {
    const result = updateDashboard(MOCK_RESULT, tmpDir)
    expect(result.taskStatusUpdated).toBe(false)
  })

  it('status=failed のとき task_graph.md を [!] に更新する', () => {
    const tasksDir = path.join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    writeFileSync(
      path.join(tasksDir, 'task_graph.md'),
      '| task-001 | 共有型定義 | [ ] | — | developer_ai |\n',
    )

    updateDashboard({ ...MOCK_RESULT, status: 'failed' }, tmpDir)
    const content = readFileSync(path.join(tasksDir, 'task_graph.md'), 'utf-8')
    expect(content).toContain('[!]')
  })

  // [codex-review P2] mock は task_graph を更新しないこと
  it('status=mock のとき task_graph.md は変更しない', () => {
    const tasksDir = path.join(tmpDir, 'tasks')
    mkdirSync(tasksDir, { recursive: true })
    const original = '| task-001 | 共有型定義 | [ ] | — | developer_ai |\n'
    writeFileSync(path.join(tasksDir, 'task_graph.md'), original)

    const result = updateDashboard(MOCK_RESULT, tmpDir)  // status='mock'
    expect(result.taskStatusUpdated).toBe(false)

    const content = readFileSync(path.join(tasksDir, 'task_graph.md'), 'utf-8')
    expect(content).toBe(original)  // 変更なし
  })

  it('stdout が dashboard.md に含まれる（省略あり）', () => {
    updateDashboard(MOCK_RESULT, tmpDir)
    const content = readFileSync(path.join(tmpDir, 'docs', 'dashboard.md'), 'utf-8')
    expect(content).toContain('[MOCK]')
  })
})
