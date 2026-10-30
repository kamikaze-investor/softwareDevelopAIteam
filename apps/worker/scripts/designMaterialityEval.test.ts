import { describe, expect, it } from 'vitest'
import { OBSERVATION_TIMEOUT_MS, type MaterialityObservation } from '../src/metaReviewer/designMateriality.js'
import {
  addUsage,
  buildFrame,
  callGeminiWithUsage,
  emptyUsage,
  classifyApiError,
  codexArgs,
  cliEnv,
  CLI_ARG_PATTERN,
  correctnessFlags,
  DETECTOR_MAX_OUTPUT_TOKENS,
  promptVersion,
  PROVIDER_REQUEST_TIMEOUT_MS,
  yieldToWorkflow,
  inputFingerprint,
  runState,
  sampleWithoutReplacement,
  scoreRepeatability,
  stratifiedBootstrap,
  weightedRates,
  type DetectionRecord,
  type WeightedPoint,
} from './designMaterialityEval.js'

function observation(candidates: Array<{ file: string; mechanism: string }>, status: 'ok' | 'unavailable' = 'ok'): MaterialityObservation {
  return {
    schemaVersion: 1,
    status,
    signals: [],
    excerpts: [],
    ...(status === 'ok'
      ? {
          detection: {
            material: candidates.length > 0,
            candidates: candidates.map((c, i) => ({ id: `c${i + 1}`, kind: 'removes' as const, subject: 'mechanism' as const, evidence: '', ...c })),
            signalDisposition: [],
          },
          evaluations: [],
        }
      : {}),
  }
}

describe('sampling / frame', () => {
  it('同じ seed なら同じ抽出、違う seed なら違う抽出', () => {
    const items = Array.from({ length: 100 }, (_, i) => i)
    expect(sampleWithoutReplacement(items, 10, 1)).toEqual(sampleWithoutReplacement(items, 10, 1))
    expect(sampleWithoutReplacement(items, 10, 1)).not.toEqual(sampleWithoutReplacement(items, 10, 2))
    expect(new Set(sampleWithoutReplacement(items, 10, 1)).size).toBe(10)
  })

  it('F は全数（重み1）、N は抽出して重み |N|/n', () => {
    const commits = [
      ...Array.from({ length: 3 }, (_, i) => ({ sha: `f${i}`, subject: '', signalKinds: ['contract_member_removed' as const] })),
      ...Array.from({ length: 12 }, (_, i) => ({ sha: `n${i}`, subject: '', signalKinds: [] })),
    ]
    const frame = buildFrame(commits, { head: 'h', sample: 4, seed: 7 })
    expect(frame).toMatchObject({ fired: 3, none: 12, sampledNone: 4 })
    expect(frame.items.filter((i) => i.stratum === 'F').every((i) => i.weight === 1)).toBe(true)
    expect(frame.items.filter((i) => i.stratum === 'N').map((i) => i.weight)).toEqual([3, 3, 3, 3])
  })
})

describe('weightedRates', () => {
  it('Challenger の例: F 全数 20 中 10 material、N 280 から 60 抽出して 6 material → 重み付き recall ≈ 26%', () => {
    const points = [
      ...Array.from({ length: 10 }, () => ({ weight: 1, stratum: 'F' as const, predicted: true, actual: true })),
      ...Array.from({ length: 10 }, () => ({ weight: 1, stratum: 'F' as const, predicted: true, actual: false })),
      ...Array.from({ length: 6 }, () => ({ weight: 280 / 60, stratum: 'N' as const, predicted: false, actual: true })),
      ...Array.from({ length: 54 }, () => ({ weight: 280 / 60, stratum: 'N' as const, predicted: false, actual: false })),
    ]
    const rates = weightedRates(points)
    expect(rates.recall).toBeCloseTo(10 / (10 + 28), 5)
    expect(rates.precision).toBeCloseTo(0.5, 5)
  })

  it('分母が 0 なら null', () => {
    expect(weightedRates([])).toEqual({ recall: null, precision: null, routineFlagRate: null })
  })

  it('層別 bootstrap は決定的で、点推定を含む区間を返す', () => {
    const points = [
      ...Array.from({ length: 8 }, (_, i) => ({ weight: 1, stratum: 'F' as const, predicted: true, actual: i < 6 })),
      ...Array.from({ length: 20 }, (_, i) => ({ weight: 5, stratum: 'N' as const, predicted: false, actual: i < 2 })),
    ]
    const metric = (ps: readonly WeightedPoint[]) => weightedRates(ps).recall
    const ci = stratifiedBootstrap(points, metric, 500, 3)
    expect(ci).toEqual(stratifiedBootstrap(points, metric, 500, 3))
    const point = metric(points) as number
    expect(ci?.[0]).toBeLessThanOrEqual(point)
    expect(ci?.[1]).toBeGreaterThanOrEqual(point)
  })
})

