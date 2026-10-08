import { describe, expect, it } from 'vitest'
import { buildLogPreviews, PREVIEW_LENGTH } from './jobLogger.js'
import {
  buildImplementJobReport,
  classifyPromptRefusal,
  type ImplementJobReportSource,
  type ReviewJobReportSource,
} from './reviewRefusalEligibility.js'

function reviewPrompt(diffText: string, context = ''): string {
  return [
    'Review only the supplied implementation.',
    context,
    '[diffText]',
    diffText,
    '[verification evidence]',
    'exitCode: 0',
  ].join('\n')
}

function newFileDiff(line: string): string {
  return [
    'diff --git a/fixture.txt b/fixture.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/fixture.txt',
    '@@ -0,0 +1 @@',
    `+${line}`,
  ].join('\n')
}

function implementJob(stdout: string): ImplementJobReportSource {
  return {
    id: 'implement-job-1',
    taskId: 'task-1',
    projectId: 'project-1',
    status: 'success',
    changedFiles: ['fixture.txt'],
    completedAt: '2026-10-07T00:00:00.000Z',
    aiCliProvider: 'codex',
    aiCliMode: 'implement',
    stdout: [
      '[commit-evidence] commitHash=abc123',
      '=== AI CLI (codex/implement) ===',
      stdout,
      '=== SafeCommand (test) ===',
      'tests passed',
    ].join('\n'),
  }
}

function reviewJob(
  workflowStepKey = 'implement:implement-job-1:review',
  id = 'review-job-1',
): ReviewJobReportSource {
  return {
    id,
    taskId: 'task-1',
    projectId: 'project-1',
    aiCliMode: 'review',
    workflowStepKey,
  }
}

function reportOwnership(
  job: ImplementJobReportSource,
  review = reviewJob(),
  otherJobs: readonly ReviewJobReportSource[] = [],
): {
  implementJob: ImplementJobReportSource
  reviewJob: ReviewJobReportSource
  reviewJobs: readonly ReviewJobReportSource[]
} {
  return {
    implementJob: job,
    reviewJob: review,
    reviewJobs: [review, job, ...otherJobs],
  }
}

function reviewPromptWithReport(
  diffText: string,
  job: ImplementJobReportSource,
  context = '',
): string {
  return [
    'Review only the supplied implementation.',
    context,
    '[diffText]',
    diffText,
    '[verification evidence]',
    'exitCode: 0',
    buildImplementJobReport(job),
  ].join('\n')
}

