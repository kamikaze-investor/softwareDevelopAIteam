import { describe, expect, it } from 'vitest'
import {
  capDiff,
  computeMaterialitySignals,
  excerptTokens,
  extractBaseRecordExcerpts,
  observeDesignMateriality,
  parseDetection,
  parseEvaluation,
  RAW_EXCERPT_CHARS,
  signalId,
  stripStringsAndComments,
  type BaseRecordReader,
  type MaterialitySignal,
} from './designMateriality.js'

/** 1 file 分の unified diff を組み立てる（hunk は1つ） */
function fileDiff(path: string, lines: string[], opts: { deleted?: boolean } = {}): string {
  return [
    `diff --git a/${path} b/${path}`,
    ...(opts.deleted ? ['deleted file mode 100644'] : []),
    `--- a/${path}`,
    opts.deleted ? '+++ /dev/null' : `+++ b/${path}`,
    '@@ -1,10 +1,10 @@',
    ...lines,
  ].join('\n')
}

const kinds = (signals: MaterialitySignal[]) => signals.map((s) => `${s.kind}:${s.token}`)

describe('computeMaterialitySignals — S1 契約メンバーの削除', () => {
  it('e405c7c7 の形: exported union から status literal が消えると、消えた member ごとに S1', () => {
    const diff = fileDiff('apps/api/src/pl/conflictResolutionStep.ts', [
      ' export type ConflictRoundStatus =',
      "   | 'critic_done'",
      "-  | 'challenge_aligned'",
      "-  | 'challenge_not_aligned'",
      "-  | 'challenge_cap_reached'",
      "   | 'terminal'",
    ])
    expect(kinds(computeMaterialitySignals(diff))).toEqual([
      'contract_member_removed:challenge_aligned',
      'contract_member_removed:challenge_not_aligned',
      'contract_member_removed:challenge_cap_reached',
    ])
  })

  it('double quote / 1行 union / case arm / enum member / exported const map key も拾う', () => {
    const diff = fileDiff('apps/api/src/x.ts', [
      '-export type Mode = "fast" | "safe"',
      '+export type Mode = "fast"',
      "-    case 'challenge':",
      ' export enum Stage {',
      '   Critic,',
      '-  Challenge,',
      ' }',
      ' export const HANDLERS = {',
      '-  challenge: runChallenge,',
      '   revise: revise,',
      ' }',
    ])
    expect(kinds(computeMaterialitySignals(diff)).sort()).toEqual([
      'contract_member_removed:Challenge',
      'contract_member_removed:challenge',
      'contract_member_removed:challenge',
      'contract_member_removed:safe',
    ].sort())
  })

  it('同じ literal を同じ file の **別構文**へ足しても相殺しない（per-file・per-subtype netting）', () => {
    const diff = fileDiff('apps/api/src/x.ts', [
      "-  | 'challenge_aligned'",
      "+const legacy = 'challenge_aligned'",
    ])
    expect(kinds(computeMaterialitySignals(diff))).toEqual(['contract_member_removed:challenge_aligned'])
  })

  it('並べ替え（同じ file・同じ構文で削除と追加）は相殺する', () => {
    const diff = fileDiff('apps/api/src/x.ts', [
      "-  | 'b'",
      "   | 'a'",
      "+  | 'b'",
    ])
    expect(computeMaterialitySignals(diff)).toEqual([])
  })

  it('別 file へ移しただけでも S1 は file ごとに出る（移動は候補として detection に渡す）', () => {
    const diff = [
      fileDiff('apps/api/src/a.ts', ["-  | 'challenge_aligned'"]),
      fileDiff('apps/api/src/b.ts', ["+  | 'challenge_aligned'"]),
    ].join('\n')
    expect(kinds(computeMaterialitySignals(diff))).toEqual(['contract_member_removed:challenge_aligned'])
  })

  it('`|| status === ...` の比較行は union member ではない', () => {
    const diff = fileDiff('apps/api/src/pl/executionLoop.ts', ["-    || status === 'challenge_aligned'"])
    expect(computeMaterialitySignals(diff)).toEqual([])
  })

  it('test file・非 code file の union は対象外', () => {
    const diff = [
      fileDiff('apps/api/src/x.test.ts', ["-  | 'challenge_aligned'"]),
      fileDiff('docs/x.md', ["-  | 'challenge_aligned'"]),
    ].join('\n')
    expect(computeMaterialitySignals(diff)).toEqual([])
  })
})

