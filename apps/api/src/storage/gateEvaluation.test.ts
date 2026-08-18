import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from './sqlite'
import type { IStorage } from './interface'

/**
 * Gate評価のdurable evidence。
 *
 * 「このcommit/diffに対してGate評価が実行され、結果がこうだった」ことを
 * API/DB側で独立に証明できることを確認する。Workerの自己申告は使わない。
 */

function seed(storage: IStorage): string {
  const project = storage.projects.create({
    name: 'P', goal: 'g', designPhilosophy: [], status: 'running',
  })
  return storage.tasks.create({
    projectId: project.id, title: 'T', description: '', status: 'in_progress',
    assignee: 'developer_ai', dependencies: [],
  }).id
}

describe('gate evaluation evidence', () => {
  let storage: IStorage
  let taskId: string

  beforeEach(() => {
    storage = createSQLiteStorage(':memory:')
    taskId = seed(storage)
  })

  it('対象と判断を一意に結び付ける情報を保持する', () => {
    const evidence = storage.gateEvaluations.create({
      taskId,
      jobId: 'job-1',
      targetBranch: 'ai/task-001',
      targetCommit: 'abc123',
      targetDiffHash: 'diff-hash-1',
      decision: 'ALLOW',
      riskLevel: 'LOW',
      triggeredRules: [],
      policyVersion: 'gate-policy-v1',
    })

    expect(evidence.id).toBeTruthy()
    expect(evidence.createdAt).toBeTruthy()

    const stored = storage.gateEvaluations.findByTaskId(taskId)[0]
    expect(stored).toMatchObject({
      taskId,
      jobId: 'job-1',
      targetBranch: 'ai/task-001',
      targetCommit: 'abc123',
      targetDiffHash: 'diff-hash-1',
      decision: 'ALLOW',
      riskLevel: 'LOW',
      policyVersion: 'gate-policy-v1',
    })
  })

  it('自動ALLOW（LOW/MEDIUM）もevidenceとして残せる', () => {
    for (const riskLevel of ['LOW', 'MEDIUM'] as const) {
      storage.gateEvaluations.create({
        taskId,
        targetBranch: 'ai/task-001',
        targetCommit: `commit-${riskLevel}`,
        targetDiffHash: `diff-${riskLevel}`,
        decision: 'ALLOW',
        riskLevel,
        triggeredRules: [],
        policyVersion: 'gate-policy-v1',
      })
    }

    const all = storage.gateEvaluations.findByTaskId(taskId)
    expect(all).toHaveLength(2)
    expect(all.every((e) => e.decision === 'ALLOW')).toBe(true)
  })

  it('commit/diffから機械的に照会できる（GitHub Actions検証用）', () => {
    storage.gateEvaluations.create({
      taskId,
      targetBranch: 'ai/task-001',
      targetCommit: 'target-commit',
      targetDiffHash: 'target-diff',
      decision: 'ALLOW',
      riskLevel: 'LOW',
      triggeredRules: [],
      policyVersion: 'gate-policy-v1',
    })

    expect(storage.gateEvaluations.findByTarget('target-commit', 'target-diff')).toHaveLength(1)
    // commitが一致してもdiffが違えば別の対象
    expect(storage.gateEvaluations.findByTarget('target-commit', 'other-diff')).toHaveLength(0)
    expect(storage.gateEvaluations.findByTarget('other-commit', 'target-diff')).toHaveLength(0)
  })

  it('BLOCKEDやREJECTEDも同じ構造で残る（ALLOWだけを特別扱いしない）', () => {
    for (const decision of ['ALLOW', 'BLOCKED', 'REJECTED', 'STALE'] as const) {
      storage.gateEvaluations.create({
        taskId,
        targetBranch: 'b',
        targetCommit: `c-${decision}`,
        targetDiffHash: `d-${decision}`,
        decision,
        riskLevel: 'HIGH',
        triggeredRules: ['rule-a'],
        policyVersion: 'gate-policy-v1',
      })
    }

    const decisions = storage.gateEvaluations.findByTaskId(taskId).map((e) => e.decision).sort()
    expect(decisions).toEqual(['ALLOW', 'BLOCKED', 'REJECTED', 'STALE'])
  })

  it('triggeredRulesが往復する', () => {
    storage.gateEvaluations.create({
      taskId,
      targetBranch: 'b',
      targetCommit: 'c',
      targetDiffHash: 'd',
      decision: 'BLOCKED',
      riskLevel: 'CRITICAL',
      triggeredRules: ['secret_suspect', 'control_repo_change'],
      policyVersion: 'gate-policy-v1',
    })

    expect(storage.gateEvaluations.findByTaskId(taskId)[0].triggeredRules)
      .toEqual(['secret_suspect', 'control_repo_change'])
  })

  it('ApprovalRequestのHuman Approval semanticsを汚さない', () => {
    storage.gateEvaluations.create({
      taskId,
      targetBranch: 'b',
      targetCommit: 'c',
      targetDiffHash: 'd',
      decision: 'ALLOW',
      riskLevel: 'LOW',
      triggeredRules: [],
      policyVersion: 'gate-policy-v1',
    })

    // 自動ALLOWのevidenceを作っても、人間承認待ちは1件も生まれない
    expect(storage.approvalRequests.findByTaskId(taskId)).toHaveLength(0)
  })
})
