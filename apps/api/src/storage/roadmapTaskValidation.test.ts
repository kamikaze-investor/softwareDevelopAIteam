import { describe, expect, it } from 'vitest'
import { validateRoadmapTasks, validateRoadmapPhases, type RoadmapSyncTaskInput, type RoadmapSyncPhaseInput } from './roadmapTaskValidation'

function task(
  roadmapTaskKey: string,
  dependencies: string[] = [],
  phase = 1,
): RoadmapSyncTaskInput {
  return {
    roadmapTaskKey,
    title: `Task ${roadmapTaskKey}`,
    description: '',
    phase,
    assignee: 'developer_ai',
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
