// Cross-Task Drift Audit CLI. Read-only against git; writes only the files named by --out.
//
//   due       [--base <sha>] [--head <ref>] [--deployed <sha>]
//   packet    --out <file> [--base <sha>] [--head <ref>] [--deployed <sha>] [--production <file>] [--budget <chars>]
//   findings  <response.json> --base <sha> [--head <ref>]
//
// Without --base, the window starts at the head of the latest valid
// docs/project_memory/decisions/cross_task_audit_*.md record. Nothing here calls an AI provider:
// the PL hands `packet` output to the Design Challenger (AGENTS.md 3-2) and validates the answer
// with `findings`. No exit code here is a Gate.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildPacket,
  collectAddedFacts,
  domainLiteralsIn,
  evaluateDue,
  findFixChains,
  parseAuditMarkers,
  parseChallengerResponse,
  parseCodeownersPatterns,
  rankChurn,
  routeFindings,
  validateAuditChain,
  windowChanges,
  type AddedLine,
  type AuditRecord,
  type WindowCommit,
} from './crossTaskAudit.js'

const BASELINE_COMMITS = 300
const DEFAULT_BUDGET_CHARS = 150_000
const DECISIONS_DIR = 'docs/project_memory/decisions'

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
}

function readCommits(repo: string, rangeArgs: string[]): WindowCommit[] {
  const out = git(repo, ['log', '--first-parent', '--diff-merges=first-parent', '--name-only', '--format=%x1e%H%x1f%s%x1f%b%x1f', ...rangeArgs])
  return out
    .split('\x1e')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [sha, subject, body, files] = chunk.split('\x1f')
      return { sha: sha!.trim(), subject: subject!.trim(), body: body!.trim(), files: files!.split('\n').map((f) => f.trim()).filter(Boolean) }
    })
}

function readAddedLines(repo: string, base: string, head: string): AddedLine[] {
  const out = git(repo, ['log', '--first-parent', '--diff-merges=first-parent', '-p', '--unified=0', '--format=%x1e%H', `${base}..${head}`])
  const lines: AddedLine[] = []
  for (const chunk of out.split('\x1e')) {
    const [sha, ...rest] = chunk.split('\n')
    let file = ''
    for (const line of rest) {
      if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''
      else if (line.startsWith('+') && file) lines.push({ sha: sha!.trim(), file, text: line.slice(1) })
    }
  }
  return lines
}

function literalsPresentAt(repo: string, ref: string, literals: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (let i = 0; i < literals.length; i += 200) {
    const batch = literals.slice(i, i + 200)
    try {
      const out = git(repo, ['grep', '-o', '-h', '-F', ...batch.flatMap((l) => ['-e', l]), ref, '--', 'apps', 'packages'])
      for (const line of out.split('\n')) if (line) found.add(line.replace(/^[^:]*:/, '').trim())
    } catch {
      // git grep exits 1 when nothing matches.
    }
  }
  return found
}

function readAuditRecords(repo: string, ref: string): AuditRecord[] {
  const names = git(repo, ['ls-tree', '--name-only', `${ref}:${DECISIONS_DIR}`]).split('\n').filter((n) => /^cross_task_audit_.+\.md$/.test(n))
  return names.flatMap((n) => {
    const p = `${DECISIONS_DIR}/${n}`
    return parseAuditMarkers(git(repo, ['show', `${ref}:${p}`])).map((marker) => ({ path: p, marker }))
  })
}

interface Args {
  command: string
  positional: string[]
  options: Map<string, string>
}