describe('computeMaterialitySignals — S2 / S3 / S4', () => {
  it('S2: 設計の出自を示すコメント行の削除（CEO 指示）', () => {
    const diff = fileDiff('apps/api/src/pl/conflictResolutionStep.ts', [
      ' /**',
      '- * ## 呼称について厳密であること（CEO 指示 2026-09-18）',
      ' */',
      '-// helper for formatting',
    ])
    expect(kinds(computeMaterialitySignals(diff))).toEqual([
      'provenance_comment_removed:* ## 呼称について厳密であること（CEO 指示 2026-09-18）',
    ])
  })

  it('S2: コメントでない行は CEO を含んでも対象外', () => {
    const diff = fileDiff('apps/api/src/x.ts', ["-  const label = 'CEO'"])
    expect(computeMaterialitySignals(diff)).toEqual([])
  })

  it('S3: non-test source file の削除。中身の契約メンバーも S1 に数える', () => {
    const diff = fileDiff('apps/api/src/pl/challengeStage.ts', [
      "-export type ChallengeStatus = 'aligned' | 'not_aligned'",
    ], { deleted: true })
    expect(kinds(computeMaterialitySignals(diff))).toEqual([
      'source_file_deleted:apps/api/src/pl/challengeStage.ts',
      'contract_member_removed:aligned',
      'contract_member_removed:not_aligned',
    ])
  })

  it('S4: test title の削除。別の test file に同じ title が足されれば相殺する', () => {
    const diff = [
      fileDiff('apps/api/src/a.test.ts', [
        "-  it('Challenge が ALIGNED なら既存 Job Gate 経由で Job が作られる', () => {",
        "-  it('moved title', () => {",
      ]),
      fileDiff('apps/api/src/b.test.ts', ["+  it('moved title', () => {"]),
    ].join('\n')
    expect(kinds(computeMaterialitySignals(diff))).toEqual([
      'behavior_test_removed:Challenge が ALIGNED なら既存 Job Gate 経由で Job が作られる',
    ])
  })

  it('signal id は file|kind|token の決定的な hash', () => {
    const [signal] = computeMaterialitySignals(fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"]))
    expect(signal.id).toBe(signalId('apps/api/src/x.ts', 'contract_member_removed', 'challenge_aligned'))
    expect(signal.id).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('computeMaterialitySignals — 決定的 signal が出ない形（M5 で LLM の recall を測る対象）', () => {
  it.each([
    ['early return で到達不能にする', ['+  if (stage === \'challenge\') return runPlRevision(ctx)']],
    ['cap 定数を 1 → 0', ['-const MAX_CHALLENGES_PER_FINDING = 1', '+const MAX_CHALLENGES_PER_FINDING = 0']],
    ['enabling flag を true → false', ['-  challengeEnabled: true,', '+  challengeEnabled: false,']],
  ])('%s', (_label, lines) => {
    expect(computeMaterialitySignals(fileDiff('apps/api/src/pl/conflictResolutionStep.ts', lines))).toEqual([])
  })
})

describe('extractBaseRecordExcerpts', () => {
  const roadmap = Array.from({ length: 40 }, (_, i) => (i === 20 ? '- stage=challenge は challenge_aligned で release する' : `line ${i}`)).join('\n')
  const reader: BaseRecordReader = {
    listRecordFiles: () => ['tasks/roadmap.md', 'specs/22.md'],
    read: (p) => (p === 'tasks/roadmap.md' ? roadmap : 'nothing here'),
  }

  it('削除された契約 literal を含む段落を base 記録から抜く（行番号は1始まり）', () => {
    const excerpts = extractBaseRecordExcerpts(reader, ['challenge_aligned'])
    expect(excerpts).toHaveLength(1)
    expect(excerpts[0]).toMatchObject({ file: 'tasks/roadmap.md', startLine: 15, token: 'challenge_aligned' })
    expect(excerpts[0].text).toContain('stage=challenge')
  })

  it('excerptTokens: S1 literal と、削除行の長い識別子だけを使う（短い語は使わない）', () => {
    const diff = fileDiff('apps/api/src/x.ts', [
      "-  | 'challenge_aligned'",
      '-  const result = await runChallengeStage(ctx)',
    ])
    expect(excerptTokens(diff, computeMaterialitySignals(diff))).toEqual(['challenge_aligned', 'runChallengeStage'])
  })
})

describe('capDiff', () => {
  it('上限内ならそのまま', () => {
    const diff = fileDiff('a.ts', ['-x'])
    expect(capDiff(diff, 10_000)).toEqual({ text: diff, truncated: false, truncatedFiles: [] })
  })

  it('大きな diff の後ろにある削除 hunk も、各 file の最低割当で残る', () => {
    const big = fileDiff('apps/big.ts', Array.from({ length: 5000 }, (_, i) => `+filler line ${i} ${'x'.repeat(40)}`))
    const late = fileDiff('apps/api/src/pl/conflictResolutionStep.ts', ["-  | 'challenge_aligned'"])
    const capped = capDiff(`${big}\n${late}`, 50_000)
    expect(capped.truncated).toBe(true)
    expect(capped.text.length).toBeLessThanOrEqual(50_000 + 200)
    expect(capped.text).toContain("-  | 'challenge_aligned'")
    expect(capped.truncatedFiles).toEqual(['apps/big.ts'])
  })

  it('file header だけで上限を超えても、結果は上限を超えない（最終 fallback）', () => {
    const many = Array.from({ length: 100 }, (_, i) => fileDiff(`apps/${'p'.repeat(1600)}${i}.ts`, ['-x'])).join('\n')
    const capped = capDiff(many, 150_000)
    expect(capped.truncated).toBe(true)
    expect(capped.text.length).toBeLessThanOrEqual(150_000)
  })
})

describe('parseDetection — strict', () => {
  const signals = computeMaterialitySignals(fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"]))
  const sid = signals[0].id
  const candidate = { id: 'c1', kind: 'removes', subject: 'mechanism', mechanism: 'Challenge stage', file: 'apps/api/src/x.ts', evidence: 'union member removed' }

  it('候補あり・全 S1 に disposition あり → ok', () => {
    const raw = '```json\n' + JSON.stringify({
      material: true, candidates: [candidate],
      signalDisposition: [{ signalId: sid, disposition: 'supports_candidate:c1', reason: 'r' }],
    }) + '\n```'
    const parsed = parseDetection(raw, signals)
    expect(parsed.ok).toBe(true)
  })

  it('未知の kind（採点に使う欄）は不成立', () => {
    expect(parseDetection(JSON.stringify({ material: true, candidates: [{ ...candidate, kind: 'tweaks' }], signalDisposition: [] }), signals))
      .toEqual({ ok: false, reason: 'invalid_candidate:kind' })
  })

  it.each([
    ['material と candidates が食い違う → 候補の有無に合わせる', { material: false, candidates: [candidate], signalDisposition: [{ signalId: sid, disposition: 'supports_candidate:c1', reason: '' }] }, ['material_mismatch'], true, 1],
    ['S1 に disposition が無い → 残す', { material: true, candidates: [candidate], signalDisposition: [] }, [`signal_not_disposed:${sid}`], true, 0],
    ['存在しない candidate を指す disposition は捨てる', { material: true, candidates: [candidate], signalDisposition: [{ signalId: sid, disposition: 'supports_candidate:c9', reason: '' }] }, ['unknown_disposition:supports_candidate:c9', `signal_not_disposed:${sid}`], true, 0],
    ['正しさを判断する disposition（behavior_preserving）は捨てる', { material: false, candidates: [], signalDisposition: [{ signalId: sid, disposition: 'behavior_preserving', reason: '' }] }, ['unknown_disposition:behavior_preserving', `signal_not_disposed:${sid}`], false, 0],
  ])('%s', (_label, body, warnings, material, dispositions) => {
    const parsed = parseDetection(JSON.stringify(body), signals)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.warnings).toEqual(warnings)
    expect(parsed.value.material).toBe(material)
    expect(parsed.value.signalDisposition).toHaveLength(dispositions)
  })

  it('JSON が無ければ不成立', () => {
    expect(parseDetection('no verdict', signals)).toEqual({ ok: false, reason: 'no_json' })
  })
})

describe('parseEvaluation — strict', () => {
  const candidates = [{ id: 'c1', kind: 'removes' as const, subject: 'mechanism' as const, mechanism: 'm', file: 'f', evidence: 'e' }]
  const evaluation = {
    candidateId: 'c1', responsibility: 'lost', newOwner: null, recordConsistency: 'contradicts_unupdated_record',
    ceoDirectedProvenance: 'yes', provenanceEvidence: 'roadmap:11374', correctness: '', simplicity: '', naturalness: '',
  }

  it('全 candidate にちょうど1つ → ok', () => {
    expect(parseEvaluation(JSON.stringify({ evaluations: [evaluation] }), candidates).ok).toBe(true)
  })

  it('使える評価が1件も無ければ不成立。未知の候補への評価は捨てて warning に残す', () => {
    expect(parseEvaluation(JSON.stringify({ evaluations: [] }), candidates)).toEqual({ ok: false, reason: 'no_usable_evaluation' })
    expect(parseEvaluation(JSON.stringify({ evaluations: [evaluation, { ...evaluation, candidateId: 'c2' }] }), candidates))
      .toMatchObject({ ok: true, warnings: ['unknown_candidate:c2'] })
  })

  it('評価の無い候補は unevaluated として残す', () => {
    const two = [...candidates, { ...candidates[0], id: 'c2' }]
    expect(parseEvaluation(JSON.stringify({ evaluations: [evaluation] }), two)).toMatchObject({ ok: true, warnings: ['unevaluated:c2'] })
  })
})

describe('observeDesignMateriality — 例外を外へ出さない', () => {
  const diff = fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"])
  const records: BaseRecordReader = { listRecordFiles: () => [], read: () => undefined }
  const input = { title: 't', diff, records, detectionInstructions: 'D', evaluationInstructions: 'E' }
  const sid = computeMaterialitySignals(diff)[0].id
  const detection = JSON.stringify({
    material: true,
    candidates: [{ id: 'c1', kind: 'removes', subject: 'mechanism', mechanism: 'Challenge', file: 'apps/api/src/x.ts', evidence: 'e' }],
    signalDisposition: [{ signalId: sid, disposition: 'supports_candidate:c1', reason: '' }],
  })
  const evaluation = JSON.stringify({ evaluations: [{
    candidateId: 'c1', responsibility: 'lost', newOwner: null, recordConsistency: 'no_record',
    ceoDirectedProvenance: 'unknown', provenanceEvidence: '', correctness: '', simplicity: '', naturalness: '',
  }] })

  it('detection → correctness の順に呼び、correctness には detection の応答本文を渡さない', async () => {
    const prompts: string[] = []
    const provider = async (prompt: string) => { prompts.push(prompt); return prompts.length === 1 ? `reasoning text SECRET\n${detection}` : evaluation }
    const observation = await observeDesignMateriality(input, provider)
    expect(observation.status).toBe('ok')
    expect(observation.evaluations?.[0].responsibility).toBe('lost')
    expect(prompts).toHaveLength(2)
    expect(prompts[0].startsWith('D')).toBe(true)
    expect(prompts[1].startsWith('E')).toBe(true)
    expect(prompts[1]).not.toContain('SECRET')
  })

  it('候補が無ければ correctness を呼ばない', async () => {
    let calls = 0
    const none = JSON.stringify({ material: false, candidates: [], signalDisposition: [{ signalId: sid, disposition: 'unrelated', reason: '' }] })
    const observation = await observeDesignMateriality(input, async () => { calls++; return none })
    expect(observation).toMatchObject({ status: 'ok', evaluations: [] })
    expect(calls).toBe(1)
  })

  it.each([
    ['provider が reject', async () => { throw new Error('quota') }, 'provider_error'],
    ['応答が不正', async () => 'garbage', 'parse:no_json'],
  ])('%s → unavailable（throw しない）', async (_label, provider, reason) => {
    await expect(observeDesignMateriality(input, provider)).resolves.toMatchObject({ status: 'unavailable', reason })
  })

  it('timeout → unavailable。期限後の reject は unhandled にならない', async () => {
    const provider = () => new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('late')), 30))
    await expect(observeDesignMateriality(input, provider, 5)).resolves.toMatchObject({ status: 'unavailable', reason: 'timeout' })
    await new Promise((r) => setTimeout(r, 50))
  })

  it('record reader が throw しても internal_error で返る', async () => {
    const broken: BaseRecordReader = { listRecordFiles: () => { throw new Error('git') }, read: () => undefined }
    await expect(observeDesignMateriality({ ...input, records: broken }, async () => detection))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'internal_error' })
  })
})

