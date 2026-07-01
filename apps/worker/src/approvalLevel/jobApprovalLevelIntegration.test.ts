import { describe, it, expect } from 'vitest'
import { evaluateJobApprovalLevel } from './jobApprovalLevelIntegration.js'
import type { JobApprovalLevelInput } from './jobApprovalLevelIntegration.js'

describe('evaluateJobApprovalLevel', () => {
  it('docsのみの変更 → reviewPolicy:mechanical_only, level:0 を返す', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-1',
      taskId: 'task-1',
      changedFiles: ['docs/README.md'],
      diffText: '+# タイトル\n+説明文',
    }
    const result = evaluateJobApprovalLevel(input)
    expect(result.level).toBe(0)
    expect(result.reviewPolicy).toBe('mechanical_only')
  })

  it('型定義追加のみ → level:1、reviewPolicyはmechanical_onlyまたはlight_ai_post_reviewを返す', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-2',
      taskId: 'task-2',
      changedFiles: ['packages/shared/src/types/example.ts'],
      diffText: '+export interface Example {\n+  id: string\n+}',
    }
    const result = evaluateJobApprovalLevel(input)
    expect(result.level).toBe(1)
    expect(['mechanical_only', 'light_ai_post_review']).toContain(result.reviewPolicy)
  })

  it('jobRunner.tsを含む変更 → reviewPolicy:full_pre_post_review, level:2 を返す', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-3',
      taskId: 'task-3',
      changedFiles: ['apps/worker/src/jobRunner.ts'],
      diffText: '+const x = 1',
    }
    const result = evaluateJobApprovalLevel(input)
    expect(result.level).toBe(2)
    expect(result.reviewPolicy).toBe('full_pre_post_review')
  })

  it('postTestHook.ps1を含む変更（Mechanical Gate hit）→ reviewPolicy:ceo_required, level:3 を返す', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-4',
      taskId: 'task-4',
      changedFiles: ['apps/worker/scripts/postTestHook.ps1'],
      diffText: '+Write-Host "test"',
    }
    const result = evaluateJobApprovalLevel(input)
    expect(result.level).toBe(3)
    expect(result.reviewPolicy).toBe('ceo_required')
  })

  it('taskKind未指定でも正しく動作する', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-5',
      taskId: 'task-5',
      changedFiles: ['docs/README.md'],
      diffText: '+説明',
    }
    expect(() => evaluateJobApprovalLevel(input)).not.toThrow()
  })

  it('taskKindを指定した場合でも正しく動作する', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-6',
      taskId: 'task-6',
      changedFiles: ['apps/worker/src/jobRunner.ts'],
      diffText: '+const x = 1',
      taskKind: 'job_runner_change',
    }
    const result = evaluateJobApprovalLevel(input)
    expect(result.level).toBe(2)
  })

  it('戻り値のjobId/taskIdが入力とそのまま一致する', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-7',
      taskId: 'task-7',
      changedFiles: ['docs/README.md'],
      diffText: '+説明',
    }
    const result = evaluateJobApprovalLevel(input)
    expect(result.jobId).toBe('job-7')
    expect(result.taskId).toBe('task-7')
  })

  it('戻り値はApprovalLevelResultそのものであり、blocking判定用の追加フィールド（allowed等）を持たない', () => {
    const input: JobApprovalLevelInput = {
      jobId: 'job-8',
      taskId: 'task-8',
      changedFiles: ['apps/worker/scripts/postTestHook.ps1'],
      diffText: '+Write-Host "test"',
    }
    const result = evaluateJobApprovalLevel(input)
    // ApprovalLevelResult型が持つべきフィールドのみ存在することを確認
    expect(result).toHaveProperty('level')
    expect(result).toHaveProperty('reviewPolicy')
    expect(result).toHaveProperty('confidence')
    expect(result).toHaveProperty('mechanicalGate')
    expect(result).toHaveProperty('classifierResult')
    expect(result).not.toHaveProperty('allowed')
    expect(result).not.toHaveProperty('blocked')
  })
})
