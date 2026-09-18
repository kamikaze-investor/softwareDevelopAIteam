import { describe, expect, it } from 'vitest'
import {
  DISPUTE_GROUNDS,
  FINDING_ASSESSMENT_STATUSES,
  bindingDisputes,
  challengeableDisputes,
  disputedFindings,
  isBindingSafetySource,
  parseCritique,
  shouldChallengeFinding,
} from './independentCriticPolicy'

/**
 * ここで固定しているのは Critic の**役割の境界**である。
 *   1. Critic は Task Spec を書けない（出力に Spec の欄が無い）
 *   2. Critic は formal verdict を持たない（PASS/CONFLICT を返せない）
 *   3. Review Finding を正しい前提にせず評価できる
 *   4. **根拠の無い疑義で Review validity challenge を起こさない**
 */

const COMPLETE = {
  coreProblems: ['採用時の scope が ledger 本文全体を指しており、対象が絞られていない'],
  findingAssessments: [
    { source: 'scope_simplicity', status: 'supported', rationale: 'より軽い代替が実在する' },
  ],
  hiddenRisks: ['allowedPaths が広いので別サブ項目まで触れる'],
  constraintsToPreserve: ['File Change Guard の保護範囲'],
  improvementDirections: ['既存 validation へ1件足す形に絞る'],
  thingsNotToChange: ['ledger 本文'],
  uncertainties: [],
}

describe('Critic の出力に Task Spec を書く手段が無い', () => {
  it('Critique には implementationScope / allowedPaths / acceptanceCriteria が無い', () => {
    // **mutation authority を持たない**という役割定義を型で担保する。
    // ここに Spec の形があると「Critic が書いたものがそのまま Spec になる」経路ができる。
    const critique = parseCritique(JSON.stringify(COMPLETE))

    expect(critique).toBeDefined()
    expect(critique).not.toHaveProperty('implementationScope')
    expect(critique).not.toHaveProperty('allowedPaths')
    expect(critique).not.toHaveProperty('acceptanceCriteria')
  })

  it('Task Spec の欄を混ぜても無視される（受理しても Spec は生えない）', () => {
    const critique = parseCritique(JSON.stringify({
      ...COMPLETE,
      implementationScope: 'Critic が勝手に書いた scope',
      allowedPaths: ['apps/api/src'],
    }))

    expect(critique).toBeDefined()
    expect(critique).not.toHaveProperty('implementationScope')
    expect(critique).not.toHaveProperty('allowedPaths')
  })
})

describe('Critic に formal verdict authority が無い', () => {
  it('Critique には decision / verdict / PASS 相当の欄が無い', () => {
    const critique = parseCritique(JSON.stringify({
      ...COMPLETE,
      decision: 'ALIGNED',
      verdict: 'approved',
      finalDecision: 'ALIGNED',
    }))

    expect(critique).toBeDefined()
    expect(critique).not.toHaveProperty('decision')
    expect(critique).not.toHaveProperty('verdict')
    expect(critique).not.toHaveProperty('finalDecision')
  })

  it('status 語彙に PASS / ALIGNED のような判定値が含まれない', () => {
    // 評価語彙は Finding の妥当性についてのものだけで、Review の判定語彙とは別である。
    expect(FINDING_ASSESSMENT_STATUSES).toEqual([
      'supported', 'partially_supported', 'disputed', 'insufficient_evidence',
    ])
    expect(FINDING_ASSESSMENT_STATUSES as readonly string[]).not.toContain('ALIGNED')
    expect(FINDING_ASSESSMENT_STATUSES as readonly string[]).not.toContain('CONFLICT')
  })
})

