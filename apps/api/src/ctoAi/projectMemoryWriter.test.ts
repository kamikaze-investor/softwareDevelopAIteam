import { describe, it, expect, beforeEach } from 'vitest'
import { writeProjectMemory } from './projectMemoryWriter.js'
import type { SpecAnalysis } from './specAnalyzer.js'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'

/** target-project は実運用では常にgit repoであるため、テストでも同じ前提を再現する */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
}

const MOCK_ANALYSIS: SpecAnalysis = {
  goal: 'テスト用ゴール',
  designPhilosophy: ['シンプルさ優先'],
  mvpScope: {
    description: '最小構成',
    includedFeatures: ['ログイン'],
    excludedFeatures: ['多言語対応'],
  },
  targetUsers: ['個人ユーザー'],
  techStack: ['TypeScript'],
  gaps: [],
  requiredExternalServices: [],
  readinessScore: 80,
  readinessReason: '十分に明確',
}

describe('writeProjectMemory', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `project-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    initGitRepo(tmpDir)
  })

  it('docs/project_memory 配下に5ファイルを生成する', () => {
    const result = writeProjectMemory(MOCK_ANALYSIS, tmpDir)

    expect(result.writtenFiles).toHaveLength(5)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'goal.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'design_philosophy.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'mvp_scope.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'gap_analysis.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'external_services.md'))).toBe(true)
  })

  // 2026-08-23 live E2Eで再現: 書き込んだファイルがuncommittedのまま残ると、
  // 直後にauto-startされる実装JobのFile Change Guardがこれらを誤って
  // 「Taskによる変更」として検出しallowedPaths外でblockしてしまっていた。
  it('書き込んだファイルをその場でcommitし、working treeをcleanな状態にする', () => {
    writeProjectMemory(MOCK_ANALYSIS, tmpDir)

    const status = execFileSync('git', ['status', '--porcelain'], { cwd: tmpDir }).toString()
    expect(status.trim()).toBe('')

    const log = execFileSync('git', ['log', '--oneline'], { cwd: tmpDir }).toString()
    expect(log).toContain('chore(cto-ai): update project memory docs')
  })

  it('2回連続で呼んでもエラーにならない', () => {
    writeProjectMemory(MOCK_ANALYSIS, tmpDir)
    expect(() => writeProjectMemory(MOCK_ANALYSIS, tmpDir)).not.toThrow()
  })
})
