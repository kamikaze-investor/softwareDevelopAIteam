// Tests for .github/workflows/meta-review-base.yml. The start and post scripts are taken verbatim from
// the workflow file and run against an in-memory GitHub, so these tests exercise the exact code that
// posts the required `Meta Review (base)` status (no copy of the logic lives here).
//
// The threat (2026-10-29): the bot's token can force-cancel a run, which also stops the `always()` post
// job. After the review job answers BLOCKED, cancelling before post publishes it and then re-running
// (or pushing the same tree again) would re-roll the model with no BLOCKED on record.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

type Step = { name?: string; uses?: string; run?: string; with?: { script?: string } }
type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps: Step[] }
const workflow = YAML.parse(readFileSync(join(__dirname, '../../../../.github/workflows/meta-review-base.yml'), 'utf-8')) as {
  jobs: Record<string, Job>
}
const scriptOf = (job: string) => {
  const step = workflow.jobs[job].steps.find((s) => s.uses?.startsWith('actions/github-script@'))
  if (!step?.with?.script) throw new Error(`no github-script step in ${job}`)
  return step.with.script
}
const START = scriptOf('start')
const POST = scriptOf('post')

const CONTEXT = 'Meta Review (base)'
const BOT = 'github-actions[bot]'
type Status = { context: string; state: string; description: string; target_url: string; creator: { login: string } }

/**
 * One PR in an in-memory repository: a commit graph (each commit has a tree and a parent; `base` is the
 * PR base), the current head, the force-push timeline, and every commit status ever posted.
 */
function fakeRepo() {
  const statuses = new Map<string, Status[]>()
  const graph = new Map<string, { tree: string; parent: string }>()
  const forcePushes: string[] = [] // beforeCommit of each force-push, oldest first
  const comments: string[] = []
  let head = 'base'
  const chain = (tip: string) => {
    const out: { sha: string; tree: string }[] = []
    for (let s = tip; s !== 'base'; s = graph.get(s)!.parent) out.unshift({ sha: s, tree: graph.get(s)!.tree })
    return out
  }
  const asCommit = (c: { sha: string; tree: string }) => ({ sha: c.sha, commit: { tree: { sha: c.tree } } })
  /** Fast-forward push of a child of the current head. */
  const push = (sha: string, tree: string) => {
    graph.set(sha, { tree, parent: head })
    head = sha
  }
  /** Force-push: the new head replaces the current one (recorded in the timeline as beforeCommit). */
  const forcePush = (sha: string, tree: string, parent = 'base') => {
    forcePushes.push(head)
    graph.set(sha, { tree, parent })
    head = sha
  }
  const post = (sha: string, s: Omit<Status, 'creator'>, login = BOT) =>
    statuses.set(sha, [{ ...s, creator: { login } }, ...(statuses.get(sha) ?? [])]) // newest first, like the API
  const github = {
    paginate: async (fn: (p: Record<string, unknown>) => Promise<unknown[]>, params: Record<string, unknown>) => fn(params),
    graphql: async () => ({
      repository: { pullRequest: { timelineItems: { nodes: forcePushes.map((oid) => ({ beforeCommit: { oid } })), pageInfo: { hasNextPage: false, endCursor: null } } } },
    }),
    rest: {
      pulls: { listCommits: async () => chain(head).map(asCommit) },
      git: { getCommit: async ({ commit_sha }: { commit_sha: string }) => ({ data: { tree: { sha: graph.get(commit_sha)!.tree } } }) },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
          const commits = chain(basehead.split('...')[1]).map(asCommit)
          return { data: { total_commits: commits.length, commits } }
        },
        listCommitStatusesForRef: async ({ ref }: { ref: string }) => statuses.get(ref) ?? [],
        createCommitStatus: async ({ sha, state, context, description, target_url }: Status & { sha: string }) =>
          post(sha, { state, context, description, target_url }),
      },
      issues: { createComment: async ({ body }: { body: string }) => void comments.push(body) },
    },
  }
  /** The latest `Meta Review (base)` status on a commit: what the required check sees. */
  const latest = (sha: string) => statuses.get(sha)?.find((s) => s.context === CONTEXT)
  return { github, push, forcePush, statuses, comments, post, latest }
}
type Repo = ReturnType<typeof fakeRepo>

const savedEnv = { ...process.env }
afterEach(() => {
  process.env = { ...savedEnv }
})

