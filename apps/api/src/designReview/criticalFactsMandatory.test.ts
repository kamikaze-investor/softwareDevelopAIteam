import { beforeEach, describe, expect, it } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import {
  checkImplementJobDesignReviewEvidence,
  computeDesignTextHash,
  computeCriticalDesignFactsHash,
} from '../designReviewEvidencePolicy'
import { checkLatestChallengeCoversCurrentFacts } from './metaCriticalFactsCheck'
import { canonicalizeCriticalDesignFacts } from '@ai-team/shared'
import type { CriticalDesignFact, DesignReviewEvidence, ReviewLoad } from '@ai-team/shared'

function createTestStorage() {
  return createSQLiteStorage(':memory:')
}

function createEvidence(overrides: Partial<DesignReviewEvidence> = {}): DesignReviewEvidence {
  return {
    id: 'evidence-1',
    taskId: 'task-1',
    designTextHash: 'abc123',
    reviewLoad: 'high' as ReviewLoad,
    decision: 'ALIGNED',
    independentReviewRequired: false,
    independentReviewVerdict: undefined,
    criticalFactsSnapshot: undefined,
    criticalFactsHash: undefined,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function createBaseFacts(): CriticalDesignFact[] {
  return [
    { category: 'authority' as const, key: 'admin', value: 'required' },
    { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
    { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
    { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
    { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
  ]
}

describe('Critical Design Facts mandatory acceptance tests', () => {
  let storage: ReturnType<typeof createTestStorage>
  let taskId: string

  beforeEach(() => {
    storage = createTestStorage()
    const project = storage.projects.create({
      name: 'Test',
      goal: 'Test',
      designPhilosophy: [],
      status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id,
      title: 'Test Task',
      description: '',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
      allowedPaths: [],
      acceptanceCriteria: [],
      roadmapActive: false,
    })
    taskId = task.id
  })

  it('1. 初回Challenge → PASS evidence作成 → currentとevidenceのfacts hash一致 → gate ok:true', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'initial design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: hash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.evidence?.criticalFactsHash).toBe(hash)
    }
  })

  it('2. 非material変更（comment/wording/rename/test追加のみ相当＝Critical Factsのvalueが変わらないケース）→ hashが変わらず rechallenge不要（gate ok:true のまま）', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const factsSame: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
    ]
    const sameHash = computeCriticalDesignFactsHash(factsSame)

    expect(sameHash).toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: sameHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(true)
  })

  it('3. Authority変更（category="authority" のfact valueを変更）→ hash変化 → gate ok:false code CRITICAL_FACTS_CHANGED', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const changedFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'not-required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
    ]
    const changedHash = computeCriticalDesignFactsHash(changedFacts)

    expect(changedHash).not.toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: changedHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('4. Durable State / State Transition変更（category="durable_state"）→ 同上', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const changedFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|archived' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
    ]
    const changedHash = computeCriticalDesignFactsHash(changedFacts)

    expect(changedHash).not.toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: changedHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('5. Gate / Safety / Recovery変更（category="gate_safety"）→ 同上', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const changedFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'not-required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
    ]
    const changedHash = computeCriticalDesignFactsHash(changedFacts)

    expect(changedHash).not.toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: changedHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('6. 重要API / External Contract変更（category="external_contract"）→ 同上', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const changedFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v4' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
    ]
    const changedHash = computeCriticalDesignFactsHash(changedFacts)

    expect(changedHash).not.toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: changedHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('7. 主要Invariant / 採用方式変更（category="invariant"）→ 同上', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const changedFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'not-enforced' },
    ]
    const changedHash = computeCriticalDesignFactsHash(changedFacts)

    expect(changedHash).not.toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: changedHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('8. facts変更後に古いPASSしか無い → gateを通過できない（ok:false）', () => {
    const originalFacts = createBaseFacts()
    const originalHash = computeCriticalDesignFactsHash(originalFacts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: originalHash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const newFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
      { category: 'authority' as const, key: 'new_permission', value: 'added' },
    ]
    const newHash = computeCriticalDesignFactsHash(newFacts)

    expect(newHash).not.toBe(originalHash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: newHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('9. PLが「rechallenge不要」と判断してもskipできない: gate関数はcurrentCriticalFactsHashを受け取ったら必ず比較し、skip/bypassを表す引数・オプションが存在しない', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })
    storage.designReviewEvidence.create(evidence)

    const differentFacts: CriticalDesignFact[] = [
      { category: 'authority', key: 'admin', value: 'not-required' },
    ]
    const differentHash = computeCriticalDesignFactsHash(differentFacts)

    const inputWithSkipAttempt = {
      taskId,
      aiCliMode: 'implement' as const,
      aiCliPrompt: designPrompt,
      currentCriticalFactsHash: differentHash,
      skipCriticalFactsCheck: true,
      bypassCriticalFacts: true,
      forcePass: true,
    }

    const result = checkImplementJobDesignReviewEvidence(
      inputWithSkipAttempt as any,
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('10. deterministic trigger外でも追加Challengeは可能: factsが同一のまま新しいevidenceを追加作成でき、最新evidenceでgateが通ること', () => {
    const facts = createBaseFacts()
    const hash = computeCriticalDesignFactsHash(facts)
    const designPrompt = 'design prompt'

    const evidence1 = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
      createdAt: new Date(Date.now() - 10000).toISOString(),
    })
    storage.designReviewEvidence.create(evidence1)

    const evidence2 = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: hash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
      createdAt: new Date().toISOString(),
    })
    const created2 = storage.designReviewEvidence.create(evidence2)

    const latest = storage.designReviewEvidence.findLatestByTaskId(taskId)
    expect(latest?.id).toBe(created2.id)
    expect(latest?.criticalFactsHash).toBe(hash)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: hash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.evidence?.id).toBe(created2.id)
    }
  })

  it('11. 最新factsに対応したRechallenge PASS後 → gate再開可能（新evidence作成後 ok:true）', () => {
    const originalFacts = createBaseFacts()
    const originalHash = computeCriticalDesignFactsHash(originalFacts)
    const designPrompt = 'design prompt'

    const oldEvidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: originalHash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
      createdAt: new Date(Date.now() - 10000).toISOString(),
    })
    storage.designReviewEvidence.create(oldEvidence)

    const newFacts: CriticalDesignFact[] = [
      { category: 'authority' as const, key: 'admin', value: 'required' },
      { category: 'durable_state' as const, key: 'project_status', value: 'running|paused|completed' },
      { category: 'gate_safety' as const, key: 'deployment_approval', value: 'required' },
      { category: 'external_contract' as const, key: 'github_api', value: 'v3' },
      { category: 'invariant' as const, key: 'task_idempotency', value: 'enforced' },
      { category: 'authority' as const, key: 'new_permission', value: 'added' },
    ]
    const newHash = computeCriticalDesignFactsHash(newFacts)

    const newEvidence = createEvidence({
      id: 'evidence-new',
      taskId,
      designTextHash: computeDesignTextHash(designPrompt),
      criticalFactsHash: newHash,
      reviewLoad: 'critical',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
      createdAt: new Date().toISOString(),
    })
    storage.designReviewEvidence.create(newEvidence)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: designPrompt,
        currentCriticalFactsHash: newHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.evidence?.criticalFactsHash).toBe(newHash)
    }
  })

  it('12. Meta: facts不一致 かつ 最新challenge無し → checkLatestChallengeCoversCurrentFacts が ok:false CRITICAL_FACTS_STALE', () => {
    const result = checkLatestChallengeCoversCurrentFacts({
      currentCriticalFactsHash: 'abc123',
      latestEvidenceCriticalFactsHash: undefined,
    })

    expect(result).toEqual({
      ok: false,
      code: 'CRITICAL_FACTS_STALE',
      reason: 'No design challenge evidence found for current critical facts',
    })
  })

  it('13. Meta: 最新factsとchallenge evidence一致 → ok:true（不要なBLOCKERを出さない）', () => {
    const result = checkLatestChallengeCoversCurrentFacts({
      currentCriticalFactsHash: 'abc123',
      latestEvidenceCriticalFactsHash: 'abc123',
    })

    expect(result).toEqual({ ok: true })
  })
})