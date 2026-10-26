import { describe, expect, it } from 'vitest'
import {
  ChallengerResponseError,
  QUESTION_IDS,
  buildPacket,
  collectAddedFacts,
  evaluateDue,
  findFixChains,
  isAuthoritySurface,
  matchesCodeownersPattern,
  parseAuditMarkers,
  parseChallengerResponse,
  parseCodeownersPatterns,
  prNumberOf,
  rankChurn,
  routeFindings,
  validateAuditChain,
  windowChanges,
  type ChallengerFinding,
  type WindowCommit,
} from './crossTaskAudit.js'

const sha = (n: number) => n.toString(16).padStart(40, '0')
const commit = (n: number, files: string[], subject = `change ${n} (#${100 + n})`, body = ''): WindowCommit => ({
  sha: sha(n),
  subject,
  body,
  files,
})

describe('audit pointer', () => {
  it('parses the marker written in a record', () => {
    const md = `# Cross-Task Audit\n<!-- cross-task-audit base=${sha(1)} head=${sha(2)} -->\n`
    expect(parseAuditMarkers(md)).toEqual([{ base: sha(1), head: sha(2) }])
  })

  it('ignores markers whose SHAs are abbreviated', () => {
    expect(parseAuditMarkers('<!-- cross-task-audit base=abc123 head=def456 -->')).toEqual([])
  })

  it('follows the chain to the latest head', () => {
    const records = [
      { path: 'a.md', marker: { base: sha(1), head: sha(2) } },
      { path: 'b.md', marker: { base: sha(2), head: sha(3) } },
    ]
    expect(validateAuditChain(records, () => true)).toEqual({ latestHead: sha(3), issues: [] })
  })

  it('refuses a fork instead of guessing which record is latest', () => {
    const records = [
      { path: 'a.md', marker: { base: sha(1), head: sha(2) } },
      { path: 'b.md', marker: { base: sha(1), head: sha(3) } },
    ]
    const result = validateAuditChain(records, () => true)
    expect(result.latestHead).toBeNull()
    expect(result.issues.join('\n')).toContain('fork')
  })

  it('refuses a head that is not on first-parent master (squash or branch SHA)', () => {
    const records = [{ path: 'a.md', marker: { base: sha(1), head: sha(9) } }]
    const result = validateAuditChain(records, (s) => s !== sha(9))
    expect(result.latestHead).toBeNull()
    expect(result.issues[0]).toContain('not on first-parent master')
  })

  it('refuses a gap between records', () => {
    const records = [
      { path: 'a.md', marker: { base: sha(1), head: sha(2) } },
      { path: 'b.md', marker: { base: sha(5), head: sha(6) } },
    ]
    expect(validateAuditChain(records, () => true).latestHead).toBeNull()
  })
})

describe('window', () => {
  it('reads PR numbers from squash and merge subjects', () => {
    expect(prNumberOf('[pl] parsers read the first object (#409)')).toBe(409)
    expect(prNumberOf('Merge pull request #393 from x/y')).toBe(393)
    expect(prNumberOf('Merge master into ai/lifecycle-stack-13')).toBeNull()
  })

  it("excludes the audit's own record PR and ledger-only changes", () => {
    const changes = windowChanges([
      commit(1, ['docs/project_memory/decisions/cross_task_audit_2026_10_26.md']),
      commit(2, ['tasks/roadmap.md', 'docs/PROJECT_CURRENT_STATE.md']),
      commit(3, ['apps/api/src/pl/a.ts', 'tasks/roadmap.md']),
    ])
    expect(changes.map((c) => c.sha)).toEqual([sha(3)])
  })
})

describe('rankChurn', () => {
  it('ranks a suddenly hot module above a hub file that is always touched', () => {
    const baseline = Array.from({ length: 30 }, (_, i) => commit(1000 + i, i % 3 === 0 ? ['hub.ts', 'x.ts'] : ['hub.ts']))
    const window = [commit(1, ['hub.ts', 'pl/conflict.ts']), commit(2, ['hub.ts', 'pl/conflict.ts']), commit(3, ['hub.ts', 'pl/conflict.ts'])]
    const ranked = rankChurn(window, baseline)
    expect(ranked[0]!.path).toBe('pl/conflict.ts')
    expect(ranked.map((r) => r.path)).toContain('hub.ts')
  })

  it('never reports a file touched by only one window change', () => {
    expect(rankChurn([commit(1, ['a.ts']), commit(2, ['b.ts'])], [])).toEqual([])
  })

  it('does not rank test files', () => {
    expect(rankChurn([commit(1, ['a.test.ts']), commit(2, ['a.test.ts'])], [])).toEqual([])
  })

  it('does not count ledger files as structure', () => {
    expect(rankChurn([commit(1, ['tasks/roadmap.md']), commit(2, ['tasks/roadmap.md'])], [])).toEqual([])
  })
})

