import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  injectMetaFindingCategoryUnion,
  META_FINDING_CATEGORIES,
  parseMetaReviewResult,
} from './runner.js'

const repoRoot = resolve(__dirname, '../../../..')

describe('buildMetaReviewPrompt template', () => {
  it('renders finding categories from META_FINDING_CATEGORIES', () => {
    const template = readFileSync(join(repoRoot, 'docs/meta_reviewer/prompt.md'), 'utf-8')
    const rendered = injectMetaFindingCategoryUnion(template)
    const expectedCategoryUnion = META_FINDING_CATEGORIES
      .map((category) => `"${category}"`)
      .join(' | ')

    expect(template).toContain('{{META_FINDING_CATEGORY_UNION}}')
    expect(template).not.toContain(expectedCategoryUnion)
    expect(rendered).toContain(`"category": ${expectedCategoryUnion},`)
    expect(rendered).not.toContain('{{META_FINDING_CATEGORY_UNION}}')
    for (const category of META_FINDING_CATEGORIES) {
      expect(rendered).toContain(`"${category}"`)
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
