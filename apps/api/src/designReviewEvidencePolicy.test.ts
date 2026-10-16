import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteStorage } from './storage/sqlite'
import type { IStorage } from './storage/interface'
import {
  checkRoadmapDesignReviewFreshness,
  computeDesignTextHash,
  findSupersedingRun,
  type StoredRunJudgment,
} from './designReviewEvidencePolicy'

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

const REVIEW_MATERIAL = '# Roadmap Design Review Material\n\n- Task A\n- Task B'

describe('checkRoadmapDesignReviewFreshness', () => {
  it('ok: true with fresh ALIGNED evidence that has an approved independent review verdict', () => {
    const storage = createStorage()
    const projectId = 'project-1'
    storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: projectId,
      designTextHash: computeDesignTextHash(REVIEW_MATERIAL),
      reviewLoad: 'critical',
      decision: 'ALIGNED',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })

    const result = checkRoadmapDesignReviewFreshness(projectId, REVIEW_MATERIAL, storage.designReviewEvidence)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.evidence.reviewKind).toBe('roadmap')
      expect(result.evidence.subjectId).toBe(projectId)
    }
  })

  it('MISSING_ROADMAP_DESIGN_REVIEW_EVIDENCE when no evidence exists for the project', () => {
    const storage = createStorage()
    const result = checkRoadmapDesignReviewFreshness('project-nope', REVIEW_MATERIAL, storage.designReviewEvidence)

    expect(result).toMatchObject({
      ok: false,
      code: 'MISSING_ROADMAP_DESIGN_REVIEW_EVIDENCE',
    })
  })

  it('ROADMAP_DESIGN_REVIEW_HASH_MISMATCH when the reviewed material changed but the hash does not match', () => {
    const storage = createStorage()
    const projectId = 'project-hash'
    storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: projectId,
      designTextHash: computeDesignTextHash('# Roadmap Design Review Material\n\n- Task A (old)'),
      reviewLoad: 'critical',
      decision: 'ALIGNED',
      independentReviewRequired: true,
      independentReviewVerdict: 'approved',
    })

    const result = checkRoadmapDesignReviewFreshness(projectId, REVIEW_MATERIAL, storage.designReviewEvidence)

    expect(result).toMatchObject({
      ok: false,
      code: 'ROADMAP_DESIGN_REVIEW_HASH_MISMATCH',
    })
  })

  it('ROADMAP_DESIGN_REVIEW_NOT_ALIGNED when the latest roadmap evidence decision is not ALIGNED', () => {
    const storage = createStorage()
    const projectId = 'project-conflict'
    storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: projectId,
      designTextHash: computeDesignTextHash(REVIEW_MATERIAL),
      reviewLoad: 'critical',
      decision: 'CONFLICT',
      independentReviewRequired: true,
    })

    const result = checkRoadmapDesignReviewFreshness(projectId, REVIEW_MATERIAL, storage.designReviewEvidence)

    expect(result).toMatchObject({
      ok: false,
      code: 'ROADMAP_DESIGN_REVIEW_NOT_ALIGNED',
    })
  })
  // PR C: Roadmap の第二意見は Claude の integration review が担うようになり、
  // Codex independent review は task kind 専用になった。Worker は roadmap 向けの
  // independent verdict を生成しないので、evidence 側でそれを要求すると恒久的に落ちる。
  // 代わりに要求するのは generator と final reviewer が別vendorであること。
  it('roadmap evidence は independent verdict 無しでも ALIGNED なら成立する', () => {
    const storage = createStorage()
    const projectId = 'project-no-independent'
    storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: projectId,
      designTextHash: computeDesignTextHash(REVIEW_MATERIAL),
      reviewLoad: 'critical',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    })

    const result = checkRoadmapDesignReviewFreshness(projectId, REVIEW_MATERIAL, storage.designReviewEvidence)

    expect(result.ok).toBe(true)
  })

  // Gemini / Claude のいずれかが CONFLICT・UNCERTAIN なら安全側集約で ALIGNED にならず、
  // ここで evidence も成立しない。
  it('roadmap evidence は ALIGNED でなければ成立しない', () => {
    const storage = createStorage()
    const projectId = 'project-not-aligned'
    storage.designReviewEvidence.create({
      reviewKind: 'roadmap',
      subjectId: projectId,
      designTextHash: computeDesignTextHash(REVIEW_MATERIAL),
      reviewLoad: 'critical',
      decision: 'CONFLICT',
      independentReviewRequired: false,
    })

    const result = checkRoadmapDesignReviewFreshness(projectId, REVIEW_MATERIAL, storage.designReviewEvidence)

    expect(result).toMatchObject({ ok: false, code: 'ROADMAP_DESIGN_REVIEW_NOT_ALIGNED' })
  })

  it('ignores task-kind evidence when checking roadmap freshness for a project', () => {
    const storage = createStorage()
    const project = storage.projects.create({
      name: 'Roadmap project',
      goal: 'g',
      designPhilosophy: [],
      status: 'draft',
    })
    const task = storage.tasks.create({
      projectId: project.id,
      title: 'Task',
      description: '',
      status: 'pending',
      assignee: 'developer_ai',
      dependencies: [],
    })
    storage.designReviewEvidence.create({
      reviewKind: 'task',
      taskId: task.id,
      designTextHash: computeDesignTextHash('Design: task-level evidence.'),
      reviewLoad: 'medium',
      decision: 'ALIGNED',
      independentReviewRequired: false,
    })

    // task-kind evidence resolves to subjectId=taskId, so it must not satisfy roadmap freshness.
    const roadmapResult = checkRoadmapDesignReviewFreshness(project.id, REVIEW_MATERIAL, storage.designReviewEvidence)
    expect(roadmapResult).toMatchObject({
      ok: false,
      code: 'MISSING_ROADMAP_DESIGN_REVIEW_EVIDENCE',
    })

    // and the task-kind row itself is still retrievable via findLatestBySubjectId('task', taskId).
    expect(storage.designReviewEvidence.findLatestBySubjectId('task', task.id)?.id).toBeDefined()
  })
})
/**
 * **同じ subject・同じ design hash では最新の判定が正**（独立レビュー round 8・2026-10-16）。
 */