describe('findFixChains', () => {
  it('links a change that cites earlier window PRs in its body', () => {
    const window = [
      commit(7, ['a.ts'], 'x (#407)'),
      commit(8, ['a.ts'], 'y (#408)'),
      commit(9, ['a.ts'], 'z (#409)', 'the JSON-only agent (#407) ... Under #408 that cost one round'),
    ]
    expect(findFixChains(window)).toEqual([{ sha: sha(9), pr: 409, cites: [407, 408] }])
  })

  it('ignores citations of PRs outside the window and self-citations', () => {
    expect(findFixChains([commit(1, ['a.ts'], 'x (#101)', 'see #55 and #101'), commit(2, ['b.ts'], 'y (#102)')])).toEqual([])
  })
})

describe('collectAddedFacts', () => {
  it('reports new budget constants and audit operations but not ones already at base', () => {
    const facts = collectAddedFacts(
      [
        { sha: sha(1), file: 'apps/api/src/pl/a.ts', text: 'const MAX_CONFLICT_ROUNDS_PER_EPOCH = 3' },
        { sha: sha(1), file: 'apps/api/src/pl/a.ts', text: "  operation: 'conflict_round_capped'," },
        { sha: sha(1), file: 'apps/api/src/pl/a.ts', text: "  operation: 'pl_loop'," },
      ],
      (lit) => lit === 'pl_loop',
    )
    expect(facts.budgetConstants.map((b) => b.name)).toEqual(['MAX_CONFLICT_ROUNDS_PER_EPOCH'])
    expect(facts.auditOperations.map((o) => o.operation)).toEqual(['conflict_round_capped'])
  })

  it('reports a new literal only when it appears in two layers', () => {
    const facts = collectAddedFacts(
      [
        { sha: sha(1), file: 'apps/api/src/routes/tasks.ts', text: "if (s === 'park_requested') {" },
        { sha: sha(2), file: 'apps/mobile/lib/status.ts', text: "case 'park_requested':" },
        { sha: sha(2), file: 'apps/mobile/lib/status.ts', text: "label('mobile_only_thing')" },
      ],
      () => false,
    )
    expect(facts.crossLayerLiterals).toEqual([{ literal: 'park_requested', layers: ['apps/api', 'apps/mobile'] }])
  })

  it('ignores test files', () => {
    const facts = collectAddedFacts([{ sha: sha(1), file: 'apps/api/src/a.test.ts', text: 'const MAX_X = 1' }], () => false)
    expect(facts.budgetConstants).toEqual([])
  })
})

describe('authority surface from CODEOWNERS', () => {
  const patterns = parseCodeownersPatterns(
    ['# comment', '.github/workflows/ @owner', 'AGENTS.md @owner', 'apps/api/src/pl/actionGate.ts @owner', 'docs/*.md @owner', ''].join('\n'),
  )

  it('parses patterns and skips comments', () => {
    expect(patterns).toEqual(['.github/workflows/', 'AGENTS.md', 'apps/api/src/pl/actionGate.ts', 'docs/*.md'])
  })

  it('matches directory, exact and glob patterns', () => {
    expect(isAuthoritySurface('.github/workflows/ci.yml', patterns)).toBe(true)
    expect(isAuthoritySurface('apps/api/src/pl/actionGate.ts', patterns)).toBe(true)
    expect(isAuthoritySurface('docs/x.md', patterns)).toBe(true)
    expect(isAuthoritySurface('docs/sub/x.md', patterns)).toBe(false)
    expect(isAuthoritySurface('apps/api/src/pl/actionGateHelper.ts', patterns)).toBe(false)
  })

  it('treats a leading slash as repo-root anchored', () => {
    expect(matchesCodeownersPattern('CLAUDE.md', '/CLAUDE.md')).toBe(true)
  })
})

describe('evaluateDue', () => {
  const patterns = ['apps/api/src/pl/actionGate.ts']
  const base = { deployedSha: null, fixChains: [], authorityPatterns: patterns }

  it('is never due with fewer than two changes, even at a deploy', () => {
    expect(evaluateDue({ ...base, changes: [commit(1, ['a.ts'])], deployedSha: sha(1) }).due).toBe(false)
  })

  it('is not due on a plain window with no boundary, chain or authority overlap', () => {
    expect(evaluateDue({ ...base, changes: [commit(1, ['a.ts']), commit(2, ['b.ts'])] }).due).toBe(false)
  })

  it('is due at a deploy boundary', () => {
    const r = evaluateDue({ ...base, changes: [commit(1, ['a.ts']), commit(2, ['b.ts'])], deployedSha: sha(2) })
    expect(r.due).toBe(true)
    expect(r.reasons[0]).toContain('deploy boundary')
  })

  it('is due on a fix chain', () => {
    const changes = [commit(1, ['a.ts']), commit(2, ['a.ts'])]
    expect(evaluateDue({ ...base, changes, fixChains: [{ sha: sha(2), pr: 102, cites: [101] }] }).due).toBe(true)
  })

  it('is due when two changes touched the authority surface, but not one', () => {
    const one = [commit(1, ['apps/api/src/pl/actionGate.ts']), commit(2, ['b.ts'])]
    const two = [commit(1, ['apps/api/src/pl/actionGate.ts']), commit(2, ['apps/api/src/pl/actionGate.ts'])]
    expect(evaluateDue({ ...base, changes: one }).due).toBe(false)
    expect(evaluateDue({ ...base, changes: two }).due).toBe(true)
  })
})