async function runScript(script: string, repo: Repo, sha: string, runId: number, attempt: number, env: Record<string, string> = {}) {
  process.env = { ...savedEnv, GITHUB_RUN_ATTEMPT: String(attempt), IS_FORK: 'false', OUTCOME: '', RESULT_B64: '', ...env }
  const context = {
    repo: { owner: 'kamikaze-investor', repo: 'softwareDevelopAIteam' },
    serverUrl: 'https://github.com',
    runId,
    payload: { pull_request: { number: 500, head: { sha }, base: { sha: 'base' } } },
  }
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  await new AsyncFunction('github', 'context', 'core', script)(repo.github, context, { info: () => {} })
}

const result = (status: string, extra: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ status, riskLevel: 'low', summary: 's', findings: [], providerUsed: 'gemini', ...extra })).toString('base64')
const APPROVED = { OUTCOME: 'success', RESULT_B64: result('approved') }
const BLOCKED = { OUTCOME: 'failure', RESULT_B64: result('blocked') }
// autoReview.ts writes a provider failure as `blocked` without providerUsed: an infra error, not a verdict.
const PROVIDER_FAILED = { OUTCOME: 'failure', RESULT_B64: result('blocked', { providerUsed: undefined }) }
const NO_RESULT = { OUTCOME: 'cancelled' }

/** A whole run: start marker, then (unless force-cancelled before post) the post job. */
async function run(repo: Repo, sha: string, runId: number, attempt: number, verdict: Record<string, string> | 'force-cancelled') {
  await runScript(START, repo, sha, runId, attempt)
  if (verdict !== 'force-cancelled') await runScript(POST, repo, sha, runId, attempt, verdict)
}

describe('meta-review-base workflow: job wiring', () => {
  it('start runs before review, with only statuses: write and no checkout or shell step', () => {
    const start = workflow.jobs.start
    expect(start.permissions).toEqual({ statuses: 'write' })
    expect(start.steps.every((s) => s.uses?.startsWith('actions/github-script@') && !s.run)).toBe(true)
    expect(workflow.jobs.review.needs).toBe('start')
    expect(workflow.jobs.review.permissions).not.toHaveProperty('statuses')
  })

  it('post waits for both jobs and still runs after an ordinary cancel', () => {
    expect(workflow.jobs.post.needs).toEqual(['start', 'review'])
    expect(workflow.jobs.post.if).toBe('always()')
  })

  it('start and post build the same per-attempt target_url', () => {
    const expr = '/actions/runs/${context.runId}/attempts/${process.env.GITHUB_RUN_ATTEMPT}'
    expect(START).toContain(expr)
    expect(POST).toContain('const runKey = `${runUrl}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`')
    expect(POST).toContain('target_url: runKey')
  })
})

