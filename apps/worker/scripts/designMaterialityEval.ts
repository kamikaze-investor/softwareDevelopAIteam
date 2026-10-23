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
 *   plan    --repo <path>   API を呼ばずに、呼び出し件数と detection prompt の大きさを見積もる
 *   detect  --repo <path> [--min-interval-ms 20000] [--max-calls 60]
 *           frame の全件 + known positives + mutants を **逐次・間隔付き・上限付き**で検出し results.jsonl に追記する。
 *           quota / 課金 / 認証の失敗が1回でも出たら即停止する（retry しない）。API の失敗は errors.jsonl に別記録する。
 *           上限で止まったら同じ引数で再実行すれば、同じ入力の済み run を飛ばして続きから進む
 *   score   --labels <labels.json>        重み付き recall / precision / routine flag rate（bootstrap 95% CI）と再現性を report.json に書く
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildDetectionPrompt,
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

export const EVAL_SCRIPT_VERSION = 2
const DEFAULT_SEED = 20261023
/** v3.1: repeat は3回で固定（score 側の「ちょうど N 本」と同じ値を使う） */
const REPEATS = 3
const KNOWN_POSITIVES: ReadonlyArray<{ sha: string; target: EvalTarget }> = [
  { sha: 'e405c7c7', target: { files: ['apps/api/src/pl/conflictResolutionStep.ts'], mechanismKeywords: ['challenge'] } },
  { sha: 'feb4dffc', target: { files: ['apps/api/src/pl/conflictResolutionStep.ts', 'apps/api/src/pl/remediationStep.ts', 'packages/shared/src/independentRemediationPolicy.ts', 'packages/shared/src/independentCriticPolicy.ts'], mechanismKeywords: ['challenge', 'remediation', 'critic'] } },
  { sha: '516ca1ec', target: { files: ['packages/shared/src/criticalDesignFacts.ts'], mechanismKeywords: ['critical', 'facts', 'rechallenge'] } },
  { sha: '5c08ec9f', target: { files: ['apps/api/src/pl/challengeAnswer.ts', 'apps/api/src/pl/conflictResolutionStep.ts', 'apps/api/src/designReview/repairFlow.ts'], mechanismKeywords: ['challenge', 're-review', 'rereview', 'disagreement'] } },
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
  /** 候補の `file` がこのどれかと完全一致すること（wildcard は無い） */
  files: string[]
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
const CHALLENGE_TARGET: EvalTarget = { files: [CRS], mechanismKeywords: ['challenge'] }

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
    }], { ...positive, target: { files: ['apps/api/src/pl/executionLoop.ts'], mechanismKeywords: ['challenge'] } }),
    m('m05-file-deleted', 'Challenge の dispute 判定を持つ policy file を削除', [{
      file: 'packages/shared/src/independentCriticPolicy.ts', after: null,
    }], { ...positive, target: { files: ['packages/shared/src/independentCriticPolicy.ts'], mechanismKeywords: ['critic', 'challenge', 'dispute'] } }),
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
    }], { ...positive, target: { files: [CRS], mechanismKeywords: ['critic'] } }),
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
  /** prompt 本文の版（両 instructions の sha256 先頭12桁） */
  promptVersion: PromptVersion
  /** sha256(model | 両 prompt 本文 | title | diff | base)。同じ item の repeat が同じ入力かを確かめる */
  inputFingerprint: string
  /** cost: 待機時間と prompt の大きさ（detection + correctness） */
  latencyMs: number
  promptChars: number
  /** API の失敗。検出結果（observation）とは別に記録し、unavailable が API 側か応答の形かを後で分ける */
  apiErrors: ApiErrorRecord[]
  observation: MaterialityObservation
}

export interface PromptVersion { detection: string; evaluation: string }

export function promptVersion(instructions: { detection: string; evaluation: string }): PromptVersion {
  const h = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12)
  return { detection: h(instructions.detection), evaluation: h(instructions.evaluation) }
}

