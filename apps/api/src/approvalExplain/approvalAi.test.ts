import type { ApprovalRequest, QAResult, ReviewResult, Task } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'
import {
  answerApprovalQuestion,
  formatApprovalAiContext,
  generateApprovalExplanation,
  type ApprovalAiContext,
} from './approvalAi'

function createContext(exactDiff?: string): ApprovalAiContext {
  const task: Task = {
    id: 'task-approval-explain',
    projectId: 'project-1',
    title: 'Approval説明を追加する',
    description: 'CEOが変更内容を理解できるようにする',
    status: 'review',
    assignee: 'developer_ai',
    dependencies: [],
    acceptanceCriteria: ['説明が表示される'],
    roadmapActive: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  }
  const approvalRequest: ApprovalRequest = {
    id: 'approval-20260810-001',
    taskId: task.id,
    targetBranch: 'ai/task-approval-explain',
    targetCommit: 'a'.repeat(40),
    targetDiffHash: 'b'.repeat(64),
    riskLevel: 'HIGH',
    requestedAction: 'git_commit',
    changedFiles: ['apps/api/src/example.ts'],
    triggeredRules: ['auth / permission guard'],
    status: 'WAITING_FOR_USER',
    expiresAt: '2026-08-10T01:00:00.000Z',
    invalidIf: ['commit changes', 'diff changes'],
    createdAt: '2026-08-10T00:00:00.000Z',
  }
  const reviewResults: ReviewResult[] = [{
    id: 'review-1',
    taskId: task.id,
    jobId: 'job-review-1',
    reviewer: 'reviewer_ai',
    status: 'approved',
    summary: '問題なし',
    findings: [],
    createdAt: '2026-08-10T00:00:00.000Z',
  }]
  const qaResults: QAResult[] = [{
    id: 'qa-1',
    taskId: task.id,
    jobId: 'job-qa-1',
    type: 'unit_test',
    status: 'passed',
    summary: 'テスト成功',
    details: '3 tests passed',
    createdAt: '2026-08-10T00:00:00.000Z',
  }]

  return { task, approvalRequest, reviewResults, qaResults, exactDiff }
}

const validExplanationJson = JSON.stringify({
  whatWasDone: 'Approval画面に説明を追加します。',
  whyNeeded: 'CEOが内容を理解して判断するためです。',
  scope: 'APIの1ファイルです。',
  notChanged: 'Approval Gateの判定は変えません。',
  productionImpact: '承認前のため、まだ本番への影響はありません。',
  riskSummary: '権限に関係する高リスク変更です。',
  failureImpact: '説明を取得できなくても既存の承認操作は利用できます。',
  verificationSummary: '単体テストは成功しています。',
  reviewSummary: 'レビューで問題は見つかっていません。',
  nextMinimalAction: '対象ファイルとテスト結果を確認してください。',
})

describe('generateApprovalExplanation', () => {
  it('builds a factual view model from a mock OpenCode Go response', async () => {
    const result = await generateApprovalExplanation(createContext('+exact'), {
      mockResponse: `\`\`\`json\n${validExplanationJson}\n\`\`\``,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.explanation.targetFiles).toEqual(['apps/api/src/example.ts'])
    expect(result.explanation.verificationResults).toEqual([
      { kind: 'unit_test', status: 'passed', detail: 'テスト成功\n3 tests passed' },
    ])
    expect(result.explanation.reviewFindings).toEqual([])
  })

  it('returns a failure result instead of throwing on parse failure', async () => {
    await expect(
      generateApprovalExplanation(createContext(), { mockResponse: 'not json' }),
    ).resolves.toMatchObject({ ok: false })
  })

  it('only includes exact diff in context when supplied by the verified reader', () => {
    expect(formatApprovalAiContext(createContext('+exact'))).toContain('"exactDiff": "+exact"')
    expect(formatApprovalAiContext(createContext())).toContain('"exactDiff": null')
  })
})

describe('answerApprovalQuestion', () => {
  const answerJson = (over: Record<string, string> = {}): string => JSON.stringify({
    issue: 'CONTROL REPOSITORY 注記のあるファイルを変更してよいかが論点です。',
    policyView: 'triggeredRules は git_commit のCEO承認要求のみで、Safety Boundary変更は含まれません。',
    fileVerdict: '渡された事実の範囲では、変更対象は allowedPaths 内の2ファイルです。',
    recommendation: 'approve',
    recommendationReason: 'review は承認、test は全てパスしています。',
    missingInformation: 'なし',
    ...over,
  })

  it('CEOが判断できる項目を平文で返す（生テキストをそのまま返さない）', async () => {
    const result = await answerApprovalQuestion(
      createContext('+exact'),
      'この変更を承認してよいですか？',
      [{ role: 'user', content: '本番影響はありますか？' }],
      { mockResponse: answerJson() },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer).toContain('【何が問題か】')
    expect(result.answer).toContain('【Safety Policy上の扱い】')
    expect(result.answer).toContain('【今回の変更について】')
    expect(result.answer).toContain('【推奨】承認してよい')
    expect(result.answer).toContain('【足りない情報】')
  })

  it('hold のときは既存の PL / CLI へ回す案内を添える（新しいチャット口を案内しない）', async () => {
    const result = await answerApprovalQuestion(
      createContext('+exact'),
      'CONTROL REPOSITORY と allowedPaths の矛盾について教えて',
      [],
      {
        mockResponse: answerJson({
          recommendation: 'hold',
          missingInformation: 'ALWAYS_FORBIDDEN_PATTERNS に当該ファイルが含まれるかの確認',
        }),
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answer).toContain('【推奨】保留')
    expect(result.answer).toContain('PL（CLIセッション）')
  })

  it('tool call / 内部プロンプトが返ってきたら、表示せず失敗として扱う（2026-09-15 production 実測）', async () => {
    // 実際に CEO の画面へ出てしまった形。整形して見せるのではなく、出さない。
    const leaked = '<tool_call>\n<function>\n<parameter>Search for any files related to "Safety Boundary"</parameter>\n</function>\n</tool_call>'

    const raw = await answerApprovalQuestion(
      createContext('+exact'),
      'この変更を承認してよいですか？',
      [],
      { mockResponse: leaked },
    )
    expect(raw.ok).toBe(false)

    // 形は合っているが本文に内部表現が紛れ込んだ場合も落とす
    const smuggled = await answerApprovalQuestion(
      createContext('+exact'),
      'この変更を承認してよいですか？',
      [],
      { mockResponse: answerJson({ issue: '調査します <tool_call><function>search</function></tool_call>' }) },
    )
    expect(smuggled.ok).toBe(false)
  })

  it('returns a failure result when no API key is configured', async () => {
    const previous = process.env.OPENCODE_GO_API_KEY
    delete process.env.OPENCODE_GO_API_KEY
    try {
      await expect(answerApprovalQuestion(createContext(), '質問', [])).resolves.toMatchObject({ ok: false })
    } finally {
      if (previous !== undefined) process.env.OPENCODE_GO_API_KEY = previous
    }
  })
})
