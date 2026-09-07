import { describe, it, expect, beforeEach } from 'vitest'
import { writeProjectMemory } from './projectMemoryWriter.js'
import type { SpecAnalysis } from './specAnalyzer.js'
import { computeProjectDefinitionHash } from './projectDefinitionAnalysis.js'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync } from 'node:fs'

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
  structuredConstraints: [
    {
      kind: 'allowed_path_prefixes',
      value: ['docs/'],
      description: 'Only docs may be changed.',
      sourceText: 'only touch docs/',
    },
  ],
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

  it('docs/project_memory 配下に6ファイルを生成する', () => {
    const result = writeProjectMemory(MOCK_ANALYSIS, tmpDir)

    expect(result.writtenFiles).toHaveLength(6)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'goal.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'design_philosophy.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'mvp_scope.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'gap_analysis.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'external_services.md'))).toBe(true)
    expect(existsSync(path.join(tmpDir, 'docs', 'project_memory', 'project_definition.json'))).toBe(true)
  })

  it('project_definition.json に定義hashと構造化制約hashを書き出す', () => {
    const canonicalDefinitionText = '# Goal\n\nCanonical test goal'

    const result = writeProjectMemory(MOCK_ANALYSIS, tmpDir, { canonicalDefinitionText })

    expect(result.writtenFiles).toContain('docs/project_memory/project_definition.json')
    const metadata = JSON.parse(readFileSync(path.join(tmpDir, 'docs', 'project_memory', 'project_definition.json'), 'utf-8')) as {
      definitionHash: string
      generatedAt: string
      goal: string
      designPhilosophy: string[]
      structuredConstraints: SpecAnalysis['structuredConstraints']
      constraintsHash: string
    }
    expect(metadata).toMatchObject({
      definitionHash: computeProjectDefinitionHash(canonicalDefinitionText),
      goal: MOCK_ANALYSIS.goal,
      designPhilosophy: MOCK_ANALYSIS.designPhilosophy,
      structuredConstraints: MOCK_ANALYSIS.structuredConstraints,
      constraintsHash: computeProjectDefinitionHash(JSON.stringify(MOCK_ANALYSIS.structuredConstraints)),
    })
    expect(result.definitionHash).toBe(metadata.definitionHash)
    expect(result.constraintsHash).toBe(metadata.constraintsHash)
    expect(Date.parse(metadata.generatedAt)).not.toBeNaN()
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

  // CEOへ質問されないAI-resolvableなGapにとって、gap_analysis.md が後続AIへの唯一の
  // 引き継ぎ点になる。ここから落ちると「CEOにも聞かれず、AIにも渡らない」情報になる。
  it('AI-resolvableなGapもgap_analysis.mdへ残し、解決の担当を明記する', () => {
    writeProjectMemory({
      ...MOCK_ANALYSIS,
      gaps: [
        { category: 'technical', description: '依存関係の表現方法', severity: 'must_resolve', suggestion: '既存の型を調べる', decisionOwner: 'ai' },
        { category: 'technical', description: '既存の動きを変えてよいか', severity: 'must_resolve', suggestion: '変えない', decisionOwner: 'ceo' },
        { category: 'other', description: 'ownerなしの旧形式', severity: 'should_resolve', suggestion: 's' },
      ],
    }, tmpDir)

    const content = readFileSync(path.join(tmpDir, 'docs', 'project_memory', 'gap_analysis.md'), 'utf-8')

    expect(content).toContain('依存関係の表現方法')
    expect(content).toContain('既存の動きを変えてよいか')
    expect(content).toContain('ownerなしの旧形式')
    expect(content).toContain('AI調査で解決')
    expect(content).toContain('CEO判断')
    // 欠落ownerはCEO判断側へ倒す（CEO質問側の判定と揃える）
    expect(content.split('ownerなしの旧形式')[1]).toContain('CEO判断')
  })

  // 後続AIが機械的に読む経路。markdownの表示ラベルへ結合させないための構造化フィールド。
  it('project_definition.jsonへAI調査担当Gapを構造化して書き出す', () => {
    writeProjectMemory({
      ...MOCK_ANALYSIS,
      gaps: [
        { category: 'technical', description: '依存関係の表現方法', severity: 'must_resolve', suggestion: '既存の型を調べる', decisionOwner: 'ai' },
        { category: 'technical', description: '既存の動きを変えてよいか', severity: 'must_resolve', suggestion: '変えない', decisionOwner: 'ceo' },
        { category: 'other', description: 'ownerなしの旧形式', severity: 'should_resolve', suggestion: 's' },
      ],
    }, tmpDir)

    const parsed = JSON.parse(
      readFileSync(path.join(tmpDir, 'docs', 'project_memory', 'project_definition.json'), 'utf-8'),
    ) as { openTechnicalUncertainties: Array<{ description: string }> }

    expect(parsed.openTechnicalUncertainties.map((u) => u.description)).toEqual(['依存関係の表現方法'])
  })
})