describe('Review Finding の評価', () => {
  it('supported / partially_supported / disputed / insufficient_evidence を表せる', () => {
    for (const status of FINDING_ASSESSMENT_STATUSES) {
      const assessment = status === 'disputed'
        ? { source: 'f', status, rationale: 'r', grounds: 'wrong_premise', evidence: 'e' }
        : { source: 'f', status, rationale: 'r' }
      const critique = parseCritique(JSON.stringify({ ...COMPLETE, findingAssessments: [assessment] }))

      expect(critique?.findingAssessments[0]?.status).toBe(status)
    }
  })

  it('Finding とは独立に hidden risk を提示できる', () => {
    const critique = parseCritique(JSON.stringify({
      ...COMPLETE,
      hiddenRisks: ['Reviewer が見ていない別の問題', 'もう1つ'],
    }))

    expect(critique?.hiddenRisks).toHaveLength(2)
  })

  it('findingAssessments が空なら受理しない（Finding を評価していない）', () => {
    expect(parseCritique(JSON.stringify({ ...COMPLETE, findingAssessments: [] }))).toBeUndefined()
  })

  it('1件でも壊れていれば全体を受理しない（評価漏れを評価済みと誤認しない）', () => {
    const critique = parseCritique(JSON.stringify({
      ...COMPLETE,
      findingAssessments: [
        { source: 'a', status: 'supported', rationale: 'r' },
        { source: 'b', status: 'not_a_real_status', rationale: 'r' },
      ],
    }))

    expect(critique).toBeUndefined()
  })

  it('coreProblems / improvementDirections が空なら受理しない', () => {
    expect(parseCritique(JSON.stringify({ ...COMPLETE, coreProblems: [] }))).toBeUndefined()
    expect(parseCritique(JSON.stringify({ ...COMPLETE, improvementDirections: [] }))).toBeUndefined()
  })

  it('constraintsToPreserve / uncertainties の欠落は受理しない（空配列は可）', () => {
    const { constraintsToPreserve: _c, ...noConstraints } = COMPLETE
    const { uncertainties: _u, ...noUncertainties } = COMPLETE

    expect(parseCritique(JSON.stringify(noConstraints))).toBeUndefined()
    expect(parseCritique(JSON.stringify(noUncertainties))).toBeUndefined()
    expect(parseCritique(JSON.stringify({ ...COMPLETE, uncertainties: [] }))).toBeDefined()
  })
})

describe('Review validity challenge の発火条件', () => {
  const disputeWith = (over: Record<string, unknown>) => parseCritique(JSON.stringify({
    ...COMPLETE,
    findingAssessments: [{
      source: 'scope_simplicity',
      status: 'disputed',
      rationale: 'Finding は成立しない',
      ...over,
    }],
  }))

  it('grounds と evidence が揃った dispute は challenge を起こす', () => {
    const critique = disputeWith({
      grounds: 'contradicts_code_or_spec',
      evidence: 'validateRoadmapTasks が既に同じ検査をしている',
    })

    expect(critique).toBeDefined()
    expect(shouldChallengeFinding(critique!)).toBe(true)
    expect(disputedFindings(critique!)).toHaveLength(1)
  })

  it('列挙された4種の grounds すべてで challenge できる', () => {
    for (const grounds of DISPUTE_GROUNDS) {
      const critique = disputeWith({ grounds, evidence: '具体的な裏付け' })

      expect(shouldChallengeFinding(critique!)).toBe(true)
    }
  })

  it('**単なる不確実性では challenge しない**（insufficient_evidence）', () => {
    const critique = parseCritique(JSON.stringify({
      ...COMPLETE,
      findingAssessments: [
        { source: 'f', status: 'insufficient_evidence', rationale: '判断材料が足りない' },
      ],
    }))

    expect(shouldChallengeFinding(critique!)).toBe(false)
  })

  it('**「別の考え方もある」だけでは challenge しない**（grounds 無しの dispute）', () => {
    // 根拠の種類を明示しない疑義は `insufficient_evidence` へ落ちる。
    // challenge は frozen spec への追加 formal review を1回消費するので、
    // 発火条件は列挙値で縛る。
    const critique = disputeWith({ evidence: '別の考え方もあると思う' })

    expect(critique?.findingAssessments[0]?.status).toBe('insufficient_evidence')
    expect(shouldChallengeFinding(critique!)).toBe(false)
  })

  it('evidence の無い dispute では challenge しない', () => {
    const critique = disputeWith({ grounds: 'wrong_premise' })

    expect(critique?.findingAssessments[0]?.status).toBe('insufficient_evidence')
    expect(shouldChallengeFinding(critique!)).toBe(false)
  })

  it('未知の grounds 値では challenge しない', () => {
    const critique = disputeWith({ grounds: 'i_just_disagree', evidence: 'e' })

    expect(critique?.findingAssessments[0]?.status).toBe('insufficient_evidence')
    expect(shouldChallengeFinding(critique!)).toBe(false)
  })

  it('supported だけの Critique では challenge しない（通常の PL revision へ進む）', () => {
    const critique = parseCritique(JSON.stringify(COMPLETE))

    expect(shouldChallengeFinding(critique!)).toBe(false)
  })

  it('根拠の無い dispute でも Critique 全体は使える（PL への助言は残す）', () => {
    // `disputed` を落とすのは challenge を起こさないためであって、
    // 根本原因・隠れたリスク・改善方向は PL にとって有用なので捨てない。
    const critique = disputeWith({})

    expect(critique?.coreProblems).toHaveLength(1)
    expect(critique?.improvementDirections).toHaveLength(1)
  })
})