describe('findSupersedingRun — evidence の失効規則', () => {
  const evidence = { designTextHash: 'h1', createdAt: '2026-10-16T10:00:00.000Z' }
  type Run = { id: string; status: string; designTextHash: string; createdAt: string; judgment: StoredRunJudgment }
  const run = (over: Partial<Run>): Run => ({
    id: 'r', status: 'succeeded', designTextHash: 'h1', createdAt: '2026-10-16T10:05:00.000Z', judgment: 'negative', ...over,
  })
  const find = (runs: Run[]) => findSupersedingRun(evidence, runs, (r) => r.judgment)

  it('新しい同じ hash の CONFLICT / UNCERTAIN（negative）は evidence を覆す', () => {
    expect(find([run({ id: 'conflict' })])?.id).toBe('conflict')
  })

  it('新しい同じ hash の active run（queued / running）は evidence を覆す', () => {
    expect(find([run({ id: 'q', status: 'queued', judgment: 'none' })])?.id).toBe('q')
    expect(find([run({ id: 'r', status: 'running', judgment: 'none' })])?.id).toBe('r')
  })

  it('判定の無い終端（failed / REVIEW_UNAVAILABLE / 結果なし）と ALIGNED は覆さない', () => {
    expect(find([
      run({ status: 'failed', judgment: 'none' }),
      run({ judgment: 'none' }),
      run({ judgment: 'aligned' }),
    ])).toBeUndefined()
  })

  it('古い run・同じ ms の run・別の hash の run は覆さない', () => {
    expect(find([
      run({ createdAt: '2026-10-16T09:59:59.999Z' }),
      run({ designTextHash: 'h2' }),
    ])).toBeUndefined()
    expect(find([run({ id: 'same-ms', createdAt: evidence.createdAt })])).toBeUndefined()
  })
})

describe('checkRoadmapDesignReviewFreshness — 新しい同じ material の CONFLICT run', () => {
  afterEach(() => { vi.useRealTimers() })

  it('古い ALIGNED evidence は、より新しい同じ hash の CONFLICT run に覆される', () => {
    const storage = createStorage()
    const projectId = 'project-superseded'
    const hash = computeDesignTextHash(REVIEW_MATERIAL)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-16T09:00:00.000Z'))
    storage.designReviewEvidence.create({
      reviewKind: 'roadmap', subjectId: projectId, designTextHash: hash, reviewLoad: 'critical',
      decision: 'ALIGNED', independentReviewRequired: false,
    })
    vi.setSystemTime(new Date('2026-10-16T09:10:00.000Z'))
    const conflictRun = storage.designReviewRuns.create({
      reviewKind: 'roadmap', subjectId: projectId, taskTitle: 'Whole-Roadmap Review',
      designText: REVIEW_MATERIAL, designTextHash: hash, changedFiles: [],
    })
    const claimed = storage.designReviewRuns.claim(conflictRun.id, 3)
    storage.designReviewRuns.complete(conflictRun.id, claimed.claimToken!, 'succeeded', JSON.stringify({
      focusedReviewResults: [
        { focus: 'strategic_alignment', decision: 'CONFLICT' },
        { focus: 'scope_simplicity', decision: 'ALIGNED' },
        { focus: 'architecture_responsibility', decision: 'ALIGNED' },
      ],
      integrationReviewResult: { decision: 'CONFLICT', summary: 'phases conflict' },
    }))

    expect(checkRoadmapDesignReviewFreshness(projectId, REVIEW_MATERIAL, storage.designReviewEvidence))
      .toMatchObject({ ok: false, code: 'ROADMAP_DESIGN_REVIEW_SUPERSEDED' })
  })
})
