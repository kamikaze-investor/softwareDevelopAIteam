// CODEOWNERS semantics and the Code Owner Approval decision. Dependency-free on purpose: the
// `codeowner-approval` workflow runs this file from the default branch without installing anything.
//
// This file is the single owner of "which CODEOWNERS rule owns a path" (GitHub semantics) for
// this repository. apps/worker/scripts/crossTaskAudit re-exports it instead of keeping a copy.
// It sits under .github/scripts/, which CODEOWNERS protects, so weakening the checker is itself a
// change that needs code-owner approval.

/**
 * @typedef {{ pattern: string, owners: string[] }} CodeownersRule
 * @typedef {{ filename: string, previous_filename?: string }} ChangedFile
 * @typedef {{ id: number, user: { login: string } | null, state: string, commit_id: string | null }} Review
 */

/** @param {string} codeowners @returns {CodeownersRule[]} */
export function parseCodeownersRules(codeowners) {
  return codeowners
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/)
      return { pattern: /** @type {string} */ (pattern), owners }
    })
}

/** @param {string} codeowners @returns {string[]} */
export function parseCodeownersPatterns(codeowners) {
  return parseCodeownersRules(codeowners).map((r) => r.pattern)
}

/**
 * GitHub CODEOWNERS semantics: a pattern with no slash except a trailing one (`AGENTS.md`,
 * `sandbox/`) matches at any depth; a leading slash or an inner slash anchors it at the root;
 * a trailing slash or a plain path also covers everything below it, but a last segment with a
 * wildcard does not (`docs/*` matches `docs/a.md`, not `docs/sub/a.md`).
 * @param {string} file @param {string} pattern
 */
export function matchesCodeownersPattern(file, pattern) {
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/')
  const body = pattern.replace(/^\//, '').replace(/\/$/, '')
  const glob = body
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/^\*\*\//, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/, '(?:.*/)?')
    .replace(/\u0000/g, '.*')
  const lastSegment = body.split('/').pop() ?? ''
  const subtree = pattern.endsWith('/') || !/[*?]/.test(lastSegment)
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${glob}${subtree ? '(?:$|/)' : '$'}`).test(file)
}

/**
 * Owners of a path: the LAST matching rule wins (GitHub semantics), and a matching rule with no
 * owners means the path has no owner.
 * @param {string} file @param {readonly CodeownersRule[]} rules @returns {string[]}
 */
export function ownersFor(file, rules) {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = /** @type {CodeownersRule} */ (rules[i])
    if (matchesCodeownersPattern(file, rule.pattern)) return rule.owners
  }
  return []
}

const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'])

/**
 * Decides the `Code Owner Approval` status.
 *
 * - success: no changed path (old or new name of a rename) is owned, or every owned path is
 *   approved by one of its user owners AT THE HEAD SHA (an approval of an earlier commit does not
 *   carry over).
 *   There is deliberately no "the PR author is an owner" shortcut: the author is whoever opened the
 *   PR, not whoever pushed its content, so a bot with push access could use an owner-opened PR.
 *   An owner-authored owned change therefore stays pending (GitHub does not let authors approve
 *   their own PR); have the bot open it instead.
 * - pending: some owned path still waits for its owner's approval.
 * - failure: an owned path has only owners this check cannot verify (teams, e-mails): fail closed.
 *
 * Only the latest decisive review per reviewer counts; a later COMMENTED review does not cancel an
 * approval, a later CHANGES_REQUESTED or DISMISSED does.
 *
 * @param {{ files: readonly ChangedFile[], rules: readonly CodeownersRule[], reviews: readonly Review[], headSha: string }} input
 * @returns {{ state: 'success' | 'pending' | 'failure', description: string, waiting: string[], unverifiable: string[] }}
 */
export function evaluateCodeOwnerApproval(input) {
  const paths = [...new Set(input.files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename])))]
  const latest = new Map()
  for (const r of [...input.reviews].sort((a, b) => a.id - b.id)) {
    if (!r.user || !DECISIVE_REVIEW_STATES.has(r.state)) continue
    latest.set(r.user.login.toLowerCase(), r)
  }
  const approvedAtHead = new Set(
    [...latest].filter(([, r]) => r.state === 'APPROVED' && r.commit_id === input.headSha).map(([login]) => login),
  )

  const waiting = []
  const unverifiable = []
  const approvers = new Set()
  let owned = 0
  for (const path of paths) {
    const owners = ownersFor(path, input.rules)
    if (owners.length === 0) continue
    owned += 1
    const users = owners.filter((o) => /^@[^/]+$/.test(o)).map((o) => o.slice(1).toLowerCase())
    if (users.length === 0) {
      unverifiable.push(path)
      continue
    }
    const approver = users.find((u) => approvedAtHead.has(u))
    if (approver) approvers.add(approver)
    else waiting.push(path)
  }

  const sha = input.headSha.slice(0, 7)
  if (unverifiable.length > 0) {
    return { state: 'failure', description: clip(`cannot verify owners (team/e-mail) of: ${unverifiable.join(', ')}`), waiting, unverifiable }
  }
  if (owned === 0) return { state: 'success', description: 'no CODEOWNERS-owned file changed', waiting, unverifiable }
  if (waiting.length > 0) {
    return { state: 'pending', description: clip(`awaiting code owner approval of ${sha} for ${waiting.length} file(s): ${waiting.join(', ')}`), waiting, unverifiable }
  }
  return { state: 'success', description: clip(`${owned} owned file(s) approved at ${sha} by ${[...approvers].map((a) => `@${a}`).join(', ')}`), waiting, unverifiable }
}

/** GitHub commit status descriptions are limited to 140 characters. @param {string} s */
function clip(s) {
  return s.length <= 140 ? s : `${s.slice(0, 137)}...`
}
