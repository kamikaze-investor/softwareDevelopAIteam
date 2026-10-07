import { describe, expect, it } from 'vitest'
import { classifyPromptRefusal } from './reviewRefusalEligibility.js'

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
