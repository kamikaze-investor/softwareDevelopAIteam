/**
 * Design materiality の offline 評価（M5）。CI からは呼ばれず、判定にも影響しない。
 *
 * production の検出部品（apps/worker/src/metaReviewer/designMateriality.ts）をそのまま使い、
 * 再実装しない。provider は CI の Meta Review と同じ Gemini REST API（`callGeminiForReview`）。
 * GEMINI_API_KEY は実行者が環境変数で渡す（この script は .env を読まない）。
 *
 * subcommands（`tsx apps/worker/scripts/designMaterialityEval.ts <cmd> --out <dir> ...`）:
 *   frame   --repo <path> --head <sha> [--count 300] [--sample 80] [--seed 20261023]
 *           最後の N 本の first-parent commit を S1–S4 で F（fired・全数）/ N（none・無作為抽出）に分け、
 *           重み（F=1, N=|N|/n）付きの評価対象を frame.json に書く
 *   pack    --repo <path>   label 用 packet（diff・base 記録抜粋。detector の出力は含めない）を labels-input.jsonl に書く
 *   mutants --repo <path>   e405c7c7^ に対する mutant diff を mutants.json に書く
 *   detect  --repo <path> [--repeats 3]   frame の全件 + known positives + mutants を検出し results.jsonl に追記する
 *   score   --labels <labels.json>        重み付き recall / precision / routine flag rate（bootstrap 95% CI）と再現性を report.json に書く
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  computeMaterialitySignals,
  DESIGN_MATERIALITY_SCHEMA_VERSION,
  DESIGN_RECORD_ROOTS,
  excerptTokens,
  extractBaseRecordExcerpts,
  observeDesignMateriality,
  type BaseRecordReader,
  type MaterialityObservation,
  type MaterialitySignalKind,
  type ReviewProvider,
} from '../src/metaReviewer/designMateriality.js'

export const EVAL_SCRIPT_VERSION = 1
const DEFAULT_SEED = 20261023
const KNOWN_POSITIVES: ReadonlyArray<{ sha: string; target: EvalTarget }> = [
  { sha: 'e405c7c7', target: { file: 'apps/api/src/pl/conflictResolutionStep.ts', mechanismKeywords: ['challenge'] } },
  { sha: 'feb4dffc', target: { file: 'apps/api/src/pl/conflictResolutionStep.ts', mechanismKeywords: ['challenge', 'remediation', 'critic'] } },
  { sha: '516ca1ec', target: { file: 'packages/shared/src/criticalDesignFacts.ts', mechanismKeywords: ['critical', 'facts', 'rechallenge'] } },
  { sha: '5c08ec9f', target: { file: '', mechanismKeywords: ['re-review', 'rereview', 'same-hash', 'challenge'] } },
]

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
}

/** base ref の設計記録を `git show` で読む reader（作業ツリーは読まない） */
export function gitRecordReader(repo: string, ref: string): BaseRecordReader {
  return {
    listRecordFiles: () => git(repo, ['ls-tree', '-r', '--name-only', ref, '--', ...DESIGN_RECORD_ROOTS])
      .split('\n')
      .filter((f) => f.endsWith('.md')),
    read: (file) => {
      try { return git(repo, ['show', `${ref}:${file}`]) } catch { return undefined }
    },
  }
}

/** first parent との diff（merge commit も first parent 基準。CI の三点 diff と同じく head 側の追加分だけを見る） */
function commitDiff(repo: string, sha: string): string {
  return git(repo, ['diff', '--no-color', `${sha}^1`, sha])
}

// ---------------------------------------------------------------------------
// seeded RNG / sampling
// ---------------------------------------------------------------------------

/** mulberry32。seed が同じなら同じ抽出になる */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sampleWithoutReplacement<T>(items: readonly T[], n: number, seed: number): T[] {
  const rand = seededRandom(seed)
  const pool = items.slice()
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.min(n, pool.length))
}

