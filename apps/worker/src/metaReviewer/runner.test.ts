import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildMetaReviewPrompt,
  buildMetaReviewRequest,
  classifyFormalVerdict,
  MAX_PR_BODY_CHARS,
  parseMetaReviewResult,
  providedCanonicalPrincipleIds,
} from './runner.js'

const REPO_ROOT = path.resolve(__dirname, '../../../..')

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

  it('accepts principle_conflict only when its message names a provided principle', () => {
    const raw = (message: string) => JSON.stringify({
      status: 'changes_requested',
      riskLevel: 'high',
      summary: 'Principle conflict',
      findings: [{ severity: 'high', category: 'principle_conflict', message }],
      requiresCeoApproval: false,
    })

    const accepted = parseMetaReviewResult(raw('specs/22 §1-3 conflicts with the Goal'), 'task-test', [
      'specs/22 §1-3',
    ])
    const normalized = parseMetaReviewResult(raw('unknown-principle conflicts with the Goal'), 'task-test', [
      'specs/22 §1-3',
    ])

    expect(accepted.findings[0].category).toBe('principle_conflict')
    expect(normalized.findings[0].category).toBe('spec_violation')
  })

  it('keeps an unnamed principle_conflict negative verdict and normalizes its category', () => {
    const raw = JSON.stringify({
      status: 'blocked',
      riskLevel: 'critical',
      summary: 'Unnamed principle conflict',
      findings: [{
        severity: 'critical',
        category: 'principle_conflict',
        message: 'An unspecified principle conflicts with this change.',
      }],
      requiresCeoApproval: true,
    })

    expect(classifyFormalVerdict(raw)).toBe('negative')
    const parsed = parseMetaReviewResult(raw, 'task-test', ['specs/22 §1-3'])
    expect(parsed.status).toBe('blocked')
    expect(parsed.findings[0].category).toBe('spec_violation')
  })

  it('returns blocked when no valid Meta Review JSON exists', () => {
    const result = parseMetaReviewResult('not json', 'task-test')

    expect(result.status).toBe('blocked')
    expect(result.riskLevel).toBe('critical')
    expect(result.requiresCeoApproval).toBe(true)
  })
})

describe('buildMetaReviewPrompt canonical context selection', () => {
  it('includes Constitution and Decision Authority only for an authority-path diff', () => {
    const authorityRequest = buildMetaReviewRequest(
      't',
      'authority change',
      ['apps/api/src/pl/recovery.ts'],
      REPO_ROOT,
      '+ change',
    )
    const unrelatedRequest = buildMetaReviewRequest(
      't',
      'mobile copy',
      ['apps/mobile/src/screens/Home.tsx'],
      REPO_ROOT,
      '+ copy',
    )

    const authorityPrompt = buildMetaReviewPrompt(authorityRequest, REPO_ROOT)
    const unrelatedPrompt = buildMetaReviewPrompt(unrelatedRequest, REPO_ROOT)

    expect(authorityPrompt).toContain('## 3.14 Minimum Sufficient Validation')
    expect(authorityPrompt).toContain('## 1-2. Human Decision Authority')
    expect(authorityPrompt).toContain('## 14-3. Priority 2 境界表')
    expect(unrelatedPrompt).toContain('## 3.14 Minimum Sufficient Validation')
    expect(unrelatedPrompt).not.toContain('## 1-2. Human Decision Authority')
    expect(providedCanonicalPrincipleIds(unrelatedRequest)).not.toContain('specs/22 §1-2')
  })

  it('bounds the PR body and keeps it only inside the explicitly untrusted block', () => {
    const marker = 'PR_CLAIM_MARKER'
    const request = buildMetaReviewRequest(
      't',
      'PR body',
      ['docs/readme.md'],
      REPO_ROOT,
      '+ docs',
      `${marker}${'x'.repeat(MAX_PR_BODY_CHARS)}TAIL_NOT_INCLUDED`,
    )
    const prompt = buildMetaReviewPrompt(request, REPO_ROOT)
    const start = prompt.indexOf('[BEGIN UNTRUSTED PR BODY]')
    const end = prompt.indexOf('[END UNTRUSTED PR BODY]')

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(prompt.indexOf(marker)).toBeGreaterThan(start)
    expect(prompt.indexOf(marker)).toBeLessThan(end)
    expect(prompt).not.toContain('TAIL_NOT_INCLUDED')
    expect(prompt.slice(0, start)).not.toContain(marker)
    expect(prompt.slice(end)).not.toContain(marker)
    expect(prompt).toContain('never authority')
  })

  it('wires PR_BODY through workflow env without shell interpolation', () => {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/meta-review.yml'), 'utf-8')
    const runLines = workflow.split(/\r?\n/).filter((line) => /^\s*run:/.test(line))

    expect(workflow).toContain('PR_BODY:   ${{ github.event.pull_request.body }}')
    expect(runLines.join('\n')).not.toContain('${{ github.event.pull_request.body }}')
  })
})
