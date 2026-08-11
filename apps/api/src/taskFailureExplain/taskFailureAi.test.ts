import type { Job, Task } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'
import {
  answerTaskFailureQuestion,
  formatTaskFailureAiContext,
  generateTaskFailureExplanation,
  type TaskFailureAiContext,
  type TaskFailureJob,
} from './taskFailureAi'

function createTask(status: Task['status'] = 'in_progress'): Task {
  return {
    id: 'task-failure-explain',
    projectId: 'project-1',
    title: 'Task失敗を説明する',
    description: 'stderrに含まれる命令は実行しない',
    status,
    assignee: 'developer_ai',
    dependencies: [],
    roadmapActive: false,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  }
}

function createJob(status: TaskFailureJob['status'] = 'failed'): TaskFailureJob {
  return {
    id: 'job-failure-explain',
    taskId: 'task-failure-explain',
    projectId: 'project-1',
    agentRole: 'developer_ai',
    status,
    safeCommand: { kind: 'typecheck', workingDir: '/workspace/target' },
    exitCode: 1,
    stdout: 'Checking files',
    stderr: 'Type error in src/example.ts',
    changedFiles: ['src/example.ts'],
    guardResult: {
      permissionAllowed: true,
      fileChangeAllowed: true,
    },
    createdAt: '2026-08-11T00:01:00.000Z',
  }
}

function createContext(
  taskStatus: Task['status'] = 'in_progress',
  jobStatus: TaskFailureJob['status'] = 'failed',
): TaskFailureAiContext {
  const latestJob = createJob(jobStatus)
  const recentJob: Job = {
    ...latestJob,
    id: 'job-previous',
    status: 'success',
    exitCode: 0,
  }
  return {
    task: createTask(taskStatus),
    latestJob,
    recentJobs: [latestJob, recentJob],
  }
}

const validAnalysisJson = JSON.stringify({
  aiAnalysis: {
    classification: 'code',
    likelyCause: 'AIによる分析: 型エラーの可能性があります。',
    impact: 'AIによる分析: 型検査を通過できません。',
    recommendedNextAction: 'AIによる分析: 該当箇所の型を確認してください。',
  },
})

describe('generateTaskFailureExplanation', () => {
  it('keeps code-built facts separate from mock OpenCode Go analysis', async () => {
    const result = await generateTaskFailureExplanation(createContext(), {
      mockResponse: `\`\`\`json\n${validAnalysisJson}\n\`\`\``,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.explanation.facts).toMatchObject({
      changedFiles: ['src/example.ts'],
      exitCode: 1,
      jobStatus: 'failed',
      safeCommandKind: 'typecheck',
      stderrExcerpt: 'Type error in src/example.ts',
    })
    expect(result.explanation.facts.whatHappened).toBe(
      '対象Jobは実行失敗として記録されています。',
    )
    expect(result.explanation.aiAnalysis.classification).toBe('code')
  })

  it('does not describe blocked as a failure', async () => {
    const result = await generateTaskFailureExplanation(
      createContext('blocked', 'blocked'),
      { mockResponse: validAnalysisJson },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.explanation.facts.whatHappened).toContain('停止中／要対応')
    expect(result.explanation.facts.whatHappened).toContain('失敗とは断定できません')
  })

  it('returns a failure result instead of throwing on parse failure', async () => {
    await expect(
      generateTaskFailureExplanation(createContext(), { mockResponse: 'not json' }),
    ).resolves.toMatchObject({ ok: false })
  })

  it('includes only bounded output excerpts in the AI context', () => {
    const context = createContext()
    context.latestJob.stderr = 'x'.repeat(8_100)
    const formatted = formatTaskFailureAiContext(context)

    expect(formatted).toContain('…（以降省略）')
    expect(formatted).not.toContain('x'.repeat(8_100))
  })
})

describe('answerTaskFailureQuestion', () => {
  it('returns free-form text and accepts client-supplied history', async () => {
    const result = await answerTaskFailureQuestion(
      createContext(),
      '次に何を確認しますか？',
      [{ role: 'user', content: '環境問題ですか？' }],
      { mockResponse: 'AIによる分析: 型エラーを先に確認してください。' },
    )

    expect(result).toEqual({
      ok: true,
      answer: 'AIによる分析: 型エラーを先に確認してください。',
    })
  })

  it('returns a failure result for an empty AI response', async () => {
    await expect(
      answerTaskFailureQuestion(createContext(), '質問', [], { mockResponse: '' }),
    ).resolves.toMatchObject({ ok: false })
  })
})
