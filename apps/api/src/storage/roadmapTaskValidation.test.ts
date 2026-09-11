import { describe, expect, it } from 'vitest'
import { validateRoadmapConstraints, validateRoadmapTasks, validateRoadmapPhases, type RoadmapSyncTaskInput, type RoadmapSyncPhaseInput } from './roadmapTaskValidation'
import type { RoadmapTaskCategory, StructuredConstraint } from '@ai-team/shared'

function task(
  roadmapTaskKey: string,
  dependencies: string[] = [],
  phase = 1,
  category: RoadmapTaskCategory = 'implementation',
): RoadmapSyncTaskInput {
  return {
    roadmapTaskKey,
    title: `Task ${roadmapTaskKey}`,
    description: '',
    phase,
    assignee: 'developer_ai',
    category,
    dependencies,
    acceptanceCriteria: [],
    allowedPaths: [],
  }
}

function phase(phaseNumber: number): RoadmapSyncPhaseInput {
  return {
    phaseNumber,
    name: `Phase ${phaseNumber}`,
    goal: `Goal ${phaseNumber}`,
  }
}

function constraint(overrides: Partial<StructuredConstraint>): StructuredConstraint {
  return {
    kind: 'max_task_count',
    value: 10,
    description: '',
    sourceText: '',
    ...overrides,
  }
}

describe('validateRoadmapTasks', () => {
  it('detects an empty roadmap', () => {
    expect(validateRoadmapTasks([])).toEqual([
      expect.objectContaining({
        code: 'empty_roadmap',
      }),
    ])
  })

  it('returns no issues for valid input', () => {
    expect(validateRoadmapTasks([
      task('task-001'),
      task('task-002', ['task-001']),
    ])).toEqual([])
  })

  it('detects duplicate roadmapTaskKey values', () => {
    const issues = validateRoadmapTasks([
      task('task-001'),
      task('task-001'),
    ])

    expect(issues).toEqual([
      expect.objectContaining({
        code: 'duplicate_roadmap_task_key',
        roadmapTaskKey: 'task-001',
      }),
    ])
  })

  it('detects self dependencies', () => {
    const issues = validateRoadmapTasks([
      task('task-001', ['task-001']),
    ])

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'self_dependency',
      roadmapTaskKey: 'task-001',
    }))
  })

  it('detects unknown dependencies', () => {
    const issues = validateRoadmapTasks([
      task('task-001', ['task-999']),
    ])

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'unknown_dependency',
      roadmapTaskKey: 'task-001',
    }))
  })

  it('detects a two-node circular dependency', () => {
    const issues = validateRoadmapTasks([
      task('task-001', ['task-002']),
      task('task-002', ['task-001']),
    ])

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'circular_dependency',
    }))
  })

  it('detects a circular dependency with three or more nodes', () => {
    const issues = validateRoadmapTasks([
      task('task-001', ['task-002']),
      task('task-002', ['task-003']),
      task('task-003', ['task-001']),
    ])

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'circular_dependency',
    }))
  })

  // allowedPaths が repository-relative であることの決定論的検証。
  // 2026-09-11 production 実測: 生成AIが "/workspace/target/test.js" を出力し、
  // File Change Guard の逐語比較に一致せず初回 implement Job が block された。
  describe('allowedPaths must be repository-relative', () => {
    function taskWithPaths(allowedPaths: string[]): RoadmapSyncTaskInput {
      return { ...task('task-001'), allowedPaths }
    }

    it('rejects the POSIX absolute path measured in production', () => {
      const issues = validateRoadmapTasks([taskWithPaths(['/workspace/target/test.js'])])

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'non_relative_allowed_path',
        roadmapTaskKey: 'task-001',
      }))
    })

    it('tells the regenerating AI how to fix it', () => {
      const [issue] = validateRoadmapTasks([taskWithPaths(['/workspace/target/test.js'])])

      // この message はそのまま priorAttemptFeedback として再生成AIへ渡る
      expect(issue?.message).toContain('/workspace/target/test.js')
      expect(issue?.message).toContain('repository-relative')
    })

    it.each([
      ['UNC path', '\\\\server\\share\\test.js'],
      ['drive-letter path', 'C:/repo/src/index.ts'],
      ['backslash drive-letter path', 'C:\\repo\\src\\index.ts'],
      ['parent traversal', '../outside/test.js'],
      ['nested parent traversal', 'src/../../outside/test.js'],
      ['leading ./', './test.js'],
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('rejects a %s', (_label, path) => {
      const issues = validateRoadmapTasks([taskWithPaths([path])])

      expect(issues).toContainEqual(expect.objectContaining({
        code: 'non_relative_allowed_path',
      }))
    })

    it.each([
      ['a repository-relative file', 'test.js'],
      ['a repository-relative directory', 'apps/engine/src/'],
      ['a nested file', 'src/runner/workflow-runner.js'],
      // "..over" は ".." セグメントではない。セグメント単位で判定していることの回帰固定
      ['a filename starting with dots', 'src/..overrides.ts'],
    ])('accepts %s', (_label, path) => {
      expect(validateRoadmapTasks([taskWithPaths([path])])).toEqual([])
    })

    it('reports every offending entry, not just the first', () => {
      const issues = validateRoadmapTasks([
        taskWithPaths(['/abs/one.ts', 'ok/two.ts', '/abs/three.ts']),
      ])

      expect(issues).toHaveLength(2)
    })

    it('runs even when the Project declares no structured constraints', () => {
      // buildDisallowedPathIssues() は allowed_path_prefixes 宣言時しか動かない。
      // 今回の production ケースは制約宣言が無かったため、常時検証である必要がある。
      const issues = validateRoadmapTasks([taskWithPaths(['/workspace/target/test.js'])])

      expect(issues).not.toEqual([])
    })
  })
})