describe('Binding Safety / Authority は Challenge では解除されない', () => {
  const disputeOn = (source: string) => parseCritique(JSON.stringify({
    ...COMPLETE,
    findingAssessments: [{
      source,
      status: 'disputed',
      rationale: 'この Finding は成立しない',
      grounds: 'contradicts_code_or_spec',
      evidence: '該当コードは既にその条件を満たしている',
    }],
  }))

  it('safety_recovery / auth_permission / data_state_integrity は Challenge しない', () => {
    // Safety Boundary / Authority / 不可逆性の争いは、1回の Challenge では解除しない。
    // 既存方針（Second Independent Review → Meta Review → CEO）へ渡す。
    for (const source of ['safety_recovery', 'auth_permission', 'data_state_integrity']) {
      const critique = disputeOn(source)

      expect(isBindingSafetySource(source)).toBe(true)
      expect(shouldChallengeFinding(critique!)).toBe(false)
      expect(bindingDisputes(critique!)).toHaveLength(1)
    }
  })

  it('independent（critical の Binding Safety Review）も Challenge しない', () => {
    const critique = disputeOn('independent')

    expect(shouldChallengeFinding(critique!)).toBe(false)
    expect(bindingDisputes(critique!)).toHaveLength(1)
  })

  it('advisory な設計論点は Challenge できる', () => {
    for (const source of ['scope_simplicity', 'architecture_responsibility', 'operations']) {
      const critique = disputeOn(source)

      expect(isBindingSafetySource(source)).toBe(false)
      expect(shouldChallengeFinding(critique!)).toBe(true)
    }
  })

  it('**未知の source は binding 扱い**（fail-closed）', () => {
    // 知らない指摘を「advisory だから1回で覆せる」側へ倒してはならない。
    expect(isBindingSafetySource('some_future_focus')).toBe(true)
    expect(shouldChallengeFinding(disputeOn('some_future_focus')!)).toBe(false)
  })

  it('binding と advisory が混在するとき、advisory だけが challengeable', () => {
    const critique = parseCritique(JSON.stringify({
      ...COMPLETE,
      findingAssessments: [
        {
          source: 'safety_recovery', status: 'disputed', rationale: 'r',
          grounds: 'wrong_premise', evidence: 'e',
        },
        {
          source: 'scope_simplicity', status: 'disputed', rationale: 'r',
          grounds: 'wrong_premise', evidence: 'e',
        },
      ],
    }))

    expect(challengeableDisputes(critique!).map((a) => a.source)).toEqual(['scope_simplicity'])
    expect(bindingDisputes(critique!).map((a) => a.source)).toEqual(['safety_recovery'])
  })
})

describe('parseCritique の頑健性', () => {
  it('```json フェンス付きでも読める', () => {
    const critique = parseCritique(`前置き\n\`\`\`json\n${JSON.stringify(COMPLETE)}\n\`\`\``)

    expect(critique?.coreProblems).toHaveLength(1)
  })

  it('JSON が無い応答は拒否する', () => {
    expect(parseCritique('特に問題ありません')).toBeUndefined()
  })
})
