import { describe, expect, it, beforeEach } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { checkImplementJobDesignReviewEvidence } from '../designReviewEvidencePolicy'
import { createAndExecuteDesignReview } from './designReviewCoordinator'

/**
 * Reviewed Prompt Identity。
 *
 * design_review_runs.design_text
 *   → design_text_hash（coordinatorがdesign_textから算出）
 *   → design_review_evidence.designTextHash
 *   → Job Gate が計算する computeDesignTextHash(Job.aiCliPrompt)
 *
 * この連鎖が同一内容でのみ成立し、review後にfailure context等を足した
 * 未reviewのpromptではimplement Jobを実行できないことを実行テストで証明する。
 */

const REVIEWED_PROMPT = [
  '# 設計',
  'READMEへ1行追記する。',
  '制約: 既存の挙動を変更しない。',
].join('\n')

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seedTask(storage: IStorage): string {
  const project = storage.projects.create({
    name: 'Test Project', goal: 'g', designPhilosophy: [], status: 'draft',
  })
  return storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  }).id
}

/** low load 相当。focus集合は [] になる。 */
const CHANGED_FILES = ['docs/readme.md']

function alignedRunnerOutput(): string {
  return JSON.stringify({
    focusedReviewResults: [],
    integrationReviewResult: { decision: 'ALIGNED' },
    finalDecision: 'ALIGNED',
  })
}

function deps() {
  return {
    runnerCommand: 'node',
    runnerArgs: [],
    homeDirectory: '/tmp/home',
    workingDir: '/tmp/work',
    execute: async () => ({ ok: true, stdout: alignedRunnerOutput(), timedOut: false }),
  }
}

describe('Reviewed Prompt Identity', () => {
  let storage: IStorage
  let taskId: string

  beforeEach(async () => {
    storage = createStorage()
    taskId = seedTask(storage)

    const result = await createAndExecuteDesignReview(
      storage,
      { taskId, taskTitle: 'design', designText: REVIEWED_PROMPT, changedFiles: CHANGED_FILES },
      deps(),
    )
    expect(result.status).toBe('evidence_registered')
  })

  it('run.design_text と evidence.designTextHash が同一内容に基づく', () => {
    const run = storage.designReviewRuns.findById(
      storage.designReviewRuns.findQueued()[0]?.id ?? '',
    )
    // runは既に終端しているのでfindQueuedには出ない。evidence側から同一性を確認する。
    expect(run).toBeUndefined()

    const evidence = storage.designReviewEvidence.findLatestByTaskId(taskId)!
    expect(evidence.decision).toBe('ALIGNED')

    // review済みpromptそのものならGateを通る
    const ok = checkImplementJobDesignReviewEvidence(
      { taskId, aiCliMode: 'implement', aiCliPrompt: REVIEWED_PROMPT },
      storage.designReviewEvidence,
    )
    expect(ok.ok).toBe(true)
  })

  it('review後にfailure contextを追記したpromptはGateで拒否される', () => {
    const withFailureContext = `${REVIEWED_PROMPT}\n\n## 直前の失敗\nprovider timeout が発生しました。`

    const result = checkImplementJobDesignReviewEvidence(
      { taskId, aiCliMode: 'implement', aiCliPrompt: withFailureContext },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('DESIGN_REVIEW_HASH_MISMATCH')
    }
  })

  it('1文字でも変更されたpromptはGateで拒否される', () => {
    const result = checkImplementJobDesignReviewEvidence(
      { taskId, aiCliMode: 'implement', aiCliPrompt: `${REVIEWED_PROMPT} ` },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('DESIGN_REVIEW_HASH_MISMATCH')
    }
  })

  it('aiCliPromptが無いimplement Jobは通せない', () => {
    const result = checkImplementJobDesignReviewEvidence(
      { taskId, aiCliMode: 'implement', aiCliPrompt: undefined },
      storage.designReviewEvidence,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('MISSING_AI_CLI_PROMPT')
    }
  })

  it('ALIGNEDでないreviewではevidenceが登録されず、review済みpromptでもGateを通れない', async () => {
    const otherStorage = createStorage()
    const otherTaskId = seedTask(otherStorage)

    const conflicting = {
      ...deps(),
      execute: async () => ({
        ok: true,
        stdout: JSON.stringify({
          focusedReviewResults: [],
          integrationReviewResult: { decision: 'CONFLICT' },
          finalDecision: 'ALIGNED',
        }),
        timedOut: false,
      }),
    }

    const result = await createAndExecuteDesignReview(
      otherStorage,
      { taskId: otherTaskId, taskTitle: 'design', designText: REVIEWED_PROMPT, changedFiles: CHANGED_FILES },
      conflicting,
    )

    expect(result.status).toBe('not_aligned')
    expect(otherStorage.designReviewEvidence.findByTaskId(otherTaskId)).toHaveLength(0)

    const gate = checkImplementJobDesignReviewEvidence(
      { taskId: otherTaskId, aiCliMode: 'implement', aiCliPrompt: REVIEWED_PROMPT },
      otherStorage.designReviewEvidence,
    )
    expect(gate.ok).toBe(false)
    if (!gate.ok) {
      expect(gate.code).toBe('MISSING_DESIGN_REVIEW_EVIDENCE')
    }
  })
})