describe('meta-review-base workflow: a withheld BLOCKED cannot be laundered', () => {
  it('force-cancel after the review, then re-run on the same commit: failure, not the re-rolled approval', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    await run(repo, 'h1', 1, 2, APPROVED)
    expect(repo.latest('h1')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^withheld:/) })
  })

  it('force-cancel, then push a commit with the same tree: failure', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    repo.push('h2', 't1')
    await run(repo, 'h2', 2, 1, APPROVED)
    expect(repo.latest('h2')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^withheld:/) })
  })

  it('force-cancel, then "re-run failed jobs" (start is not re-run): failure', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    await runScript(POST, repo, 'h1', 1, 2, APPROVED)
    expect(repo.latest('h1')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^withheld:/) })
  })

  it('a re-run started by the repository owner is held too (the withheld verdict is unknown to them)', async () => {
    // Who started the re-run does not matter: the earlier attempt's answer was never published.
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    await run(repo, 'h1', 1, 2, { ...APPROVED, GITHUB_TRIGGERING_ACTOR: 'kamikaze-investor' })
    expect(repo.latest('h1')?.state).toBe('failure')
  })

  it('a final status posted with a PAT does not mark the cancelled attempt as finished', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    const marker = repo.latest('h1')!
    repo.post('h1', { context: CONTEXT, state: 'success', description: 'verdict: approved', target_url: marker.target_url }, 'AIteamOS-bot')
    await run(repo, 'h1', 1, 2, APPROVED)
    expect(repo.latest('h1')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^withheld:/) })
  })

  it('force-cancel, a fast-forward on top, then a force-push back to the same tree: failure', async () => {
    // The timeline only records h3 as beforeCommit; h1 is reachable only from h3.
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    repo.push('h3', 't3')
    repo.forcePush('h2', 't1')
    await run(repo, 'h2', 3, 1, APPROVED)
    expect(repo.latest('h2')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^withheld:/) })
  })

  it('the same detour cannot clear a completed BLOCKED either', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, BLOCKED)
    repo.push('h3', 't3')
    repo.forcePush('h2', 't1')
    await run(repo, 'h2', 3, 1, APPROVED)
    expect(repo.latest('h2')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^verdict: blocked \(sticky/) })
  })

  it('without a usable run attempt the start marker is refused and post cannot pass', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await expect(runScript(START, repo, 'h1', 1, 1, { GITHUB_RUN_ATTEMPT: '' })).rejects.toThrow(/GITHUB_RUN_ATTEMPT/)
    await runScript(POST, repo, 'h1', 1, 1, { ...APPROVED, GITHUB_RUN_ATTEMPT: '' })
    expect(repo.latest('h1')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^error: sticky-verdict lookup failed/) })
  })

  it('a lookup that cannot be complete fails closed (truncated compare, 250+ commits, 1000+ statuses)', async () => {
    const truncated = fakeRepo()
    truncated.push('h1', 't1')
    truncated.forcePush('h2', 't2')
    truncated.github.rest.repos.compareCommitsWithBasehead = async () => ({ data: { total_commits: 300, commits: [] } })
    await run(truncated, 'h2', 1, 1, APPROVED)
    expect(truncated.latest('h2')?.state).toBe('failure')

    const long = fakeRepo()
    for (let i = 0; i < 250; i++) long.push(`c${i}`, `t${i}`)
    await run(long, 'c249', 1, 1, APPROVED)
    expect(long.latest('c249')?.state).toBe('failure')

    const noisy = fakeRepo()
    noisy.push('h1', 't1')
    for (let i = 0; i < 1000; i++) noisy.post('h1', { context: `spam ${i}`, state: 'success', description: '', target_url: '' }, 'AIteamOS-bot')
    await run(noisy, 'h1', 1, 1, APPROVED)
    expect(noisy.latest('h1')?.state).toBe('failure')
  })

  it('the completed-BLOCKED sticky rule still holds', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, BLOCKED)
    await run(repo, 'h1', 1, 2, APPROVED)
    expect(repo.latest('h1')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^verdict: blocked \(sticky/) })
  })
})

describe('meta-review-base workflow: normal development keeps working', () => {
  it('an approval passes, and the start marker is replaced by the final status', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await runScript(START, repo, 'h1', 1, 1)
    expect(repo.latest('h1')).toMatchObject({ state: 'pending', description: 'started: review in progress' })
    await runScript(POST, repo, 'h1', 1, 1, APPROVED)
    expect(repo.latest('h1')).toMatchObject({ state: 'success', description: 'verdict: approved / risk low' })
  })

  it('a provider failure can be cleared by re-running all jobs', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, PROVIDER_FAILED)
    expect(repo.latest('h1')?.state).toBe('failure')
    await run(repo, 'h1', 1, 2, APPROVED)
    expect(repo.latest('h1')?.state).toBe('success')
  })

  it('a provider failure can be cleared by "re-run failed jobs" (start not re-run)', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, PROVIDER_FAILED)
    await runScript(POST, repo, 'h1', 1, 2, APPROVED)
    expect(repo.latest('h1')?.state).toBe('success')
  })

  it('an ordinary cancel (a newer push) still posts, so the same content can pass later', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, NO_RESULT) // concurrency cancel: post runs under always() with no result
    expect(repo.latest('h1')).toMatchObject({ state: 'failure', description: expect.stringMatching(/^error:/) })
    repo.push('h2', 't1')
    await run(repo, 'h2', 2, 1, APPROVED)
    expect(repo.latest('h2')?.state).toBe('success')
  })

  it('a new change (different tree) after a withheld verdict is reviewed normally', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, 'force-cancelled')
    repo.push('h2', 't2')
    await run(repo, 'h2', 2, 1, APPROVED)
    expect(repo.latest('h2')?.state).toBe('success')
  })

  it('a rebase (force-push of new content) is reviewed normally', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    await run(repo, 'h1', 1, 1, BLOCKED)
    repo.forcePush('h2', 't2')
    await run(repo, 'h2', 2, 1, APPROVED)
    expect(repo.latest('h2')?.state).toBe('success')
  })

  it('a pending marker posted with a PAT is ignored (no denial of service by forgery)', async () => {
    const repo = fakeRepo()
    repo.push('h1', 't1')
    repo.post('h1', { context: CONTEXT, state: 'pending', description: 'started: review in progress', target_url: 'x' }, 'AIteamOS-bot')
    await run(repo, 'h1', 1, 1, APPROVED)
    expect(repo.latest('h1')?.state).toBe('success')
  })
})
