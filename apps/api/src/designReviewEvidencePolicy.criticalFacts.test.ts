import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createSQLiteStorage } from './storage/sqlite'
import {
  checkImplementJobDesignReviewEvidence,
  computeDesignTextHash,
  computeCriticalDesignFactsHash,
} from './designReviewEvidencePolicy'
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

describe('criticalDesignFacts canonicalization', () => {
  it('sorts by category then key', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'invariant', key: 'z', value: '1' },
      { category: 'authority', key: 'a', value: '2' },
      { category: 'authority', key: 'b', value: '3' },
      { category: 'durable_state', key: 'a', value: '4' },
    ]
    const result = canonicalizeCriticalDesignFacts(facts)
    const lines = result.split('\x1e')
    expect(lines[0]).toBe('authority\x1fa\x1f2')
    expect(lines[1]).toBe('authority\x1fb\x1f3')
    expect(lines[2]).toBe('durable_state\x1fa\x1f4')
    expect(lines[3]).toBe('invariant\x1fz\x1f1')
  })

  it('deduplicates exact duplicates', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
      { category: 'authority', key: 'a', value: '1' },
      { category: 'authority', key: 'b', value: '2' },
    ]
    const result = canonicalizeCriticalDesignFacts(facts)
    const lines = result.split('\x1e')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('authority\x1fa\x1f1')
    expect(lines[1]).toBe('authority\x1fb\x1f2')
  })

  it('throws when value contains field separator', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: 'val\x1fue' },
    ]
    expect(() => canonicalizeCriticalDesignFacts(facts)).toThrow(
      'CriticalDesignFact contains forbidden control character',
    )
  })

  it('throws when value contains record separator', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: 'val\x1eue' },
    ]
    expect(() => canonicalizeCriticalDesignFacts(facts)).toThrow(
      'CriticalDesignFact contains forbidden control character',
    )
  })

  it('throws when category contains field separator', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'auth\x1fority', key: 'a', value: '1' },
    ]
    expect(() => canonicalizeCriticalDesignFacts(facts)).toThrow(
      'CriticalDesignFact contains forbidden control character',
    )
  })

  it('throws when key contains field separator', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'a\x1fb', value: '1' },
    ]
    expect(() => canonicalizeCriticalDesignFacts(facts)).toThrow(
      'CriticalDesignFact contains forbidden control character',
    )
  })

  it('throws when same category+key has different values', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
      { category: 'authority', key: 'a', value: '2' },
    ]
    expect(() => canonicalizeCriticalDesignFacts(facts)).toThrow(
      'Duplicate CriticalDesignFact with same category+key but different value',
    )
  })

  it('input order does not affect output after delimiter change', () => {
    const facts1: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
      { category: 'invariant', key: 'x', value: '2' },
    ]
    const facts2: CriticalDesignFact[] = [
      { category: 'invariant', key: 'x', value: '2' },
      { category: 'authority', key: 'a', value: '1' },
    ]
    const result1 = canonicalizeCriticalDesignFacts(facts1)
    const result2 = canonicalizeCriticalDesignFacts(facts2)
    expect(result1).toBe(result2)
  })
})

describe('computeCriticalDesignFactsHash', () => {
  it('produces same hash for same facts regardless of input order', () => {
    const facts1: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
      { category: 'invariant', key: 'x', value: '2' },
    ]
    const facts2: CriticalDesignFact[] = [
      { category: 'invariant', key: 'x', value: '2' },
      { category: 'authority', key: 'a', value: '1' },
    ]
    expect(computeCriticalDesignFactsHash(facts1)).toBe(computeCriticalDesignFactsHash(facts2))
  })

  it('produces different hash when value differs', () => {
    const facts1: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
    ]
    const facts2: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '2' },
    ]
    expect(computeCriticalDesignFactsHash(facts1)).not.toBe(computeCriticalDesignFactsHash(facts2))
  })

  it('produces different hash when key differs', () => {
    const facts1: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
    ]
    const facts2: CriticalDesignFact[] = [
      { category: 'authority', key: 'b', value: '1' },
    ]
    expect(computeCriticalDesignFactsHash(facts1)).not.toBe(computeCriticalDesignFactsHash(facts2))
  })

  it('produces different hash when category differs', () => {
    const facts1: CriticalDesignFact[] = [
      { category: 'authority', key: 'a', value: '1' },
    ]
    const facts2: CriticalDesignFact[] = [
      { category: 'invariant', key: 'a', value: '1' },
    ]
    expect(computeCriticalDesignFactsHash(facts1)).not.toBe(computeCriticalDesignFactsHash(facts2))
  })
})

describe('checkImplementJobDesignReviewEvidence critical facts', () => {
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

  it('passes when currentCriticalFactsHash is not provided (backward compatible)', () => {
    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash('design prompt'),
    })
    storage.designReviewEvidence.create(evidence)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: 'design prompt',
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(true)
  })

  it('passes when evidence has criticalFactsHash matching current', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'admin', value: 'required' },
    ]
    const hash = computeCriticalDesignFactsHash(facts)
    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash('design prompt'),
      criticalFactsHash: hash,
    })
    storage.designReviewEvidence.create(evidence)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: 'design prompt',
        currentCriticalFactsHash: hash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(true)
  })

  it('fails with CRITICAL_FACTS_CHANGED when hash mismatches', () => {
    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'admin', value: 'required' },
    ]
    const hash = computeCriticalDesignFactsHash(facts)
    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash('design prompt'),
      criticalFactsHash: hash,
    })
    storage.designReviewEvidence.create(evidence)

    const differentFacts: CriticalDesignFact[] = [
      { category: 'authority', key: 'admin', value: 'not-required' },
    ]
    const differentHash = computeCriticalDesignFactsHash(differentFacts)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: 'design prompt',
        currentCriticalFactsHash: differentHash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_CHANGED')
    }
  })

  it('fails with CRITICAL_FACTS_NOT_REVIEWED when evidence has no hash but current is provided', () => {
    const evidence = createEvidence({
      taskId,
      designTextHash: computeDesignTextHash('design prompt'),
      criticalFactsHash: undefined,
    })
    storage.designReviewEvidence.create(evidence)

    const facts: CriticalDesignFact[] = [
      { category: 'authority', key: 'admin', value: 'required' },
    ]
    const hash = computeCriticalDesignFactsHash(facts)

    const result = checkImplementJobDesignReviewEvidence(
      {
        taskId,
        aiCliMode: 'implement',
        aiCliPrompt: 'design prompt',
        currentCriticalFactsHash: hash,
      },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('CRITICAL_FACTS_NOT_REVIEWED')
    }
  })
})