const finding = (over: Partial<ChallengerFinding> = {}): ChallengerFinding => ({
  questionId: 'surviving_failure_class',
  claim: 'The greedy JSON parse survives on the adoption path.',
  evidence: ['apps/api/src/pl/adoptionStep.ts:120'],
  falsifiableCheck: 'grep for lastIndexOf("}") in adoption parsing',
  severity: 'medium',
  routing: 'technical',
  ...over,
})

describe('parseChallengerResponse', () => {
  it('treats an unanswered, unlisted question as uncertain, never as clean', () => {
    const r = parseChallengerResponse({ findings: [finding()], checkedClean: ['duplicate_owner'] })
    expect(r.checkedClean).toEqual(['duplicate_owner'])
    expect(r.uncertainQuestions).not.toContain('duplicate_owner')
    expect(r.uncertainQuestions).not.toContain('surviving_failure_class')
    expect(r.uncertainQuestions).toContain('production_divergence')
    expect(r.uncertainQuestions.length).toBe(QUESTION_IDS.length - 2)
  })

  it('keeps a question uncertain when it is listed both clean and uncertain', () => {
    const r = parseChallengerResponse({ findings: [], checkedClean: ['complexity_growth'], uncertainQuestions: ['complexity_growth'] })
    expect(r.checkedClean).toEqual([])
    expect(r.uncertainQuestions).toContain('complexity_growth')
  })

  it('rejects unknown question ids, missing evidence and bad routing', () => {
    expect(() => parseChallengerResponse({ findings: [{ ...finding(), questionId: 'other' }] })).toThrow(ChallengerResponseError)
    expect(() => parseChallengerResponse({ findings: [{ ...finding(), evidence: [] }] })).toThrow('evidence')
    expect(() => parseChallengerResponse({ findings: [{ ...finding(), routing: 'ceo' }] })).toThrow('routing')
    expect(() => parseChallengerResponse([])).toThrow('JSON object')
  })
})

describe('routeFindings (mechanical, upgrade-only)', () => {
  const patterns = ['apps/api/src/pl/actionGate.ts', 'AGENTS.md']

  it('keeps a plain technical finding technical', () => {
    const [r] = routeFindings([finding()], patterns, 'xta-abc1234')
    expect(r!.routing).toBe('technical')
    expect(r!.daReasons).toEqual([])
    expect(r!.id).toBe('xta-abc1234-01')
  })

  it('upgrades a finding labelled technical whose evidence is on the authority surface', () => {
    const [r] = routeFindings([finding({ evidence: ['apps/api/src/pl/actionGate.ts:88'] })], patterns, 'x')
    expect(r!.routing).toBe('decision_authority')
    expect(r!.daReasons[0]).toContain('authority surface')
  })

  it('upgrades on approval / authority language and on the authority question', () => {
    expect(routeFindings([finding({ claim: 'An approval now binds to the command kind.' })], patterns, 'x')[0]!.routing).toBe('decision_authority')
    expect(routeFindings([finding({ claim: '承認の対象が変わった' })], patterns, 'x')[0]!.routing).toBe('decision_authority')
    expect(routeFindings([finding({ questionId: 'authority_tuple_drift' })], patterns, 'x')[0]!.routing).toBe('decision_authority')
  })

  it('never downgrades a decision_authority label from the Challenger', () => {
    const [r] = routeFindings([finding({ routing: 'decision_authority', daTrigger: 'Goal change' })], patterns, 'x')
    expect(r!.routing).toBe('decision_authority')
    expect(r!.daReasons).toEqual(['challenger: Goal change'])
  })
})

describe('buildPacket', () => {
  const input = {
    base: sha(1),
    head: sha(2),
    due: { due: true, reasons: ['deploy boundary 00000000'], authorityChanges: [] },
    changes: [commit(1, ['a.ts']), commit(2, ['a.ts'])],
    churn: [{ path: 'a.ts', windowTouches: 2, baselineTouches: 0, lift: 3 }],
    fixChains: [],
    facts: { budgetConstants: [], auditOperations: [], crossLayerLiterals: [] },
    fileDiffs: [
      { path: 'a.ts', diff: '+small' },
      { path: 'big.ts', diff: `+${'x'.repeat(5000)}` },
    ],
    production: null,
    budgetChars: 4000,
  }

  it('lists files dropped for budget and tells the Challenger to mark them uncertain', () => {
    const p = buildPacket(input)
    expect(p.includedFiles).toEqual(['a.ts'])
    expect(p.omittedFiles).toEqual(['big.ts'])
    expect(p.text).toContain('OMITTED for budget')
    expect(p.text).toContain('uncertainQuestions')
  })

  it('says production observation is missing instead of leaving it blank', () => {
    expect(buildPacket(input).text).toContain('NOT PROVIDED')
  })
})
