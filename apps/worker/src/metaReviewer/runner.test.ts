import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMetaReviewPrompt, buildMetaReviewRequest, parseMetaReviewResult } from './runner.js'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SEMANTIC_CHECKLIST_TITLE = '# チェックリスト: Semantic Integrity（canonical-domain-meaning）'

function promptFor(changedFiles: string[]): string {
  return buildMetaReviewPrompt(buildMetaReviewRequest('t', 'title', changedFiles, REPO_ROOT, 'diff'), REPO_ROOT)
}

describe('buildMetaReviewPrompt principle checklists', () => {
  it('adds the Semantic Integrity checklist when the changed files select canonical-domain-meaning', () => {
    // storage → data_state_integrity / routes → architecture_responsibility + auth_permission
    for (const file of ['apps/api/src/storage/sqlite.ts', 'apps/api/src/routes/jobs.ts', 'apps/worker/src/jobRunner.ts']) {
      expect(promptFor([file])).toContain(SEMANTIC_CHECKLIST_TITLE)
    }
  })

  it('adds it once even when several changed files select the same principle', () => {
    const prompt = promptFor(['apps/api/src/storage/sqlite.ts', 'apps/api/src/routes/jobs.ts'])
    expect(prompt.split(SEMANTIC_CHECKLIST_TITLE)).toHaveLength(2)
  })

  it('does not add it when no changed file selects the principle', () => {
    for (const file of ['apps/mobile/app/index.tsx', 'docs/project_memory/decisions/x.md', '.github/workflows/ci.yml']) {
      expect(promptFor([file])).not.toContain(SEMANTIC_CHECKLIST_TITLE)
    }
  })
})

describe('parseMetaReviewResult', () => {
  it('parses fenced JSON responses with uppercase language tags', () => {
    const result = parseMetaReviewResult(
      [
        'Result:',
        '```JSON',
        '{',
        '  "status": "approved",',
        '  "riskLevel": "low",',
        '  "summary": "Looks good",',
        '  "findings": [],',
        '  "requiresCeoApproval": false',
        '}',
        '```',
      ].join('\r\n'),
      'task-test',
    )

    expect(result.status).toBe('approved')
    expect(result.riskLevel).toBe('low')
    expect(result.findings).toEqual([])
    expect(result.requiresCeoApproval).toBe(false)
  })

  it('parses JSON objects surrounded by prose and invalid brace snippets', () => {
    const result = parseMetaReviewResult(
      [
        'I checked {this is not json} first.',
        '{',
        '  "status": "changes_requested",',
        '  "riskLevel": "medium",',
        '  "summary": "One issue",',
        '  "findings": [',
        '    {',
        '      "severity": "medium",',
        '      "category": "scope_creep",',
        '      "message": "Keep the change scoped"',
        '    }',
        '  ],',
        '  "requiresCeoApproval": false',
        '}',
      ].join('\n'),
      'task-test',
    )

    expect(result.status).toBe('changes_requested')
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].category).toBe('scope_creep')
  })

  it('accepts engineering principle finding categories', () => {
    const result = parseMetaReviewResult(
      JSON.stringify({
        status: 'changes_requested',
        riskLevel: 'medium',
        summary: 'Principle issue',
        findings: [
          {
            severity: 'medium',
            category: 'implementation_coupling',
            message: 'Finding depends on process topology rather than observable behavior.',
          },
        ],
        requiresCeoApproval: false,
      }),
      'task-test',
    )

    expect(result.findings[0].category).toBe('implementation_coupling')
  })

  it('returns blocked when no valid Meta Review JSON exists', () => {
    const result = parseMetaReviewResult('not json', 'task-test')

    expect(result.status).toBe('blocked')
    expect(result.riskLevel).toBe('critical')
    expect(result.requiresCeoApproval).toBe(true)
  })
})