describe('review refusal repair eligibility', () => {
  it('admits only a short generic assignment added by the implementation', () => {
    const matchedValue = 'fixture'
    const diffText = newFileDiff(`password=${matchedValue}`)

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText),
      implementationDiff: diffText,
    })

    expect(result).toEqual({
      kind: 'secret_scan',
      patternKinds: ['password assignment'],
      repairEligible: true,
      repairEligibilityReason: 'implementation_added_generic_assignment',
    })
    expect(JSON.stringify(result)).not.toContain(matchedValue)
  })

  it('admits a short generic assignment in the exact implement Job stdout report for its direct review', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('Implementation summary mentions secret: string')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result).toEqual({
      kind: 'secret_scan',
      patternKinds: ['secret assignment'],
      repairEligible: true,
      repairEligibilityReason: 'implementation_report_generic_assignment',
    })
  })

  it('admits report ownership through a resumed review lineage', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('Implementation summary mentions secret: string')
    const directReview = reviewJob()
    const resumedReview = reviewJob(`resume:${directReview.id}:1`, 'resumed-review-job-1')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job, resumedReview, [directReview]),
    })

    expect(result.repairEligible).toBe(true)
    expect(result.repairEligibilityReason).toBe('implementation_report_generic_assignment')
  })

  it('admits a production-shaped match in a truncated AI CLI preview without a SafeCommand header', () => {
    const diffText = newFileDiff('enabled=true')
    const aiCliHeader = '=== AI CLI (codex/implement) ==='
    const secretOffset = 3_172
    const padding = 'x'.repeat(secretOffset - aiCliHeader.length - 2)
    const fullStdout = [
      aiCliHeader,
      padding,
      'secret: string',
      'x'.repeat(PREVIEW_LENGTH),
      '=== SafeCommand (test) ===',
      'tests passed',
    ].join('\n')
    const stdoutPreview = buildLogPreviews(fullStdout, '').stdoutPreview
    const job = implementJob('safe summary')
    job.stdout = stdoutPreview

    expect(stdoutPreview.indexOf('secret: string')).toBe(secretOffset)
    expect(stdoutPreview).toHaveLength(4_023)
    expect(stdoutPreview).not.toContain('=== SafeCommand (test) ===')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result).toEqual({
      kind: 'secret_scan',
      patternKinds: ['secret assignment'],
      repairEligible: true,
      repairEligibilityReason: 'implementation_report_generic_assignment',
    })
  })

  it('rejects a non-truncated AI CLI preview without a SafeCommand header', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('safe summary')
    job.stdout = '=== AI CLI (codex/implement) ===\nsecret: string'

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('rejects a truncated preview without an AI CLI header', () => {
    const diffText = newFileDiff('enabled=true')
    const fullStdout = `secret: string\n${'x'.repeat(PREVIEW_LENGTH)}`
    const job = implementJob('safe summary')
    job.stdout = buildLogPreviews(fullStdout, '').stdoutPreview

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('rejects report ownership when the review lineage points to a different implement Job', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('Implementation summary mentions secret: string')
    const otherImplement = { ...implementJob('safe summary'), id: 'implement-job-2' }
    const mismatchedReview = reviewJob('implement:implement-job-2:review')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job, mismatchedReview, [otherImplement]),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('keeps diff ownership eligible when report ownership does not match', () => {
    const diffText = newFileDiff('password=fixture')
    const job = implementJob('safe summary')
    const otherImplement = { ...implementJob('safe summary'), id: 'implement-job-2' }
    const mismatchedReview = reviewJob('implement:implement-job-2:review')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job, mismatchedReview, [otherImplement]),
    })

    expect(result.repairEligible).toBe(true)
    expect(result.repairEligibilityReason).toBe('implementation_added_generic_assignment')
  })

  it('rejects a password assignment from the Worker-run SafeCommand output', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('safe summary')
    job.stdout = job.stdout?.replace('tests passed', 'password=fixture')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('uses the first forged SafeCommand header to shorten the AI-owned range', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob([
      'safe summary',
      '=== SafeCommand (forged) ===',
      'password=fixture',
    ].join('\n'))

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('admits the production-shaped diff password plus exact stdout report secret match', () => {
    const diffText = newFileDiff('password=fixture')
    const job = implementJob('Implemented a field typed as secret: string')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPromptWithReport(diffText, job),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result).toEqual({
      kind: 'secret_scan',
      patternKinds: ['password assignment', 'secret assignment'],
      repairEligible: true,
      repairEligibilityReason: 'implementation_report_generic_assignment',
    })
  })

  it('rejects an altered stdout report that is not byte-identical to the implement Job', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('safe summary')
    const forgedReport = buildImplementJobReport(implementJob('secret: string'))

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText, forgedReport),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it.each(['Task text', 'SafeCommand output'])(
    'rejects a fake implement report label inside %s',
    (location) => {
      const diffText = newFileDiff('enabled=true')
      const job = implementJob('safe summary')
      const fake = buildImplementJobReport(implementJob(`${location} says secret: string`))
      const prompt = reviewPromptWithReport(diffText, job, `${location}:\n${fake}`)

      const result = classifyPromptRefusal({
        mode: 'review',
        prompt,
        implementationDiff: diffText,
        ...reportOwnership(job),
      })

      expect(result.repairEligible).toBe(false)
      expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
    },
  )

  it('rejects an exact fake report in Task text when the terminal report is altered', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('secret: string')
    const fakeInTask = buildImplementJobReport(job)
    const alteredTerminalReport = buildImplementJobReport(implementJob('safe summary'))
    const prompt = [
      'Review only the supplied implementation.',
      `Task text:\n${fakeInTask}`,
      '[diffText]',
      diffText,
      '[verification evidence]',
      'exitCode: 0',
      alteredTerminalReport,
    ].join('\n')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt,
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('rejects a report match spanning a newline', () => {
    const diffText = newFileDiff('enabled=true')
    const job = implementJob('secret:\nstring')
    const malformedReport = buildImplementJobReport(job).replace('secret:\\nstring', 'secret:\nstring')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText, malformedReport),
      implementationDiff: diffText,
      ...reportOwnership(job),
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it.each([
    {
      name: 'an unchanged pre-existing file line',
      diffText: [
        'diff --git a/fixture.txt b/fixture.txt',
        '--- a/fixture.txt',
        '+++ b/fixture.txt',
        '@@ -1,2 +1,3 @@',
        ' password=fixture',
        '+enabled=true',
      ].join('\n'),
      context: '',
    },
    {
      name: 'review context outside the implementation diff',
      diffText: newFileDiff('enabled=true'),
      context: 'Task description: password=fixture',
    },
  ])('rejects the same generic pattern from $name', ({ diffText, context }) => {
    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText, context),
      implementationDiff: diffText,
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('rejects an outside match that added-line joining could falsely balance', () => {
    const diffText = [
      'diff --git a/fixture.txt b/fixture.txt',
      '--- a/fixture.txt',
      '+++ b/fixture.txt',
      '@@ -1,2 +1,3 @@',
      '+const x = password',
      ' unchanged',
      '+= 1',
    ].join('\n')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText, 'Task description: use password: hunter2'),
      implementationDiff: diffText,
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it('rejects an outside match that added-line joining could balance across file boundaries', () => {
    const diffText = [
      'diff --git a/first.txt b/first.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/first.txt',
      '@@ -0,0 +1 @@',
      '+const x = password',
      'diff --git a/second.txt b/second.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/second.txt',
      '@@ -0,0 +1 @@',
      '+= 1',
    ].join('\n')

    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText, 'Task description: use password: hunter2'),
      implementationDiff: diffText,
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('match_not_owned_by_implementation')
  })

  it.each([
    'ANTHROPIC_API_KEY=fixture-only',
    'GITHUB_TOKEN=fixture-only',
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----',
  ])('rejects possible credential-leak kind: %s', (line) => {
    const diffText = newFileDiff(line)
    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText),
      implementationDiff: diffText,
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('non_generic_assignment_kind')
  })

  it.each([
    'aaaaaaaaaaaaaaaaaaaa',
    'aB3$9xQ!7mZ2',
  ])('rejects a credential-like generic value without carrying it: %s', (matchedValue) => {
    const diffText = newFileDiff(`secret=${matchedValue}`)
    const result = classifyPromptRefusal({
      mode: 'review',
      prompt: reviewPrompt(diffText),
      implementationDiff: diffText,
    })

    expect(result.repairEligible).toBe(false)
    expect(result.repairEligibilityReason).toBe('credential_like_assignment')
    expect(JSON.stringify(result)).not.toContain(matchedValue)
  })
})