describe('runState / repeatability（v3.1）', () => {
  const target = { files: ['apps/api/src/pl/conflictResolutionStep.ts'], mechanismKeywords: ['challenge'] }

  it('target を持つ item: file と keyword が一致すれば target_detected', () => {
    expect(runState(observation([{ file: target.files[0], mechanism: 'Challenge stage' }]), target)).toBe('target_detected')
    expect(runState(observation([{ file: 'other.ts', mechanism: 'Challenge stage' }]), target)).toBe('not_detected')
    expect(runState(observation([], 'unavailable'), target)).toBe('unavailable')
  })

  it('target を持たない item: 候補の有無', () => {
    expect(runState(observation([]), undefined)).toBe('no_candidates')
    expect(runState(observation([{ file: 'x', mechanism: 'y' }]), undefined)).toBe('candidates_present')
  })

  const records = (itemId: string, obs: MaterialityObservation[]): DetectionRecord[] =>
    obs.map((observation, run) => ({ itemId, kind: 'mutant', run, model: 'm', promptVersion: { detection: 'd', evaluation: 'e' }, inputFingerprint: 'fp', latencyMs: 0, promptChars: 0, apiErrors: [], observation }))

  it('3回とも同じく見逃した positive は flip ではない（hit rate 0 として別に出る）', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], records('p', [observation([]), observation([]), observation([])]), 3)
    expect(result.items[0]).toMatchObject({ flipped: false, targetHitRate: 0 })
  })

  it('3回とも候補なしの negative は flip ではない', () => {
    const result = scoreRepeatability([{ itemId: 'n' }], records('n', [observation([]), observation([]), observation([])]), 3)
    expect(result.items[0]).toMatchObject({ flipped: false, targetHitRate: null })
  })

  it('検出・見逃し・unavailable が混ざれば flip', () => {
    const hit = observation([{ file: target.files[0], mechanism: 'challenge' }])
    const result = scoreRepeatability([{ itemId: 'p', target }], records('p', [hit, observation([]), observation([], 'unavailable')]), 3)
    expect(result.items[0]).toMatchObject({ flipped: true, states: ['target_detected', 'not_detected', 'unavailable'] })
    expect(result.flipRate).toBe(1)
  })
})