describe('独立レビュー指摘（code review round 1）の回帰', () => {
  it('A4: capDiff は小さな上限でも上限を超えない', () => {
    const diff = fileDiff('apps/api/src/x.ts', Array.from({ length: 50 }, (_, i) => `-line ${i}`))
    for (const limit of [0, 1, 10, 60, 200]) expect(capDiff(diff, limit).text.length).toBeLessThanOrEqual(limit)
  })

  it('1行 enum の member 削除を拾う', () => {
    const diff = fileDiff('apps/api/src/x.ts', ['-export enum Stage { Critic, Challenge }', '+export enum Stage { Critic }'])
    expect(kinds(computeMaterialitySignals(diff))).toEqual(['contract_member_removed:Challenge'])
  })

  it('個数で相殺する（同じ case arm を2つ消して1つ足せば、1つ消えている）', () => {
    const diff = fileDiff('apps/api/src/x.ts', ["-    case 'challenge':", "-    case 'challenge':", "+    case 'challenge':"])
    expect(kinds(computeMaterialitySignals(diff))).toEqual(['contract_member_removed:challenge'])
  })

  it('quote された diff header の path も読む', () => {
    const diff = [
      'diff --git "a/apps/api/src/ステージ.ts" "b/apps/api/src/ステージ.ts"',
      '--- "a/apps/api/src/ステージ.ts"',
      '+++ "b/apps/api/src/ステージ.ts"',
      '@@ -1,2 +1,1 @@',
      "-  | 'challenge_aligned'",
    ].join('\n')
    expect(computeMaterialitySignals(diff).map((s) => s.file)).toEqual(['apps/api/src/ステージ.ts'])
  })

  const signals = computeMaterialitySignals(fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"]))
  const sid = signals[0].id
  const candidate = { id: 'c1', kind: 'removes', subject: 'mechanism', mechanism: 'm', file: 'apps/api/src/x.ts', evidence: 'e' }

  it('detection: 同じ signal への複数の disposition は残し、未知の signal id の disposition は捨てる', () => {
    const dup = { material: true, candidates: [candidate], signalDisposition: [
      { signalId: sid, disposition: 'supports_candidate:c1', reason: '' },
      { signalId: sid, disposition: 'unrelated', reason: '' },
    ] }
    const parsedDup = parseDetection(JSON.stringify(dup), signals)
    expect(parsedDup.ok && parsedDup.value.signalDisposition).toHaveLength(2)
    expect(parsedDup.ok && parsedDup.warnings).toEqual([])
    const unknown = { material: true, candidates: [candidate], signalDisposition: [
      { signalId: sid, disposition: 'supports_candidate:c1', reason: '' },
      { signalId: 'ffffffffffff', disposition: 'unrelated', reason: '' },
    ] }
    expect(parseDetection(JSON.stringify(unknown), signals)).toMatchObject({ ok: true, warnings: ['unknown_signal:ffffffffffff'] })
  })

  it('evaluation: moved なのに newOwner が無い評価は捨てる（唯一の評価なら不成立）', () => {
    const body = { evaluations: [{
      candidateId: 'c1', responsibility: 'moved', newOwner: null, recordConsistency: 'no_record',
      ceoDirectedProvenance: 'unknown', provenanceEvidence: '', correctness: '', simplicity: '', naturalness: '',
    }] }
    expect(parseEvaluation(JSON.stringify(body), [{ ...candidate, kind: 'removes', subject: 'mechanism' }]))
      .toEqual({ ok: false, reason: 'no_usable_evaluation' })
  })
})

describe('独立レビュー指摘（code review round 2）の回帰', () => {
  it('1行 enum の初期化子文字列内の `,` で member を切らない', () => {
    const diff = fileDiff('apps/api/src/x.ts', ['-export enum E { A = "x,y", B }', '+export enum E { A = "x,z", B }'])
    expect(computeMaterialitySignals(diff)).toEqual([])
  })
})

describe('独立レビュー指摘（code review round 3）の回帰', () => {
  it("1行 enum のコメント内の `'` を引用符と誤らない", () => {
    const diff = fileDiff('apps/api/src/x.ts', ["-export enum E { A = 1 /* don't */, B /* it's */ }", "+export enum E { A = 1 /* don't */ }"])
    expect(kinds(computeMaterialitySignals(diff))).toEqual(['contract_member_removed:B'])
  })
})

describe('独立レビュー指摘（code review round 4）の回帰', () => {
  it('1行 enum の文字列内のコメント記号をコメントと誤らない', () => {
    const diff = fileDiff('apps/api/src/x.ts', ['-export enum E { A = "/*", B, C = "*/" }', '+export enum E { A = "/*", C = "*/" }'])
    expect(kinds(computeMaterialitySignals(diff))).toEqual(['contract_member_removed:B'])
  })

  it.each([
    ['A = "x,y", B', 'A = "", B'],
    ["A = 1 /* don't */, B /* it's */", 'A = 1  , B  '],
    ['A = "/*", B, C = "*/"', 'A = "", B, C = ""'],
    [String.raw`A = 'it\'s', B // tail, C`, 'A = "", B '],
  ])('stripStringsAndComments(%s)', (input, expected) => {
    expect(stripStringsAndComments(input)).toBe(expected)
  })
})

describe('M5 trial (2026-10-26) の解析失敗への対応', () => {
  const signals = computeMaterialitySignals(fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"]))
  const sid = signals[0].id
  const base = { id: 'c1', kind: 'removes', subject: 'mechanism', mechanism: 'm', file: 'apps/api/src/x.ts' }

  it('候補の evidence は target 照合に使うので必須のまま。欠けたら欄名を返す', () => {
    const raw = JSON.stringify({ material: true, candidates: [base], signalDisposition: [{ signalId: sid, disposition: 'supports_candidate:c1', reason: '' }] })
    expect(parseDetection(raw, signals)).toEqual({ ok: false, reason: 'invalid_candidate:evidence' })
    expect(parseDetection(JSON.stringify({ material: true, candidates: [{ ...base, file: '' }], signalDisposition: [] }), signals))
      .toEqual({ ok: false, reason: 'invalid_candidate:file' })
  })

  it('評価の newOwner・所見が欠けても受け付け、判定の欄が不正な評価は欄名つきで捨てる', () => {
    const cands = [{ ...base, kind: 'removes' as const, subject: 'mechanism' as const, evidence: '' }]
    const ok = parseEvaluation(JSON.stringify({ evaluations: [{ candidateId: 'c1', responsibility: 'lost', recordConsistency: 'no_record', ceoDirectedProvenance: 'no' }] }), cands)
    expect(ok.ok && ok.value[0]).toMatchObject({ newOwner: null, correctness: '', provenanceEvidence: '' })
    const bad = { candidateId: 'c1', responsibility: 'gone', recordConsistency: 'no_record', ceoDirectedProvenance: 'no' }
    const good = { candidateId: 'c1', responsibility: 'lost', recordConsistency: 'no_record', ceoDirectedProvenance: 'no' }
    expect(parseEvaluation(JSON.stringify({ evaluations: [bad] }), cands)).toEqual({ ok: false, reason: 'no_usable_evaluation' })
    expect(parseEvaluation(JSON.stringify({ evaluations: [bad, good] }), cands)).toMatchObject({ ok: true, warnings: ['invalid_evaluation:responsibility'] })
  })

  it('解析できなかった応答は先頭だけを rawResponseExcerpt に残す', async () => {
    const diff = fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"])
    const records = { listRecordFiles: () => [], read: () => undefined }
    const raw = `{"material": true, "candidates": [{"id": "c1", "kind": "modifies"}], "signalDisposition": []}${'x'.repeat(5000)}`
    const observation = await observeDesignMateriality({ title: 't', diff, records, detectionInstructions: 'D', evaluationInstructions: 'E' }, async () => raw)
    expect(observation.reason).toBe('parse:invalid_candidate:kind')
    expect(observation.rawResponseExcerpt?.stage).toBe('detection')
    expect(observation.rawResponseExcerpt?.text.length).toBe(RAW_EXCERPT_CHARS)
  })
})

describe('M5 trial rerun (2026-10-26): subject 名の key に書かれた説明', () => {
  const signals = computeMaterialitySignals(fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"]))
  const sid = signals[0].id
  const body = (candidate: Record<string, unknown>) => JSON.stringify({
    material: true, candidates: [candidate], signalDisposition: [{ signalId: sid, disposition: 'supports_candidate:c1', reason: '' }],
  })

  it('"design_contract": "…" を mechanism として読む', () => {
    const parsed = parseDetection(body({ id: 'c1', kind: 'redefines', subject: 'design_contract', design_contract: 'Manual abort cleanup contract', file: 'f.ts', evidence: 'e' }), signals)
    expect(parsed.ok && parsed.value.candidates[0].mechanism).toBe('Manual abort cleanup contract')
  })

  it('mechanism があればそちらを優先する', () => {
    const parsed = parseDetection(body({ id: 'c1', kind: 'redefines', subject: 'authority_boundary', mechanism: 'm', authority_boundary: 'other', file: 'f.ts', evidence: 'e' }), signals)
    expect(parsed.ok && parsed.value.candidates[0].mechanism).toBe('m')
  })

  it('どちらも無ければ invalid_candidate:mechanism', () => {
    expect(parseDetection(body({ id: 'c1', kind: 'redefines', subject: 'state_transition', file: 'f.ts', evidence: 'e' }), signals))
      .toEqual({ ok: false, reason: 'invalid_candidate:mechanism' })
  })
})

it('mechanism の key があって不正な値なら、subject 名の key で救わない', () => {
  const signals = computeMaterialitySignals(fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"]))
  const raw = JSON.stringify({
    material: true,
    candidates: [{ id: 'c1', kind: 'redefines', subject: 'design_contract', mechanism: 123, design_contract: 'fallback', file: 'f.ts', evidence: 'e' }],
    signalDisposition: [{ signalId: signals[0].id, disposition: 'supports_candidate:c1', reason: '' }],
  })
  expect(parseDetection(raw, signals)).toEqual({ ok: false, reason: 'invalid_candidate:mechanism' })
})

it('introduces の候補は responsibility=introduced を受け付ける（M5 trial 2026-10-26）', () => {
  const cands = [{ id: 'c2', kind: 'introduces' as const, subject: 'mechanism' as const, mechanism: 'one-tap abort', file: 'f.ts', evidence: 'e' }]
  const parsed = parseEvaluation(JSON.stringify({ evaluations: [{ candidateId: 'c2', responsibility: 'introduced', recordConsistency: 'no_record', ceoDirectedProvenance: 'yes' }] }), cands)
  expect(parsed.ok && parsed.value[0].responsibility).toBe('introduced')
})

it('introduced を消す・替える候補に答えた評価は使わない（狭い判定から外さない。評価なしとして数える）', () => {
  const cands = [
    { id: 'c1', kind: 'removes' as const, subject: 'mechanism' as const, mechanism: 'Challenge stage', file: 'f.ts', evidence: 'e' },
    { id: 'c2', kind: 'introduces' as const, subject: 'mechanism' as const, mechanism: 'new', file: 'g.ts', evidence: 'e' },
  ]
  const parsed = parseEvaluation(JSON.stringify({ evaluations: [
    { candidateId: 'c1', responsibility: 'introduced', recordConsistency: 'consistent', ceoDirectedProvenance: 'no' },
    { candidateId: 'c2', responsibility: 'introduced', recordConsistency: 'no_record', ceoDirectedProvenance: 'no' },
  ] }), cands)
  expect(parsed).toMatchObject({ ok: true, warnings: ['introduced_for_non_addition:c1', 'unevaluated:c1'] })
  expect(parsed.ok && parsed.value.map((e) => e.candidateId)).toEqual(['c2'])
})

it('観測は parseWarnings に stage 付きで残す（M5 trial 2026-10-27: 1つの signal が2つの候補を支えた）', async () => {
  const diff = fileDiff('apps/api/src/x.ts', ["-  | 'challenge_aligned'"])
  const sid = computeMaterialitySignals(diff)[0].id
  const detection = JSON.stringify({
    material: false,
    candidates: [
      { id: 'c1', kind: 'redefines', subject: 'mechanism', mechanism: 'budget', file: 'a.ts', evidence: 'e' },
      { id: 'c2', kind: 'redefines', subject: 'state_transition', mechanism: 'stage', file: 'b.ts', evidence: 'e' },
    ],
    signalDisposition: [
      { signalId: sid, disposition: 'supports_candidate:c1', reason: '' },
      { signalId: sid, disposition: 'supports_candidate:c2', reason: '' },
    ],
  })
  const evaluation = JSON.stringify({ evaluations: [{ candidateId: 'c1', responsibility: 'moved', newOwner: 'x', recordConsistency: 'no_record', ceoDirectedProvenance: 'no' }] })
  let n = 0
  const observation = await observeDesignMateriality(
    { title: 't', diff, records: { listRecordFiles: () => [], read: () => undefined }, detectionInstructions: 'D', evaluationInstructions: 'E' },
    async () => (n++ === 0 ? detection : evaluation),
  )
  expect(observation.status).toBe('ok')
  expect(observation.detection?.material).toBe(true)
  expect(observation.parseWarnings).toEqual(['detection:material_mismatch', 'evaluation:unevaluated:c2'])
})
