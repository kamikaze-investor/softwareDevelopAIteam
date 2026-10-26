// Tests for the Code Owner Approval decision (.github/scripts/codeowners.mjs). The module lives under
// .github/scripts so the checker runs dependency-free from the default branch; it is tested here
// because the worker's vitest run is what CI executes.
import { describe, expect, it } from 'vitest'
import { evaluateCodeOwnerApproval, ownersFor, parseCodeownersRules, type Review } from '../../../../.github/scripts/codeowners.mjs'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const rules = parseCodeownersRules(
  [
    '# comment',
    '.github/workflows/ @ceo',
    'AGENTS.md @ceo   # trailing comment',
    'apps/api/src/pl/actionGate.ts @ceo',
    'docs/team-owned.md @org/team',
    'apps/api/src/pl/actionGate.generated.ts',
    'apps/api/src/pl/ @ceo',
    'apps/api/src/pl/free.ts',
  ].join('\n'),
)
const review = (id: number, login: string, state: string, commit = HEAD): Review => ({ id, user: { login }, state, commit_id: commit })
const decide = (files: { filename: string; previous_filename?: string }[], reviews: Review[] = []) =>
  evaluateCodeOwnerApproval({ files, rules, reviews, headSha: HEAD })

describe('ownersFor (GitHub semantics)', () => {
  it('strips comments, including trailing ones', () => {
    expect(rules.find((r) => r.pattern === 'AGENTS.md')?.owners).toEqual(['@ceo'])
  })

  it('lets the last matching rule win, and a later rule with no owners un-owns the path', () => {
    expect(ownersFor('apps/api/src/pl/actionGate.ts', rules)).toEqual(['@ceo'])
    expect(ownersFor('apps/api/src/pl/free.ts', rules)).toEqual([])
    expect(ownersFor('apps/api/src/pl/other.ts', rules)).toEqual(['@ceo'])
  })

  it('matches a slash-free pattern at any depth', () => {
    expect(ownersFor('apps/x/AGENTS.md', rules)).toEqual(['@ceo'])
  })

  it('lets a wildcard last segment match one level only, as GitHub does', () => {
    const r = parseCodeownersRules('docs/* @ceo')
    expect(ownersFor('docs/a.md', r)).toEqual(['@ceo'])
    expect(ownersFor('docs/sub/a.md', r)).toEqual([])
    expect(ownersFor('docs/sub/a.md', parseCodeownersRules('docs/ @ceo'))).toEqual(['@ceo'])
    expect(ownersFor('apps/deep/x.ts', parseCodeownersRules('apps/** @ceo'))).toEqual(['@ceo'])
  })
})

describe('evaluateCodeOwnerApproval', () => {
  it('passes a PR that changes no owned file, with no review at all (normal work is not slowed)', () => {
    expect(decide([{ filename: 'apps/api/src/routes/tasks.ts' }, { filename: 'tasks/roadmap.md' }]).state).toBe('success')
  })

  it('waits when an owned file changed and nobody approved', () => {
    const r = decide([{ filename: 'AGENTS.md' }])
    expect(r.state).toBe('pending')
    expect(r.waiting).toEqual(['AGENTS.md'])
  })

  it('passes once a code owner approved the head commit', () => {
    const r = decide([{ filename: 'AGENTS.md' }], [review(1, 'CEO', 'APPROVED')])
    expect(r.state).toBe('success')
    expect(r.description).toContain('@ceo')
  })

  it('does not carry an approval of an earlier commit over to a new head', () => {
    expect(decide([{ filename: 'AGENTS.md' }], [review(1, 'ceo', 'APPROVED', OLD)]).state).toBe('pending')
  })

  it('ignores approvals from people who do not own the file', () => {
    expect(decide([{ filename: 'AGENTS.md' }], [review(1, 'someone', 'APPROVED')]).state).toBe('pending')
  })

  it('lets a later CHANGES_REQUESTED or DISMISSED cancel an approval, but not a later COMMENTED', () => {
    const f = [{ filename: 'AGENTS.md' }]
    expect(decide(f, [review(1, 'ceo', 'APPROVED'), review(2, 'ceo', 'CHANGES_REQUESTED')]).state).toBe('pending')
    expect(decide(f, [review(1, 'ceo', 'APPROVED'), review(2, 'ceo', 'DISMISSED')]).state).toBe('pending')
    expect(decide(f, [review(1, 'ceo', 'APPROVED'), review(2, 'ceo', 'COMMENTED')]).state).toBe('success')
  })

  it('orders reviews by id, not by array position', () => {
    expect(decide([{ filename: 'AGENTS.md' }], [review(5, 'ceo', 'APPROVED'), review(2, 'ceo', 'CHANGES_REQUESTED')]).state).toBe('success')
  })

  it('checks the old path of a rename, so moving a file off the protected surface still needs approval', () => {
    const r = decide([{ filename: 'apps/api/src/util/actionGate.ts', previous_filename: 'apps/api/src/pl/actionGate.ts' }])
    expect(r.state).toBe('pending')
    expect(r.waiting).toEqual(['apps/api/src/pl/actionGate.ts'])
  })

  it('has no author shortcut: an owned change waits even if the PR was opened by the owner', () => {
    // The opener is not the pusher; a bot with push access could use an owner-opened PR.
    expect(decide([{ filename: 'AGENTS.md' }]).state).toBe('pending')
  })

  it('fails closed when the only owners are a team or e-mail it cannot verify', () => {
    const r = decide([{ filename: 'docs/team-owned.md' }], [review(1, 'ceo', 'APPROVED')])
    expect(r.state).toBe('failure')
    expect(r.unverifiable).toEqual(['docs/team-owned.md'])
  })

  it('keeps the status description within the 140-character limit', () => {
    const files = Array.from({ length: 40 }, (_, i) => ({ filename: `.github/workflows/w${i}.yml` }))
    expect(decide(files).description.length).toBeLessThanOrEqual(140)
  })
})