describe('独立レビュー指摘（code review round 1）の回帰', () => {
  const target = { files: ['apps/api/src/pl/conflictResolutionStep.ts'], mechanismKeywords: ['challenge'] }
  const record = (run: number, observation: MaterialityObservation, inputFingerprint = 'fp'): DetectionRecord =>
    ({ itemId: 'p', kind: 'positive', run, model: 'm', promptVersion: { detection: 'd', evaluation: 'e' }, inputFingerprint, latencyMs: 0, promptChars: 0, apiErrors: [], observation })
  const hit = (evaluations: MaterialityObservation['evaluations'], status: 'ok' | 'unavailable' = 'ok'): MaterialityObservation => ({
    ...observation([{ file: target.files[0], mechanism: 'Challenge stage' }]),
    status,
    evaluations,
  })

  it('A1: 別入力（fingerprint 違い）の run が混ざった item は invalid として flip 率から外す', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [record(0, hit([]), 'a'), record(1, hit([]), 'b'), record(2, hit([]), 'b')], 3)
    expect(result.items[0].invalid).toBe('mixed_inputs')
    expect(result).toMatchObject({ invalidItems: 1, flipRate: null })
  })

  it('A1: run 数が期待と違えば invalid', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [record(0, hit([])), record(1, hit([]))], 3)
    expect(result.items[0].invalid).toBe('run_count')
  })

  it('A2: correctness が3回とも欠けても「安定」とは数えない（評価の欠落は別に数える）', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [0, 1, 2].map((run) => record(run, hit(undefined, 'unavailable'))), 3)
    expect(result.items[0]).toMatchObject({ responsibilities: [], evaluationMissing: 3, responsibilityStable: 'insufficient' })
  })

  it('A3: target の file は完全一致（無関係な file の候補は target 検出にならない）', () => {
    expect(runState(observation([{ file: 'apps/api/src/unrelated.ts', mechanism: 'challenge' }]), target)).toBe('not_detected')
  })
})

describe('独立レビュー指摘（code review round 2）の回帰', () => {
  const target = { files: ['apps/api/src/pl/conflictResolutionStep.ts'], mechanismKeywords: ['challenge'] }
  const rec = (run: number, observation: MaterialityObservation): DetectionRecord =>
    ({ itemId: 'p', kind: 'positive', run, model: 'm', promptVersion: { detection: 'd', evaluation: 'e' }, inputFingerprint: 'fp', latencyMs: 0, promptChars: 0, apiErrors: [], observation })
  const detected = (status: 'ok' | 'unavailable'): MaterialityObservation =>
    ({ ...observation([{ file: target.files[0], mechanism: 'challenge' }]), status, evaluations: status === 'ok' ? [] : undefined })

  it('run 番号 [0,0,1] は run 2 の欠落として invalid', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [rec(0, detected('ok')), rec(0, detected('ok')), rec(1, detected('ok'))], 3)
    expect(result.items[0].invalid).toBe('run_count')
  })

  it('correctness だけの timeout も anyUnavailableRunRate に出る', () => {
    const result = scoreRepeatability([{ itemId: 'p', target }], [0, 1, 2].map((run) => rec(run, detected('unavailable'))), 3)
    expect(result).toMatchObject({ unavailableRunRate: 0, anyUnavailableRunRate: 1 })
  })

  it('fingerprint は title を含む', () => {
    const base = { model: 'm', detection: 'd', evaluation: 'e', diff: 'x', base: 'b' }
    expect(inputFingerprint({ ...base, title: 'a' })).not.toBe(inputFingerprint({ ...base, title: 'b' }))
  })
})

describe('classifyApiError（quota / 認証は即停止の対象）', () => {
  it.each([
    ['[GoogleGenerativeAI Error]: Error fetching from https://x: [429 Too Many Requests] Resource has been exhausted', 'quota', 429],
    ['[GoogleGenerativeAI Error]: [402 Payment Required] credit balance', 'quota', 402],
    ['RESOURCE_EXHAUSTED: quota exceeded', 'quota', null],
    ['[GoogleGenerativeAI Error]: [403 Forbidden] API key not valid', 'auth', 403],
    ['GEMINI_API_KEY が設定されていません。.env を確認してください。', 'auth', null],
    ['[GoogleGenerativeAI Error]: [503 Service Unavailable] overloaded', 'transient', 503],
    ['fetch failed', 'transient', null],
    ['Gemini からの応答が空でした', 'other', null],
  ])('%s → %s', (message, errorClass, httpStatus) => {
    expect(classifyApiError(message)).toEqual({ errorClass, httpStatus })
  })
})