export type ApiErrorClass = 'quota' | 'auth' | 'transient' | 'other'

export interface ApiErrorRecord {
  stage: 'detection' | 'evaluation'
  errorClass: ApiErrorClass
  httpStatus: number | null
  /** sanitizeMessage 済み */
  message: string
}

/**
 * Gemini SDK のエラーメッセージ（`[GoogleGenerativeAI Error]: ... [429 Too Many Requests] ...`）を分類する。
 * quota（429 / 402 / RESOURCE_EXHAUSTED / quota / billing / credit）と auth（401 / 403 / API key）は**即停止**の対象。
 */
export function classifyApiError(message: string): { errorClass: ApiErrorClass; httpStatus: number | null } {
  const status = message.match(/\[(\d{3})\b/)?.[1] ?? message.match(/\b([45]\d\d)\b/)?.[1]
  const httpStatus = status === undefined ? null : Number(status)
  if (httpStatus === 429 || httpStatus === 402 || /RESOURCE_EXHAUSTED|quota|billing|credit/i.test(message)) return { errorClass: 'quota', httpStatus }
  if (httpStatus === 401 || httpStatus === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED|GEMINI_API_KEY/i.test(message)) return { errorClass: 'auth', httpStatus }
  if ((httpStatus !== null && httpStatus >= 500) || /timeout|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(message)) return { errorClass: 'transient', httpStatus }
  return { errorClass: 'other', httpStatus }
}

export interface WorkItem {
  kind: DetectionRecord['kind']
  itemId: string
  run: number
  title: string
  diff: string
  base: string
}

/**
 * 呼び出し順に並べた評価対象。frame は 1 回、repeat 対象は known positives・mutants・N の先頭 20 件（v3.1）。
 * plan（API を呼ばない見積もり）と detect が同じ一覧を使う。
 */
export function buildWorkList(repo: string, frame: Frame, mutants: readonly Mutant[]): WorkItem[] {
  const work: WorkItem[] = []
  const commit = (kind: WorkItem['kind'], sha: string, run: number, title: string): WorkItem =>
    ({ kind, itemId: sha, run, title, diff: commitDiff(repo, sha), base: `${sha}^1` })
  for (const item of frame.items) work.push(commit('frame', item.sha, 0, item.subject))
  const repeatNegatives = frame.items.filter((i) => i.stratum === 'N').slice(0, 20)
  for (let run = 0; run < REPEATS; run++) {
    for (const p of KNOWN_POSITIVES) work.push(commit('positive', p.sha, run, git(repo, ['log', '-1', '--format=%s', p.sha]).trim()))
    for (const m of mutants) work.push({ kind: 'mutant', itemId: m.id, run, title: m.description, diff: m.diff, base: m.base })
    if (run > 0) for (const n of repeatNegatives) work.push(commit('frame', n.sha, run, n.subject))
  }
  return work
}

export function inputFingerprint(parts: { model: string; detection: string; evaluation: string; title: string; diff: string; base: string }): string {
  return createHash('sha256')
    .update([parts.model, parts.detection, parts.evaluation, parts.title, parts.diff, parts.base].join('\u0000'))
    .digest('hex')
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
  /** material のうち、既存のものに触れず新しいものを足すだけ（`introduces` のみ）の commit */
  introducesOnly?: boolean
}

export type RunState = 'target_detected' | 'not_detected' | 'candidates_present' | 'no_candidates' | 'unavailable'

/** v3.1 の run state。target を持つ item は target 一致で、持たない item は候補の有無で決める */
export function runState(observation: MaterialityObservation, target: EvalTarget | undefined): RunState {
  if (observation.status !== 'ok' && observation.detection === undefined) return 'unavailable'
  const candidates = observation.detection?.candidates ?? []
  if (target === undefined) return candidates.length > 0 ? 'candidates_present' : 'no_candidates'
  return matchTarget(observation, target) ? 'target_detected' : 'not_detected'
}

/** target に一致する候補。file は完全一致（wildcard は持たない）、mechanism / evidence は keyword の部分一致 */
export function matchTarget(observation: MaterialityObservation, target: EvalTarget) {
  return observation.detection?.candidates.find((c) => target.files.includes(c.file)
    && target.mechanismKeywords.some((k) => `${c.mechanism} ${c.evidence}`.toLowerCase().includes(k.toLowerCase())))
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

/**
 * 正解の切り方:
 * - `all`: material 全部を正例にする
 * - `primary`: 既存のものを消す・替える・意味を変える commit だけを正例にする（`introducesOnly` は対象外として除く）
 * - `introduces`: `introducesOnly` の commit だけで recall を出す（追加型の設計判断の検出率）
 */
export function scoreFrame(frame: Frame, labels: readonly Label[], records: readonly DetectionRecord[]) {
  const label = new Map(labels.map((l) => [l.sha, l]))
  const frameRuns = records.filter((r) => r.kind === 'frame' && r.run === 0)
  // 同じ commit の run 0 が別入力で2本以上あるなら、どちらを採るかで結果が変わる。集計から外して報告する
  const mixed = new Set(frameRuns.filter((r) => frameRuns.some((o) => o.itemId === r.itemId && o.inputFingerprint !== r.inputFingerprint)).map((r) => r.itemId))
  const firstRun = new Map(frameRuns.filter((r) => !mixed.has(r.itemId)).map((r) => [r.itemId, r.observation]))
  const unlabeled = frame.items.filter((i) => !label.has(i.sha)).map((i) => i.sha)
  const missingRun = frame.items.filter((i) => !firstRun.has(i.sha)).map((i) => i.sha)
  const scored = frame.items.filter((i) => label.has(i.sha) && firstRun.has(i.sha))
  // 抽出重みで母集団へ戻した unavailable 率（N の1件は |N|/n 件を代表する）
  const totalWeight = scored.reduce((n, i) => n + i.weight, 0)
  const unavailableWeight = scored.filter((i) => firstRun.get(i.sha)?.status !== 'ok').reduce((n, i) => n + i.weight, 0)

  const views: Record<string, { include: (l: Label) => boolean; actual: (l: Label) => boolean }> = {
    all: { include: () => true, actual: (l) => l.material },
    primary: { include: (l) => !(l.material && l.introducesOnly === true), actual: (l) => l.material },
    introduces: { include: (l) => l.material && l.introducesOnly === true, actual: () => true },
  }
  const metrics: Record<string, Record<string, unknown>> = {}
  for (const [view, { include, actual }] of Object.entries(views)) {
    metrics[view] = {}
    for (const [name, predict] of Object.entries(PREDICTORS)) {
      const points = scored
        .filter((i) => include(label.get(i.sha) as Label))
        .map((i) => ({
          weight: i.weight, stratum: i.stratum, actual: actual(label.get(i.sha) as Label),
          predicted: predict(firstRun.get(i.sha) as MaterialityObservation, i.signalKinds),
        }))
      metrics[view][name] = {
        n: points.length,
        ...weightedRates(points),
        recallCI: stratifiedBootstrap(points, (ps) => weightedRates(ps).recall),
        precisionCI: stratifiedBootstrap(points, (ps) => weightedRates(ps).precision),
        routineFlagRateCI: stratifiedBootstrap(points, (ps) => weightedRates(ps).routineFlagRate),
      }
    }
  }
  return {
    scored: scored.length,
    unlabeled,
    missingRun,
    mixedInputs: [...mixed],
    unavailableRate: totalWeight === 0 ? null : unavailableWeight / totalWeight,
    metrics,
  }
}

export interface RepeatItem {
  itemId: string
  target?: EvalTarget
  expectCandidate?: boolean
  expectResponsibility?: string
}

/**
 * v3.1 の再現性。
 * - 同じ item の run は **同じ入力**（`inputFingerprint`）で、ちょうど `expectedRuns` 本でなければ `invalid` として集計から外す
 * - flip は run state（unavailable を含む）が揃わないこと。同じ見逃しが続くのは flip ではなく hit rate に出る
 * - correctness の安定性は、target を検出し **かつ評価が得られた** run だけで比べる。評価の欠落は別に数える
 */
export function scoreRepeatability(items: readonly RepeatItem[], records: readonly DetectionRecord[], expectedRuns: number) {
  const out = items.map((item) => {
    const runs = records.filter((r) => r.itemId === item.itemId).sort((a, b) => a.run - b.run)
    const fingerprints = new Set(runs.map((r) => r.inputFingerprint))
    // run 番号はちょうど 0..expectedRuns-1 を1本ずつ（[0,0,1] は run 2 の欠落）
    const runIds = runs.map((r) => r.run).join(',')
    const expectedIds = Array.from({ length: expectedRuns }, (_, i) => i).join(',')
    const invalid = runIds !== expectedIds ? 'run_count' : fingerprints.size > 1 ? 'mixed_inputs' : null
    const states = runs.map((r) => runState(r.observation, item.target))
    const detected = item.target === undefined ? [] : runs.filter((_r, i) => states[i] === 'target_detected')
    const evaluated = detected.flatMap((r) => {
      const candidate = matchTarget(r.observation, item.target as EvalTarget)
      const evaluation = r.observation.evaluations?.find((e) => e.candidateId === candidate?.id)
      return evaluation ? [evaluation.responsibility] : []
    })
    return {
      itemId: item.itemId,
      invalid,
      runs: runs.length,
      states,
      flipped: new Set(states).size > 1,
      // detection の失敗（run state）と、correctness を含むどこかの失敗（observation.status）を分けて数える
      unavailableRuns: states.filter((s) => s === 'unavailable').length,
      anyUnavailableRuns: runs.filter((r) => r.observation.status !== 'ok').length,
      targetHitRate: item.target ? states.filter((s) => s === 'target_detected').length / Math.max(1, runs.length) : null,
      expectCandidate: item.expectCandidate ?? null,
      responsibilities: evaluated,
      evaluationMissing: detected.length - evaluated.length,
      responsibilityStable: evaluated.length < 2 ? 'insufficient' : new Set(evaluated).size === 1,
      expectResponsibility: item.expectResponsibility ?? null,
    }
  })
  const valid = out.filter((o) => o.invalid === null)
  const totalRuns = valid.reduce((n, o) => n + o.runs, 0)
  return {
    items: out,
    invalidItems: out.length - valid.length,
    flipRate: valid.length === 0 ? null : valid.filter((o) => o.flipped).length / valid.length,
    unavailableRunRate: totalRuns === 0 ? null : valid.reduce((n, o) => n + o.unavailableRuns, 0) / totalRuns,
    anyUnavailableRunRate: totalRuns === 0 ? null : valid.reduce((n, o) => n + o.anyUnavailableRuns, 0) / totalRuns,
  }
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

  if (cmd === 'plan' || cmd === 'detect') {
    const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash'
    const instructions = readInstructions(path.resolve(__dirname, '../../..'))
    const frame = JSON.parse(readFileSync(file('frame.json'), 'utf-8')) as Frame
    const mutants = JSON.parse(readFileSync(file('mutants.json'), 'utf-8')) as Mutant[]
    const work = buildWorkList(repo, frame, mutants)

    if (cmd === 'plan') {
      // API を呼ばずに、detection prompt の件数と大きさを出す（correctness は候補が出た item だけ・最大で同数）
      const sizes = work.map((w) => {
        const signals = computeMaterialitySignals(w.diff)
        const excerpts = extractBaseRecordExcerpts(gitRecordReader(repo, w.base), excerptTokens(w.diff, signals))
        return buildDetectionPrompt(instructions.detection, { title: w.title, diff: w.diff, signals, excerpts }).length
      }).sort((x, y) => x - y)
      const total = sizes.reduce((n, x) => n + x, 0)
      console.log(JSON.stringify({
        model,
        promptVersion: promptVersion(instructions),
        detectionCalls: sizes.length,
        maxEvaluationCalls: sizes.length,
        detectionPromptChars: { total, p50: sizes[Math.floor(sizes.length / 2)], p95: sizes[Math.floor(sizes.length * 0.95)], max: sizes[sizes.length - 1] },
      }, null, 2))
      return
    }

    // **低優先度・上限付き。** 逐次1本、呼び出し間隔の下限、1回の起動あたりの呼び出し上限、
    // quota / 課金 / 認証の失敗が1回でも出たら即停止（retry しない。共有 quota を食い潰さない）
    const minIntervalMs = Number(a['min-interval-ms'] ?? '20000')
    const maxCalls = Number(a['max-calls'] ?? '60')
    const { callGeminiForReview } = await import('../src/metaReviewer/geminiClient.js')
    const { sanitizeMessage } = await import('../src/metaReviewer/geminiRouter.js')
    let calls = 0
    let lastCallAt = 0
    let stopReason: string | undefined
    let current: { stageIndex: number; apiErrors: ApiErrorRecord[]; promptChars: number } = { stageIndex: 0, apiErrors: [], promptChars: 0 }
    const provider: ReviewProvider = async (prompt) => {
      const wait = lastCallAt + minIntervalMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastCallAt = Date.now()
      calls++
      const stage = current.stageIndex++ === 0 ? 'detection' : 'evaluation'
      current.promptChars += prompt.length
      try {
        return await callGeminiForReview(prompt, model)
      } catch (err) {
        const message = sanitizeMessage(err instanceof Error ? err.message : String(err))
        const classified = classifyApiError(message)
        current.apiErrors.push({ stage, ...classified, message })
        if (classified.errorClass === 'quota' || classified.errorClass === 'auth') stopReason = `${classified.errorClass} error at ${stage}`
        throw err
      }
    }
    // 再開は **同じ入力**の run だけを済みとみなす（model や prompt を変えて再開すると別の run として足される）
    const done = new Set(existsSync(file('results.jsonl'))
      ? readFileSync(file('results.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => {
        const r = JSON.parse(l) as DetectionRecord
        return `${r.kind}:${r.itemId}:${r.run}:${r.inputFingerprint}`
      })
      : [])
    let skipped = 0
    for (const w of work) {
      const fingerprint = inputFingerprint({ model, detection: instructions.detection, evaluation: instructions.evaluation, title: w.title, diff: w.diff, base: w.base })
      if (done.has(`${w.kind}:${w.itemId}:${w.run}:${fingerprint}`)) { skipped++; continue }
      if (stopReason) break
      // detection + correctness の2本を使い切れない残りでは始めない（途中で止めて半端な run を残さない）
      if (calls + 2 > maxCalls) { stopReason = `call budget ${maxCalls} reached`; break }
      current = { stageIndex: 0, apiErrors: [], promptChars: 0 }
      const started = Date.now()
      const observation = await observeDesignMateriality({
        title: w.title, diff: w.diff, records: gitRecordReader(repo, w.base),
        detectionInstructions: instructions.detection, evaluationInstructions: instructions.evaluation,
      }, provider)
      const entry: DetectionRecord = {
        itemId: w.itemId, kind: w.kind, run: w.run, model, promptVersion: promptVersion(instructions),
        inputFingerprint: fingerprint, latencyMs: Date.now() - started, promptChars: current.promptChars,
        apiErrors: current.apiErrors, observation,
      }
      // quota / 認証で止めた run は検出結果として残さない（API の失敗であって「未検出」ではない）。errors.jsonl にだけ残す
      if (stopReason && current.apiErrors.some((e) => e.errorClass === 'quota' || e.errorClass === 'auth')) {
        appendFileSync(file('errors.jsonl'), `${JSON.stringify(entry)}\n`)
        break
      }
      appendFileSync(file('results.jsonl'), `${JSON.stringify(entry)}\n`)
      if (current.apiErrors.length > 0) appendFileSync(file('errors.jsonl'), `${JSON.stringify({ itemId: w.itemId, kind: w.kind, run: w.run, apiErrors: current.apiErrors })}\n`)
      console.log(`${w.kind} ${w.itemId} run=${w.run} ${observation.status}${observation.reason ? ` (${observation.reason})` : ''} material=${observation.detection?.material ?? '-'}`)
    }
    console.log(`detect: calls=${calls} skipped(done)=${skipped}${stopReason ? ` stopped: ${stopReason}` : ' complete'}`)
    return
  }

  if (cmd === 'score') {
    const frame = JSON.parse(readFileSync(file('frame.json'), 'utf-8')) as Frame
    const labels = JSON.parse(readFileSync(a.labels ?? file('labels.json'), 'utf-8')) as Label[]
    const mutants = JSON.parse(readFileSync(file('mutants.json'), 'utf-8')) as Mutant[]
    const records = readFileSync(file('results.jsonl'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as DetectionRecord)
    const repeatNegatives = frame.items.filter((i) => i.stratum === 'N').slice(0, 20)
    const mutantRecords = records.filter((r) => r.kind === 'mutant')
    const percentile = (values: number[], q: number) => {
      if (values.length === 0) return null
      const sorted = values.slice().sort((x, y) => x - y)
      return sorted[Math.floor(q * (sorted.length - 1))]
    }
    // M4 の推奨はこの数値を読んだ人（PL / CEO）が出す。script は数値だけを出す。
    // token 数は geminiClient が usage を返さないため取れない。prompt 文字数を代理指標にする
    const report = {
      schemaVersion: DESIGN_MATERIALITY_SCHEMA_VERSION,
      evalScriptVersion: EVAL_SCRIPT_VERSION,
      repoHead: frame.repoHead,
      models: [...new Set(records.map((r) => r.model))],
      detectionPromptHashes: [...new Set(records.map((r) => r.observation.detectionPromptHash).filter(Boolean))].length,
      cost: {
        observations: records.length,
        latencyMsP50: percentile(records.map((r) => r.latencyMs), 0.5),
        latencyMsP95: percentile(records.map((r) => r.latencyMs), 0.95),
        promptCharsP50: percentile(records.map((r) => r.promptChars), 0.5),
        promptCharsP95: percentile(records.map((r) => r.promptChars), 0.95),
        evaluationCallRate: records.length === 0 ? null : records.filter((r) => r.observation.evaluationPromptHash !== undefined).length / records.length,
      },
      historical: scoreFrame(frame, labels, records),
      repeatability: {
        positives: scoreRepeatability(KNOWN_POSITIVES.map((p) => ({ itemId: p.sha, target: p.target, expectCandidate: true })), records.filter((r) => r.kind === 'positive'), REPEATS),
        mutants: scoreRepeatability(mutants.map((m) => ({ itemId: m.id, target: m.target, expectCandidate: m.expectCandidate, expectResponsibility: m.expectResponsibility })), mutantRecords, REPEATS),
        // rename-only は target 付き（preserved になるか）と、target なし（候補が出るか）の両方で測る
        mutantsUntargeted: scoreRepeatability(mutants.filter((m) => m.id === 'm10-rename-only').map((m) => ({ itemId: m.id })), mutantRecords, REPEATS),
        negatives: scoreRepeatability(repeatNegatives.map((n) => ({ itemId: n.sha })), records.filter((r) => r.kind === 'frame' && repeatNegatives.some((n) => n.sha === r.itemId)), REPEATS),
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