export interface FrameItem {
  sha: string
  subject: string
  stratum: 'F' | 'N'
  weight: number
  signalKinds: MaterialitySignalKind[]
}

export interface Frame {
  schemaVersion: number
  evalScriptVersion: number
  repoHead: string
  count: number
  seed: number
  fired: number
  none: number
  sampledNone: number
  items: FrameItem[]
}

export function buildFrame(
  commits: ReadonlyArray<{ sha: string; subject: string; signalKinds: MaterialitySignalKind[] }>,
  opts: { head: string; sample: number; seed: number },
): Frame {
  const fired = commits.filter((c) => c.signalKinds.length > 0)
  const none = commits.filter((c) => c.signalKinds.length === 0)
  const sampled = sampleWithoutReplacement(none, opts.sample, opts.seed)
  const weight = sampled.length === 0 ? 0 : none.length / sampled.length
  return {
    schemaVersion: DESIGN_MATERIALITY_SCHEMA_VERSION,
    evalScriptVersion: EVAL_SCRIPT_VERSION,
    repoHead: opts.head,
    count: commits.length,
    seed: opts.seed,
    fired: fired.length,
    none: none.length,
    sampledNone: sampled.length,
    items: [
      ...fired.map((c) => ({ ...c, stratum: 'F' as const, weight: 1 })),
      ...sampled.map((c) => ({ ...c, stratum: 'N' as const, weight })),
    ],
  }
}

// ---------------------------------------------------------------------------
// mutants（e405c7c7^ に対する合成 diff）
// ---------------------------------------------------------------------------

export interface EvalTarget {
  /** 空文字なら file を問わない */
  file: string
  mechanismKeywords: string[]
}

export interface Mutant {
  id: string
  description: string
  /** detection が候補を出すべきか */
  expectCandidate: boolean
  /** 候補を出すべき mutant だけが持つ */
  target?: EvalTarget
  /** correctness に期待する責務判定（rename-only なら preserved） */
  expectResponsibility?: 'preserved' | 'lost'
  base: string
  diff: string
}

const CRS = 'apps/api/src/pl/conflictResolutionStep.ts'
const CHALLENGE_TARGET: EvalTarget = { file: CRS, mechanismKeywords: ['challenge'] }

interface FileEdit { file: string; after: string | null }

