// Posts the `Code Owner Approval` commit status for the PR(s) named by the triggering event.
// Runs from the default branch (see .github/workflows/codeowner-approval.yml); never checks out or
// executes PR code. Uses only the GitHub REST API with the workflow's GITHUB_TOKEN.
//
//   node .github/scripts/codeownerApprovalCheck.mjs                 (in Actions: reads GITHUB_EVENT_PATH)
//   node .github/scripts/codeownerApprovalCheck.mjs --dry-run 417   (local: print, do not post)
import { readFileSync } from 'node:fs'
import { evaluateCodeOwnerApproval, parseCodeownersRules } from './codeowners.mjs'

const CONTEXT = 'Code Owner Approval'
const MAX_PR_FILES = 3000 // the files API stops listing here; beyond it the decision would be partial
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
const REPO = process.env.GITHUB_REPOSITORY ?? 'kamikaze-investor/softwareDevelopAIteam'

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${TOKEN}`, 'x-github-api-version': '2022-11-28', ...init.headers },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${await res.text()}`)
  return res
}

async function paginate(path) {
  const out = []
  for (let page = 1; ; page++) {
    const batch = await (await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)).json()
    out.push(...batch)
    if (batch.length < 100) return out
  }
}

async function codeownersAt(ref) {
  const res = await gh(`/repos/${REPO}/contents/.github/CODEOWNERS?ref=${ref}`, { headers: { accept: 'application/vnd.github.raw+json' } })
  return res.text()
}

/** @returns {Promise<{ sha: string, state: string, description: string } | { skip: string }>} */
async function decide(prNumber, defaultBranch) {
  const pr = await (await gh(`/repos/${REPO}/pulls/${prNumber}`)).json()
  const headSha = pr.head.sha
  // A status belongs to the commit, not to the PR. A success computed against another base (or by
  // another PR with the same head) would otherwise count for a PR into the default branch, so any
  // other base posts an explicit non-success instead of staying silent.
  if (pr.base.ref !== defaultBranch) {
    return { sha: headSha, state: 'failure', description: `base ${pr.base.ref} is not ${defaultBranch}; approval is only decided for PRs into ${defaultBranch}` }
  }
  // Fork PRs are not decided here (same boundary as the base-run Meta Review): fail closed.
  if (pr.head.repo?.full_name !== REPO) {
    return { sha: headSha, state: 'failure', description: 'fork PR: Code Owner Approval is not decided for forks (fail closed)' }
  }
  const files = await paginate(`/repos/${REPO}/pulls/${prNumber}/files`)
  if (files.length >= MAX_PR_FILES) {
    return { sha: headSha, state: 'failure', description: `PR lists ${files.length}+ files; cannot see all changed paths (fail closed)` }
  }
  // CODEOWNERS of the BASE: a PR cannot weaken its own requirement by editing CODEOWNERS.
  const rules = parseCodeownersRules(await codeownersAt(pr.base.sha))
  const reviews = await paginate(`/repos/${REPO}/pulls/${prNumber}/reviews`)
  const result = evaluateCodeOwnerApproval({ files, rules, reviews, headSha })
  // Files and reviews were read after the head: if the PR moved meanwhile, this decision mixes two
  // states. Post nothing; the event that moved it runs the check again.
  const after = await (await gh(`/repos/${REPO}/pulls/${prNumber}`)).json()
  if (after.head.sha !== headSha || after.base.ref !== pr.base.ref || after.base.sha !== pr.base.sha) {
    return { skip: `PR moved to ${after.head.sha.slice(0, 7)} during evaluation` }
  }
  return { sha: headSha, state: result.state, description: result.description }
}

const SEVERITY = { success: 0, pending: 1, failure: 2, error: 3 }

/**
 * A status belongs to the commit, so every open PR whose head is this commit must pass: one
 * approved PR must not cover another unapproved (or non-default-base) PR on the same SHA.
 * The worst decision wins; if any of them moved during evaluation, post nothing.
 */
async function decideSha(prNumber, defaultBranch) {
  const first = await decide(prNumber, defaultBranch)
  if ('skip' in first) return first
  const openOnSha = async () =>
    (await paginate(`/repos/${REPO}/commits/${first.sha}/pulls`))
      .filter((p) => p.state === 'open' && p.head.sha === first.sha)
      .map((p) => p.number)
      .sort((a, b) => a - b)
  const before = await openOnSha()
  let worst = first
  for (const n of before.filter((n) => n !== prNumber)) {
    const d = await decide(n, defaultBranch)
    if ('skip' in d) return d
    // A sibling that moved to another head is not a decision about this SHA.
    if (d.sha !== first.sha) return { skip: `#${n} moved off ${first.sha.slice(0, 7)} during evaluation` }
    if (SEVERITY[d.state] > SEVERITY[worst.state]) worst = { ...d, description: `#${n}: ${d.description}`.slice(0, 140) }
  }
  // If the set of PRs on this SHA changed meanwhile, the combined decision is stale; post nothing
  // and let the event that changed it run the check again.
  const after = await openOnSha()
  if (after.join(',') !== before.join(',')) return { skip: `PRs on ${first.sha.slice(0, 7)} changed during evaluation` }
  return worst
}

async function prNumbersFromEvent() {
  const event = JSON.parse(readFileSync(/** @type {string} */ (process.env.GITHUB_EVENT_PATH), 'utf8'))
  if (event.pull_request) return [event.pull_request.number]
  if (event.workflow_run) {
    // A review event does not reliably name its PR: `workflow_run.pull_requests` is empty for fork
    // PRs and other cases, and the run's head_sha is not guaranteed to be the PR head. Re-decide
    // every open PR into the default branch instead; each decision only reads, and posts on that
    // PR's own current head.
    const base = (await (await gh(`/repos/${REPO}`)).json()).default_branch
    const open = await paginate(`/repos/${REPO}/pulls?state=open&base=${encodeURIComponent(base)}`)
    return open.map((p) => p.number)
  }
  throw new Error(`unsupported event: ${process.env.GITHUB_EVENT_NAME}`)
}

async function main() {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is not set')
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const numbers = dryRun ? args.filter((a) => /^\d+$/.test(a)).map(Number) : await prNumbersFromEvent()
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined
  const defaultBranch = (await (await gh(`/repos/${REPO}`)).json()).default_branch
  for (const n of numbers) {
    let decision
    try {
      decision = await decideSha(n, defaultBranch)
      if ('skip' in decision) {
        console.log(`#${n} skipped: ${decision.skip}`)
        continue
      }
    } catch (error) {
      // Any API failure fails closed on the current head, so a broken check never reads as approved.
      const pr = await (await gh(`/repos/${REPO}/pulls/${n}`)).json()
      decision = { sha: pr.head.sha, state: 'error', description: `check failed: ${String(error).slice(0, 100)}` }
    }
    console.log(`#${n} ${decision.sha.slice(0, 7)} ${decision.state}: ${decision.description}`)
    if (dryRun) continue
    await gh(`/repos/${REPO}/statuses/${decision.sha}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: decision.state, context: CONTEXT, description: decision.description, ...(runUrl ? { target_url: runUrl } : {}) }),
    })
  }
}

main().catch((error) => {
  console.error(String(error))
  process.exitCode = 1
})