describe('validateRoadmapPhases', () => {
  it('returns no issues for valid input', () => {
    expect(validateRoadmapPhases(
      [phase(1), phase(2)],
      [task('task-001', [], 1), task('task-002', [], 2)],
    )).toEqual([])
  })

  it('detects duplicate phase numbers', () => {
    const issues = validateRoadmapPhases(
      [phase(1), phase(1)],
      [task('task-001', [], 1)],
    )

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'duplicate_phase_number',
      phaseNumber: 1,
    }))
  })

  it('detects a task referencing an unknown phase', () => {
    const issues = validateRoadmapPhases(
      [phase(1)],
      [task('task-001', [], 2)],
    )

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'unknown_phase',
      roadmapTaskKey: 'task-001',
      phaseNumber: 2,
    }))
  })
})

describe('validateRoadmapConstraints', () => {
  it('returns no issues when all constraints are satisfied', () => {
    const tasks = [
      task('task-001', [], 1),
      task('task-002', ['task-001'], 1),
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'max_task_count', value: 3 }),
      constraint({ kind: 'max_dependency_count', value: 2 }),
      constraint({ kind: 'allowed_path_prefixes', value: ['apps/src/'] }),
    ])
    expect(result.issues).toEqual([])
    expect(result.checkedKinds).toEqual(
      expect.arrayContaining(['max_task_count', 'max_dependency_count', 'allowed_path_prefixes']),
    )
  })

  it('detects max_task_count exceeded', () => {
    const tasks = [task('task-001'), task('task-002')]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'max_task_count', value: 1 }),
    ])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'task_count_exceeded',
    }))
  })

  it('does not flag max_task_count when task count is within limit', () => {
    const tasks = [task('task-001'), task('task-002')]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'max_task_count', value: 2 }),
    ])
    expect(result.issues).toEqual([])
  })

  it('detects disallowed allowedPaths per task path', () => {
    const tasks = [
      { ...task('task-001'), allowedPaths: ['apps/locked/src/'] },
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'allowed_path_prefixes', value: ['apps/engine/src/'] }),
    ])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'disallowed_path',
      roadmapTaskKey: 'task-001',
    }))
  })

  it('accepts allowedPaths matching a declared prefix', () => {
    const tasks = [
      { ...task('task-001'), allowedPaths: ['apps/engine/src/core/'] },
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'allowed_path_prefixes', value: ['apps/engine/src/'] }),
    ])
    expect(result.issues.filter(i => i.code === 'disallowed_path')).toEqual([])
  })

  it('rejects a path that only shares a string prefix, not a real path-segment boundary, with an allowed prefix', () => {
    // "apps/engine-evil/x.ts" starts with the raw string "apps/eng" but is not actually
    // inside "apps/eng"/ -- a naive `path.startsWith(prefix)` would incorrectly allow this.
    const tasks = [
      { ...task('task-001'), allowedPaths: ['apps/engine-evil/x.ts'] },
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'allowed_path_prefixes', value: ['apps/eng'] }),
    ])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'disallowed_path',
      roadmapTaskKey: 'task-001',
    }))
  })

  it('accepts a declared prefix without a trailing slash when the path is genuinely inside it', () => {
    const tasks = [
      { ...task('task-001'), allowedPaths: ['apps/eng/src/core.ts'] },
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'allowed_path_prefixes', value: ['apps/eng'] }),
    ])
    expect(result.issues.filter(i => i.code === 'disallowed_path')).toEqual([])
  })

  it('detects max_dependency_count exceeded', () => {
    const tasks = [
      task('task-001', ['task-002', 'task-003', 'task-004']),
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'max_dependency_count', value: 2 }),
    ])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'dependency_count_exceeded',
      roadmapTaskKey: 'task-001',
    }))
  })

  it('flags a control_plane_operation task unconditionally (no constraints present)', () => {
    const tasks = [
      task('task-001', [], 1, 'implementation'),
      task('task-002', [], 1, 'control_plane_operation'),
    ]
    const result = validateRoadmapConstraints(tasks, [])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'control_plane_operation_task',
      roadmapTaskKey: 'task-002',
    }))
    expect(result.issues.filter(i => i.code === 'control_plane_operation_task')).toHaveLength(1)
  })

  it('flags a control_plane_operation task even when other constraints exist', () => {
    const tasks = [
      task('task-001', [], 1, 'control_plane_operation'),
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'max_task_count', value: 10 }),
    ])
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'control_plane_operation_task',
      roadmapTaskKey: 'task-001',
    }))
  })

  it('reports forbidden_new_files / forbidden_technologies as unchecked without acting, and does not throw', () => {
    const tasks = [
      task('task-001', [], 1, 'implementation'),
      { ...task('task-002', [], 1, 'implementation'), description: 'uses forbidden tech X and creates new file' },
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'forbidden_new_files', value: true }),
      constraint({ kind: 'forbidden_technologies', value: ['rust'] }),
    ])
    expect(result.issues).toEqual([])
    expect(result.uncheckedKinds).toEqual(
      expect.arrayContaining(['forbidden_new_files', 'forbidden_technologies']),
    )
    expect(result.checkedKinds).not.toContain('forbidden_new_files')
    expect(result.checkedKinds).not.toContain('forbidden_technologies')
  })

  it('a roadmap satisfying all constraints passes through with no issues', () => {
    const tasks = [
      { ...task('task-001', [], 1, 'implementation'), allowedPaths: ['apps/engine/src/'], dependencies: [] },
      { ...task('task-002', ['task-001'], 1, 'verification'), allowedPaths: ['apps/engine/src/'], dependencies: ['task-001'] },
    ]
    const result = validateRoadmapConstraints(tasks, [
      constraint({ kind: 'max_task_count', value: 2 }),
      constraint({ kind: 'max_dependency_count', value: 1 }),
      constraint({ kind: 'allowed_path_prefixes', value: ['apps/engine/'] }),
    ])
    expect(result.issues).toEqual([])
  })
})