/** before / after の内容から unified diff を作る（`git diff --no-index`）。after=null は file 削除 */
export function diffFromEdits(repo: string, base: string, edits: readonly FileEdit[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'materiality-'))
  try {
    const parts: string[] = []
    for (const edit of edits) {
      let before = ''
      try { before = git(repo, ['show', `${base}:${edit.file}`]) } catch { before = '' }
      if (edit.after === null) {
        const lines = before.replace(/\n$/, '').split('\n')
        parts.push([
          `diff --git a/${edit.file} b/${edit.file}`, 'deleted file mode 100644', `--- a/${edit.file}`, '+++ /dev/null',
          `@@ -1,${lines.length} +0,0 @@`, ...lines.map((l) => `-${l}`),
        ].join('\n'))
        continue
      }
      const a = path.join(dir, 'a', edit.file)
      const b = path.join(dir, 'b', edit.file)
      mkdirSync(path.dirname(a), { recursive: true })
      mkdirSync(path.dirname(b), { recursive: true })
      writeFileSync(a, before)
      writeFileSync(b, edit.after)
      let out = ''
      try {
        out = execFileSync('git', ['diff', '--no-index', '--no-color', `a/${edit.file}`, `b/${edit.file}`], { cwd: dir, encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (err) {
        // --no-index は差分があると exit 1
        out = (err as { stdout?: string }).stdout ?? ''
      }
      parts.push(out.replaceAll(`a/a/${edit.file}`, `a/${edit.file}`).replaceAll(`b/b/${edit.file}`, `b/${edit.file}`).trimEnd())
    }
    return `${parts.join('\n')}\n`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function mustReplace(text: string, from: string | RegExp, to: string): string {
  const next = text.replace(from, to)
  if (next === text) throw new Error(`mutant anchor not found: ${String(from).slice(0, 80)}`)
  return next
}

export function buildMutants(repo: string, base = 'e405c7c7^'): Mutant[] {
  const show = (file: string) => git(repo, ['show', `${base}:${file}`])
  const crs = show(CRS)
  const loop = show('apps/api/src/pl/executionLoop.ts')
  const crsTest = show('apps/api/src/pl/conflictResolutionStep.test.ts')
  const roadmap = show('tasks/roadmap.md')
  const dispatch = /  const target = challengeTarget\([\s\S]*?\n  }\n\n  return \{ \.\.\.\(await runPlRevision/
  const removedDispatch = mustReplace(crs, dispatch, '  return { ...(await runPlRevision')
  const m = (id: string, description: string, edits: FileEdit[], rest: Omit<Mutant, 'id' | 'description' | 'base' | 'diff'>): Mutant =>
    ({ id, description, base, diff: diffFromEdits(repo, base, edits), ...rest })
  const positive = { expectCandidate: true, target: CHALLENGE_TARGET, expectResponsibility: 'lost' as const }

  const filler = Array.from({ length: 2500 }, (_, i) => `export const GENERATED_FIXTURE_${i} = '${'x'.repeat(40)}'`).join('\n')

  return [
    m('m01-dispatch-deleted', 'Challenge への分岐だけを削除', [{ file: CRS, after: removedDispatch }], positive),
    m('m02-early-return', 'early return で Challenge を到達不能にする', [{
      file: CRS,
      after: mustReplace(crs, '  // **challenge は固定 stage ではない。** ここだけが入口である。\n',
        '  // **challenge は固定 stage ではない。** ここだけが入口である。\n  return { ...(await runPlRevision(storage, subject, ledgerBody, critique, deps)), ...withCritic }\n'),
    }], positive),
    m('m03-handler-remap', 'Challenge の呼び出しを PL revision へ付け替える', [{
      file: CRS,
      after: mustReplace(crs, 'const challenge = await runChallenge(storage, subject, dispute, deps)',
        'const challenge = await runPlRevision(storage, subject, ledgerBody, critique, deps)'),
    }], positive),
    m('m04a-writer-noop', 'literal は残したまま Job 作成（release）を無効にする', [{
      file: CRS,
      after: mustReplace(crs, /const job = await ensureJob\(storage, taskId, [^\n]*\n/,
        "const job = { status: 'skipped' as const, reason: 'challenge release disabled' }\n"),
    }], positive),
    m('m04b-consumer-noop', 'literal は残したまま loop が challenge_aligned を resolved と扱わなくする', [{
      file: 'apps/api/src/pl/executionLoop.ts',
      after: mustReplace(loop, "\n    || status === 'challenge_aligned'", ''),
    }], { ...positive, target: { file: 'apps/api/src/pl/executionLoop.ts', mechanismKeywords: ['challenge'] } }),
    m('m05-file-deleted', 'Challenge の dispute 判定を持つ policy file を削除', [{
      file: 'packages/shared/src/independentCriticPolicy.ts', after: null,
    }], { ...positive, target: { file: 'packages/shared/src/independentCriticPolicy.ts', mechanismKeywords: ['critic', 'challenge', 'dispute'] } }),
    m('m06-token-cancel', 'union から消した literal を同じ file の別構文へ足し、release を止める', [{
      file: CRS,
      after: mustReplace(
        mustReplace(crs, "  /** frozen spec の再評価が ALIGNED evidence を生み、既存 Gate が Job を作った。 */\n  | 'challenge_aligned'\n", ''),
        "status: released ? 'challenge_aligned' : 'challenge_not_aligned',",
        "status: 'challenge_not_aligned', // legacy audit readers still see 'challenge_aligned'",
      ),
    }], positive),
    m('m07-config-flip', 'Critic round の上限 2 → 0（Critic と、その先の Challenge が走らなくなる）', [{
      file: CRS, after: mustReplace(crs, 'export const PL_MAX_CRITIC_ROUNDS = 2', 'export const PL_MAX_CRITIC_ROUNDS = 0'),
    }], { ...positive, target: { file: CRS, mechanismKeywords: ['critic'] } }),
    m('m08-late-hunk', '大きな生成 file の後ろに Challenge 分岐の削除を置く', [
      { file: 'apps/api/src/generated/fixtures.ts', after: `${filler}\n` },
      { file: CRS, after: removedDispatch },
    ], positive),
    m('m09-unrelated-record-touch', 'Challenge 分岐の削除と、無関係な roadmap 行の追加', [
      { file: CRS, after: removedDispatch },
      { file: 'tasks/roadmap.md', after: roadmap.replace(/\r?\n$/, '') + '\r\n- [x] unrelated budget-accounting cleanup\r\n' },
    ], positive),
    m('m10-rename-only', 'runChallenge を runChallengeStage へ改名するだけ', [{
      file: CRS, after: crs.replaceAll('runChallenge(', 'runChallengeStage('),
    }], { expectCandidate: true, target: CHALLENGE_TARGET, expectResponsibility: 'preserved' }),
    m('m11-test-only', 'test を1本足すだけ', [{
      file: 'apps/api/src/pl/conflictResolutionStep.test.ts',
      after: `${crsTest.replace(/\n$/, '')}\n\ndescribe('extra', () => {\n  it('selectConflictStage は taskId が無ければ critic を返す', () => {\n    expect(true).toBe(true)\n  })\n})\n`,
    }], { expectCandidate: false }),
    m('m12-comment-wording', 'コメントの言い回しだけを変える', [{
      file: CRS, after: mustReplace(crs, 'ここだけが入口である。', '入口はここ1箇所だけである。'),
    }], { expectCandidate: false }),
  ]
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

export interface DetectionRecord {
  itemId: string
  kind: 'frame' | 'positive' | 'mutant'
  run: number
  model: string
  observation: MaterialityObservation
}

function readInstructions(repoRoot: string): { detection: string; evaluation: string } {
  return {
    detection: readFileSync(path.join(repoRoot, 'docs/meta_reviewer/design_materiality_detection.md'), 'utf-8'),
    evaluation: readFileSync(path.join(repoRoot, 'docs/meta_reviewer/design_materiality_evaluation.md'), 'utf-8'),
  }
}

// ---------------------------------------------------------------------------
// score
// ---------------------------------------------------------------------------

export interface Label {
  sha: string
  material: boolean
}

export type RunState = 'target_detected' | 'not_detected' | 'candidates_present' | 'no_candidates' | 'unavailable'

/** v3.1 の run state。target を持つ item は target 一致で、持たない item は候補の有無で決める */
export function runState(observation: MaterialityObservation, target: EvalTarget | undefined): RunState {
  if (observation.status !== 'ok' && observation.detection === undefined) return 'unavailable'
  const candidates = observation.detection?.candidates ?? []
  if (target === undefined) return candidates.length > 0 ? 'candidates_present' : 'no_candidates'
  const hit = candidates.some((c) => (target.file === '' || c.file === target.file)
    && target.mechanismKeywords.some((k) => `${c.mechanism} ${c.evidence}`.toLowerCase().includes(k.toLowerCase())))
  return hit ? 'target_detected' : 'not_detected'
}

export interface WeightedPoint { weight: number; stratum: 'F' | 'N'; predicted: boolean; actual: boolean }

export function weightedRates(points: readonly WeightedPoint[]): { recall: number | null; precision: number | null; routineFlagRate: number | null } {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0
  for (const p of points) {
    if (p.predicted && p.actual) tp += p.weight
    else if (p.predicted) fp += p.weight
    else if (p.actual) fn += p.weight
    else tn += p.weight
  }
  const ratio = (a: number, b: number) => (b === 0 ? null : a / b)
  return { recall: ratio(tp, tp + fn), precision: ratio(tp, tp + fp), routineFlagRate: ratio(fp, fp + tn) }
}

/** F と N を別々に復元抽出する層別 bootstrap。95% percentile CI */
export function stratifiedBootstrap(
  points: readonly WeightedPoint[],
  metric: (ps: readonly WeightedPoint[]) => number | null,
  resamples = 2000,
  seed = DEFAULT_SEED,
): [number, number] | null {
  const rand = seededRandom(seed)
  const strata = (['F', 'N'] as const).map((s) => points.filter((p) => p.stratum === s))
  const values: number[] = []
  for (let r = 0; r < resamples; r++) {
    const sample = strata.flatMap((group) => group.map(() => group[Math.floor(rand() * group.length)]))
    const v = metric(sample)
    if (v !== null) values.push(v)
  }
  if (values.length === 0) return null
  values.sort((a, b) => a - b)
  return [values[Math.floor(0.025 * (values.length - 1))], values[Math.floor(0.975 * (values.length - 1))]]
}

type Predictor = (observation: MaterialityObservation, kinds: readonly MaterialitySignalKind[]) => boolean

const PREDICTORS: Record<string, Predictor> = {
  S1: (_o, k) => k.includes('contract_member_removed'),
  S2: (_o, k) => k.includes('provenance_comment_removed'),
  S3: (_o, k) => k.includes('source_file_deleted'),
  S4: (_o, k) => k.includes('behavior_test_removed'),
  anySignal: (_o, k) => k.length > 0,
  // unavailable は「未検出」として数える（落とさない）
  llm: (o) => o.status === 'ok' && (o.detection?.material ?? false),
  llmOrSignal: (o, k) => k.length > 0 || (o.status === 'ok' && (o.detection?.material ?? false)),
}

export function scoreFrame(frame: Frame, labels: readonly Label[], records: readonly DetectionRecord[]) {
  const label = new Map(labels.map((l) => [l.sha, l.material]))
  const firstRun = new Map(records.filter((r) => r.kind === 'frame' && r.run === 0).map((r) => [r.itemId, r.observation]))
  const unlabeled = frame.items.filter((i) => !label.has(i.sha)).map((i) => i.sha)
  const missingRun = frame.items.filter((i) => !firstRun.has(i.sha)).map((i) => i.sha)
  const scored = frame.items.filter((i) => label.has(i.sha) && firstRun.has(i.sha))
  const unavailable = scored.filter((i) => firstRun.get(i.sha)?.status !== 'ok').length
  const metrics: Record<string, unknown> = {}
  for (const [name, predict] of Object.entries(PREDICTORS)) {
    const points = scored.map((i) => ({
      weight: i.weight, stratum: i.stratum, actual: label.get(i.sha) as boolean,
      predicted: predict(firstRun.get(i.sha) as MaterialityObservation, i.signalKinds),
    }))
    const rates = weightedRates(points)
    metrics[name] = {
      ...rates,
      recallCI: stratifiedBootstrap(points, (ps) => weightedRates(ps).recall),
      precisionCI: stratifiedBootstrap(points, (ps) => weightedRates(ps).precision),
      routineFlagRateCI: stratifiedBootstrap(points, (ps) => weightedRates(ps).routineFlagRate),
    }
  }
  return { scored: scored.length, unlabeled, missingRun, unavailableRate: scored.length === 0 ? null : unavailable / scored.length, metrics }
}

export function scoreRepeatability(
  items: ReadonlyArray<{ itemId: string; target?: EvalTarget; expectCandidate?: boolean; expectResponsibility?: string }>,
  records: readonly DetectionRecord[],
) {
  const out = items.map((item) => {
    const runs = records.filter((r) => r.itemId === item.itemId)
    const states = runs.map((r) => runState(r.observation, item.target))
    const responsibilities = runs
      .filter((r, i) => states[i] === 'target_detected')
      .map((r) => {
        const target = item.target as EvalTarget
        const candidate = r.observation.detection?.candidates.find((c) => (target.file === '' || c.file === target.file)
          && target.mechanismKeywords.some((k) => `${c.mechanism} ${c.evidence}`.toLowerCase().includes(k.toLowerCase())))
        return r.observation.evaluations?.find((e) => e.candidateId === candidate?.id)?.responsibility ?? 'missing'
      })
    return {
      itemId: item.itemId,
      runs: runs.length,
      states,
      flipped: new Set(states).size > 1,
      targetHitRate: item.target ? states.filter((s) => s === 'target_detected').length / Math.max(1, runs.length) : null,
      expectCandidate: item.expectCandidate ?? null,
      responsibilities,
      responsibilityStable: responsibilities.length < 2 ? 'insufficient' : new Set(responsibilities).size === 1,
      expectResponsibility: item.expectResponsibility ?? null,
    }
  })
  return { items: out, flipRate: out.length === 0 ? null : out.filter((o) => o.flipped).length / out.length }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function args(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? ''
  return out
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const a = args(rest)
  const out = a.out ?? path.resolve('materiality-eval')
  mkdirSync(out, { recursive: true })
  const repo = a.repo ?? process.cwd()
  const file = (name: string) => path.join(out, name)

  if (cmd === 'frame') {
    const head = a.head ?? git(repo, ['rev-parse', 'HEAD']).trim()
    const shas = git(repo, ['rev-list', '--first-parent', `--max-count=${a.count ?? '300'}`, head]).split('\n').filter(Boolean)
    const commits = shas.map((sha) => ({
      sha,
      subject: git(repo, ['log', '-1', '--format=%s', sha]).trim(),
      signalKinds: [...new Set(computeMaterialitySignals(commitDiff(repo, sha)).map((s) => s.kind))],
    }))
    const frame = buildFrame(commits, { head, sample: Number(a.sample ?? 80), seed: Number(a.seed ?? DEFAULT_SEED) })
    writeFileSync(file('frame.json'), JSON.stringify(frame, null, 2))
    console.log(`frame: ${frame.count} commits, F=${frame.fired}, N=${frame.none} (sampled ${frame.sampledNone})`)
    return
  }

  if (cmd === 'pack') {
    const frame = JSON.parse(readFileSync(file('frame.json'), 'utf-8')) as Frame
    const lines = frame.items.map((item) => {
      const diff = commitDiff(repo, item.sha)
      const signals = computeMaterialitySignals(diff)
      const excerpts = extractBaseRecordExcerpts(gitRecordReader(repo, `${item.sha}^1`), excerptTokens(diff, signals))
      return JSON.stringify({ sha: item.sha, subject: item.subject, diff, excerpts })
    })
    writeFileSync(file('labels-input.jsonl'), `${lines.join('\n')}\n`)
    console.log(`pack: ${lines.length} packets`)
    return
  }

  if (cmd === 'mutants') {
    writeFileSync(file('mutants.json'), JSON.stringify(buildMutants(repo), null, 2))
    console.log('mutants written')
    return
  }

  if (cmd === 'detect') {
    const { callGeminiForReview } = await import('../src/metaReviewer/geminiClient.js')
    const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash'
    const provider: ReviewProvider = (prompt) => callGeminiForReview(prompt, model)
    const instructions = readInstructions(path.resolve(__dirname, '../../..'))
    const repeats = Number(a.repeats ?? '3')
    const frame = JSON.parse(readFileSync(file('frame.json'), 'utf-8')) as Frame
    const mutants = JSON.parse(readFileSync(file('mutants.json'), 'utf-8')) as Mutant[]
    const done = new Set(existsSync(file('results.jsonl'))
      ? readFileSync(file('results.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => {
        const r = JSON.parse(l) as DetectionRecord
        return `${r.kind}:${r.itemId}:${r.run}`
      })
      : [])
    const record = async (kind: DetectionRecord['kind'], itemId: string, run: number, title: string, diff: string, base: string) => {
      if (done.has(`${kind}:${itemId}:${run}`)) return
      const observation = await observeDesignMateriality({
        title, diff, records: gitRecordReader(repo, base),
        detectionInstructions: instructions.detection, evaluationInstructions: instructions.evaluation,
      }, provider)
      appendFileSync(file('results.jsonl'), `${JSON.stringify({ itemId, kind, run, model, observation } satisfies DetectionRecord)}\n`)
      console.log(`${kind} ${itemId} run=${run} ${observation.status}${observation.reason ? ` (${observation.reason})` : ''} material=${observation.detection?.material ?? '-'}`)
    }
    // frame は 1 回。repeat 対象は known positives・mutants・N の先頭 20 件（v3.1）
    for (const item of frame.items) await record('frame', item.sha, 0, item.subject, commitDiff(repo, item.sha), `${item.sha}^1`)
    const repeatNegatives = frame.items.filter((i) => i.stratum === 'N').slice(0, 20)
    for (let run = 0; run < repeats; run++) {
      for (const p of KNOWN_POSITIVES) await record('positive', p.sha, run, git(repo, ['log', '-1', '--format=%s', p.sha]).trim(), commitDiff(repo, p.sha), `${p.sha}^1`)
      for (const m of mutants) await record('mutant', m.id, run, m.description, m.diff, m.base)
      for (const n of repeatNegatives.slice(0, run === 0 ? 0 : 20)) await record('frame', n.sha, run, n.subject, commitDiff(repo, n.sha), `${n.sha}^1`)
    }
    return
  }

  if (cmd === 'score') {
    const frame = JSON.parse(readFileSync(file('frame.json'), 'utf-8')) as Frame
    const labels = JSON.parse(readFileSync(a.labels ?? file('labels.json'), 'utf-8')) as Label[]
    const mutants = JSON.parse(readFileSync(file('mutants.json'), 'utf-8')) as Mutant[]
    const records = readFileSync(file('results.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as DetectionRecord)
    const repeatNegatives = frame.items.filter((i) => i.stratum === 'N').slice(0, 20)
    const report = {
      schemaVersion: DESIGN_MATERIALITY_SCHEMA_VERSION,
      evalScriptVersion: EVAL_SCRIPT_VERSION,
      repoHead: frame.repoHead,
      models: [...new Set(records.map((r) => r.model))],
      detectionPromptHashes: [...new Set(records.map((r) => r.observation.detectionPromptHash).filter(Boolean))].length,
      historical: scoreFrame(frame, labels, records),
      repeatability: {
        positives: scoreRepeatability(KNOWN_POSITIVES.map((p) => ({ itemId: p.sha, target: p.target, expectCandidate: true })), records.filter((r) => r.kind === 'positive')),
        mutants: scoreRepeatability(mutants.map((m) => ({ itemId: m.id, target: m.target, expectCandidate: m.expectCandidate, expectResponsibility: m.expectResponsibility })), records.filter((r) => r.kind === 'mutant')),
        negatives: scoreRepeatability(repeatNegatives.map((n) => ({ itemId: n.sha })), records.filter((r) => r.kind === 'frame' && repeatNegatives.some((n) => n.sha === r.itemId))),
      },
    }
    writeFileSync(file('report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report.historical.metrics, null, 2))
    return
  }

  console.error('usage: designMaterialityEval.ts <frame|pack|mutants|detect|score> --out <dir> [--repo <path>] ...')
  process.exit(1)
}

if (process.argv[1] !== undefined && /designMaterialityEval\.ts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