export function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...rest] = argv
  const positional: string[] = []
  const options = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith('--')) {
      const v = rest[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`)
      options.set(a.slice(2), v)
      i++
    } else positional.push(a)
  }
  return { command, positional, options }
}

function resolveWindow(repo: string, args: Args) {
  const head = git(repo, ['rev-parse', args.options.get('head') ?? 'HEAD']).trim()
  const firstParent = new Set(git(repo, ['rev-list', '--first-parent', head]).split('\n').filter(Boolean))
  const chain = validateAuditChain(readAuditRecords(repo, head), (sha) => firstParent.has(sha))
  const explicitBase = args.options.get('base')
  const base = explicitBase ? git(repo, ['rev-parse', explicitBase]).trim() : chain.latestHead
  if (!base) {
    throw new Error(
      chain.issues.length
        ? `audit record chain is not trustworthy; pass --base explicitly:\n- ${chain.issues.join('\n- ')}`
        : 'no cross_task_audit record yet; pass --base <sha> for the first window',
    )
  }
  if (!firstParent.has(base)) throw new Error(`base ${base} is not on the first-parent history of ${head}`)
  const all = readCommits(repo, [`${base}..${head}`])
  const changes = windowChanges(all)
  const baseline = readCommits(repo, ['-n', String(BASELINE_COMMITS), base])
  const codeowners = (() => {
    try {
      return git(repo, ['show', `${head}:.github/CODEOWNERS`])
    } catch {
      return ''
    }
  })()
  const authorityPatterns = parseCodeownersPatterns(codeowners)
  const fixChains = findFixChains(changes)
  const due = evaluateDue({ changes, deployedSha: args.options.get('deployed') ?? null, fixChains, authorityPatterns })
  return { base, head, chainIssues: chain.issues, changes, baseline, authorityPatterns, fixChains, due }
}

export function main(argv: readonly string[] = process.argv.slice(2), cwd = process.cwd()): void {
  const args = parseArgs(argv)
  // pnpm --filter runs scripts inside apps/worker; pathspecs below are repo-root relative.
  const repo = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  if (args.command === 'due') {
    const w = resolveWindow(repo, args)
    const churn = rankChurn(w.changes, w.baseline).slice(0, 15)
    process.stdout.write(
      `${JSON.stringify({ base: w.base, head: w.head, changes: w.changes.length, due: w.due, fixChains: w.fixChains, churnTop: churn, chainIssues: w.chainIssues }, null, 2)}\n`,
    )
    return
  }
  if (args.command === 'packet') {
    const out = args.options.get('out')
    if (!out) throw new Error('packet needs --out <file>')
    const w = resolveWindow(repo, args)
    const churn = rankChurn(w.changes, w.baseline)
    const lines = readAddedLines(repo, w.base, w.head)
    const candidates = [...new Set(lines.flatMap((l) => domainLiteralsIn(l.text)))]
    const atBase = literalsPresentAt(repo, w.base, candidates)
    const facts = collectAddedFacts(lines, (lit) => atBase.has(lit))
    const fileDiffs = churn.map((f) => ({ path: f.path, diff: git(repo, ['diff', w.base, w.head, '--', f.path]) }))
    const productionPath = args.options.get('production')
    const production = productionPath ? readFileSync(productionPath, 'utf8') : null
    const budgetChars = Number(args.options.get('budget') ?? DEFAULT_BUDGET_CHARS)
    const packet = buildPacket({ base: w.base, head: w.head, due: w.due, changes: w.changes, churn, fixChains: w.fixChains, facts, fileDiffs, production, budgetChars })
    const prompt = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'challengerPrompt.md'), 'utf8')
    writeFileSync(out, `${prompt}\n\n${packet.text}\n`)
    process.stdout.write(`${JSON.stringify({ out, due: w.due, included: packet.includedFiles.length, omitted: packet.omittedFiles }, null, 2)}\n`)
    return
  }
  if (args.command === 'findings') {
    const file = args.positional[0]
    if (!file) throw new Error('findings needs <response.json>')
    const w = resolveWindow(repo, args)
    const parsed = parseChallengerResponse(JSON.parse(readFileSync(file, 'utf8')))
    const routed = routeFindings(parsed.findings, w.authorityPatterns, `xta-${w.base.slice(0, 7)}`)
    process.stdout.write(`${JSON.stringify({ base: w.base, head: w.head, findings: routed, checkedClean: parsed.checkedClean, uncertainQuestions: parsed.uncertainQuestions }, null, 2)}\n`)
    return
  }
  throw new Error('usage: cross-task-audit <due | packet --out <file> | findings <response.json>> [--base <sha>] [--head <ref>] [--deployed <sha>]')
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

