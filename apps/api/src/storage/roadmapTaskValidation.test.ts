import { describe, expect, it } from 'vitest'
import { validateRoadmapTasks, type RoadmapSyncTaskInput } from './roadmapTaskValidation'

function task(
  roadmapTaskKey: string,
  dependencies: string[] = [],
): RoadmapSyncTaskInput {
  return {
    roadmapTaskKey,
    title: `Task ${roadmapTaskKey}`,
    description: '',
    phase: 1,
    assignee: 'developer_ai',
    dependencies,
    acceptanceCriteria: [],
    allowedPaths: [],
  }
}

describe('validateRoadmapTasks', () => {
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