describe('promptVersion', () => {
  it('instructions が変われば版が変わる', () => {
    expect(promptVersion({ detection: 'a', evaluation: 'b' })).not.toEqual(promptVersion({ detection: 'a2', evaluation: 'b' }))
    expect(promptVersion({ detection: 'a', evaluation: 'b' }).detection).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('correctnessFlags（狭い予測）', () => {
  const evaluation = (over: Record<string, unknown>) => ({
    candidateId: 'c1', responsibility: 'preserved', newOwner: null, recordConsistency: 'consistent',
    ceoDirectedProvenance: 'no', provenanceEvidence: '', correctness: '', simplicity: '', naturalness: '', ...over,
  })
  const obs = (kind: string, over: Record<string, unknown>, status: 'ok' | 'unavailable' = 'ok'): MaterialityObservation => ({
    schemaVersion: 1, status, signals: [], excerpts: [],
    detection: { material: true, candidates: [{ id: 'c1', kind: kind as 'removes', subject: 'mechanism', mechanism: 'm', file: 'f', evidence: '' }], signalDisposition: [] },
    evaluations: [evaluation(over) as never],
  })

  it.each([
    ['lost', 'removes', { responsibility: 'lost' }, true],
    ['記録と食い違う', 'redefines', { responsibility: 'moved', newOwner: 'x', recordConsistency: 'contradicts_unupdated_record' }, true],
    ['CEO 指示で preserved 以外', 'replaces', { responsibility: 'unclear', ceoDirectedProvenance: 'yes' }, true],
    ['preserved（改名）', 'replaces', { responsibility: 'preserved' }, false],
    ['redefined で記録と食い違う', 'redefines', { responsibility: 'redefined', recordConsistency: 'contradicts_unupdated_record' }, true],
    ['redefined で記録と整合・CEO 指示なし', 'redefines', { responsibility: 'redefined' }, false],
    ['redefined で CEO 指示の設計', 'redefines', { responsibility: 'redefined', ceoDirectedProvenance: 'yes' }, true],
  ])('%s → %s', (_label, kind, over, expected) => {
    expect(correctnessFlags(obs(kind, over))).toBe(expected)
  })

  it.each([
    ['Authority 境界の再定義（記録と整合・CEO 指示なし）も数える', 'redefines', { responsibility: 'redefined' }, true],
    ['Authority 境界の追加も数える', 'introduces', { responsibility: 'introduced' }, true],
    ['保たれた Authority 境界は数えない', 'replaces', { responsibility: 'preserved' }, false],
  ])('authority_boundary: %s', (_label, kind, over, expected) => {
    const o = obs(kind, over)
    if (o.detection) o.detection.candidates[0].subject = 'authority_boundary'
    expect(correctnessFlags(o)).toBe(expected)
  })

  it.each([
    ['既定の評価（preserved・consistent・CEO 指示なし）は数えない', 'removes', {}, false],
    ['追加だけ', 'introduces', { responsibility: 'lost' }, false],
  ])('%s → %s', (_label, kind, over, expected) => {
    expect(correctnessFlags(obs(kind, over))).toBe(expected)
  })

  it('評価が得られていない run は false', () => {
    expect(correctnessFlags(obs('removes', { responsibility: 'lost' }, 'unavailable'))).toBe(false)
  })
})

describe('token usage', () => {
  it('addUsage は合計する', () => {
    const u = emptyUsage()
    addUsage(u, { calls: 1, promptTokens: 100, candidatesTokens: 20, totalTokens: 150 })
    addUsage(u, { calls: 1, promptTokens: 10, candidatesTokens: 2, totalTokens: 15 })
    expect(u).toEqual({ calls: 2, promptTokens: 110, candidatesTokens: 22, totalTokens: 165 })
  })

  it('callGeminiWithUsage は key が無ければ API を呼ばずに失敗し、その失敗は auth に分類される', async () => {
    const saved = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      await expect(callGeminiWithUsage('p', 'm')).rejects.toThrow('GEMINI_API_KEY is not configured')
      expect(classifyApiError('GEMINI_API_KEY is not configured').errorClass).toBe('auth')
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved
    }
  })
})

describe('yieldToWorkflow（共有 key の譲り合い。safety gate ではない）', () => {
  const env = { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  const restore = () => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  const fake = (counts: number[]) => {
    let i = 0
    return async () => ({ ok: true, json: async () => ({ total_count: counts[Math.min(i++, counts.length - 1)] }) })
  }

  it('GitHub の設定が無ければ待たない', async () => {
    delete process.env.GITHUB_REPOSITORY
    try { await expect(yieldToWorkflow('meta-review.yml')).resolves.toEqual({ waitedMs: 0, reason: 'not_configured' }) } finally { restore() }
  })

  it('run が無くなるまで待つ', async () => {
    process.env.GITHUB_REPOSITORY = 'o/r'; process.env.GITHUB_TOKEN = 't'
    try {
      // queued, in_progress の順に問い合わせる: 1回目は in_progress=1、2回目は両方 0
      const result = await yieldToWorkflow('meta-review.yml', { fetchImpl: fake([0, 1, 0, 0]), pollMs: 1 })
      expect(result.reason).toBe('idle')
    } finally { restore() }
  })

  it('上限まで待っても終わらなければ進む', async () => {
    process.env.GITHUB_REPOSITORY = 'o/r'; process.env.GITHUB_TOKEN = 't'
    try {
      await expect(yieldToWorkflow('meta-review.yml', { fetchImpl: fake([1]), pollMs: 1, maxWaitMs: 5 })).resolves.toMatchObject({ reason: 'max_wait' })
    } finally { restore() }
  })

  it('確認に失敗したら待たずに進む', async () => {
    process.env.GITHUB_REPOSITORY = 'o/r'; process.env.GITHUB_TOKEN = 't'
    try {
      const failing = async () => { throw new Error('network') }
      await expect(yieldToWorkflow('meta-review.yml', { fetchImpl: failing })).resolves.toMatchObject({ reason: 'check_failed' })
    } finally { restore() }
  })
})

it('client 側の request timeout は、最小間隔と足しても既定の観測待機上限より短い', () => {
  expect(20_000 + PROVIDER_REQUEST_TIMEOUT_MS).toBeLessThan(OBSERVATION_TIMEOUT_MS)
})

it('detector の出力上限は thinking を含めても JSON が切れない大きさ（live の 8192 より大きい）', () => {
  expect(DETECTOR_MAX_OUTPUT_TOKENS).toBeGreaterThan(8192)
})

it.each([
  ["codex: You've hit your usage limit. Try again later", 'quota'],
  ['claude: Not logged in · Please run /login', 'auth'],
  ["codex: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.", 'auth'],
  ['codex: tool use refused (2 items)', 'policy'],
  ['claude: tool use refused (1 denials)', 'policy'],
])('CLI provider の停止対象エラー: %s → %s', (message, errorClass) => {
  expect(classifyApiError(message).errorClass).toBe(errorClass)
})

it('Codex は user config・rules を読まず、tool 系 feature を切り、sandbox を緩める flag を持たない', () => {
  const args = codexArgs('gpt-5.6-sol', 'medium')
  expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ignore-rules', '--ephemeral']))
  expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
  for (const f of ['shell_tool', 'apps', 'plugins', 'browser_use', 'computer_use']) expect(args.join(' ')).toContain(`--disable ${f}`)
  expect(args.some((x) => /dangerously|bypass|full-access|workspace-write/.test(x))).toBe(false)
})

it.each(['gpt-5.6-sol', 'claude-sonnet-5-5', 'medium'])('CLI に渡す値として %s を許す', (v) => {
  expect(CLI_ARG_PATTERN.test(v)).toBe(true)
})

it.each(['--dangerously-bypass-approvals-and-sandbox', 'x" -c sandbox_mode=danger-full-access', 'a b', ''])('CLI に渡す値として %s を拒む', (v) => {
  expect(CLI_ARG_PATTERN.test(v)).toBe(false)
})

it('CLI の子 process には allowlist の環境変数だけを渡し、他の credential を継がせない', () => {
  const env = cliEnv({ PATH: '/bin', USERPROFILE: 'C:/u', GEMINI_API_KEY: 'k', GITHUB_TOKEN: 't', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' })
  expect(env).toEqual({ PATH: '/bin', USERPROFILE: 'C:/u' })
})
