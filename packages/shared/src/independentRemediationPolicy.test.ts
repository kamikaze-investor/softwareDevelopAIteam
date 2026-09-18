import { describe, expect, it } from 'vitest'
import {
  FLAGSHIP_REMEDIATION_CANDIDATES,
  extractDesignReviewFindings,
  isMateriallyDifferentSpec,
  parseRemediationProposal,
  selectRemediationModel,
} from './independentRemediationPolicy'

/**
 * ここで固定しているのは3つである。
 *   1. Remediation は**軽量モデルへ落ちない**
 *   2. 自分の提案を自分で審査する構成にならない（vendor 分離）
 *   3. 検討していない提案（safetyImpact 欠落等）を検討済みとして通さない
 */

describe('FLAGSHIP_REMEDIATION_CANDIDATES', () => {
  it('flagship 以外を候補に持たない（弱い model への降格経路が存在しない）', () => {
    // 候補表そのものが「選べる集合」なので、ここに軽量 model が無い限り
    // `selectRemediationModel()` は軽量 model を返せない。
    const models = FLAGSHIP_REMEDIATION_CANDIDATES.map((candidate) => candidate.model)

    expect(models).toEqual(['gpt-5.6-sol', 'claude-opus-5'])
  })

  it('候補はすべて vendor を解決できる provider である（未知 vendor は分離の根拠にできない）', () => {
    for (const candidate of FLAGSHIP_REMEDIATION_CANDIDATES) {
      expect(['codex', 'claude_code']).toContain(candidate.provider)
    }
  })

  it('model を持たない候補が混ざらない（CLI 既定モデルへ落ちると flagship 保証が消える）', () => {
    for (const candidate of FLAGSHIP_REMEDIATION_CANDIDATES) {
      expect(candidate.model.trim()).not.toBe('')
    }
  })
})

describe('selectRemediationModel', () => {
  it('judge が Gemini だけなら OpenAI flagship を選ぶ（既定の CONFLICT ケース）', () => {
    // 初回 implement の Design Review は `changedFiles: []` = medium load なので
    // Codex independent review は要求されない。したがって Codex が judge と衝突しない。
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.provider).toBe('codex')
    expect(selection.candidate.model).toBe('gpt-5.6-sol')
    expect(selection.vendor).toBe('openai')
  })

  it('judge に Codex が入る（critical load）なら Anthropic flagship へ切り替える', () => {
    // ここを切り替えないと、Codex が書いた提案を Codex independent review が審査する
    // = 自己承認になる。**判定側と提案側が同一 vendor になってはならない。**
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go'],
      judgeProviders: ['gemini', 'codex'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.provider).toBe('claude_code')
    expect(selection.vendor).toBe('anthropic')
  })

  it('著者が Claude 系なら OpenAI 側を選ぶ（元設計者と vendor を分ける）', () => {
    const selection = selectRemediationModel({
      authorProviders: ['claude_code'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.vendor).toBe('openai')
  })

  it('著者が OpenAI 系なら Claude 側を選ぶ', () => {
    const selection = selectRemediationModel({
      authorProviders: ['codex'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.model).toBe('claude-opus-5')
    expect(selection.vendor).toBe('anthropic')
  })

  it('独立した flagship が無ければ ok:false。**弱い model へ落ちない**', () => {
    // 両 vendor が除外されたとき、3番目の軽量候補へ降格しない。呼び出し側は
    // 既存の CEO Escalation 経路へ進む（待機 / 別 vendor / Escalation のうち Escalation）。
    const selection = selectRemediationModel({
      authorProviders: ['claude_code'],
      judgeProviders: ['codex'],
    })

    expect(selection.ok).toBe(false)
    if (selection.ok) return
    expect(selection.excludedVendors).toEqual(['anthropic', 'openai'])
  })

  it('既に失敗した provider は再試行せず、別 flagship vendor へ回す', () => {
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go'],
      judgeProviders: ['gemini'],
      exhaustedProviders: ['codex'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.provider).toBe('claude_code')
  })

  it('**vendor が解決できなくても、model 単位の分離は必ず効く**', () => {
    // round 1 の著者（PL）は harness なので vendor を解決できない。それでも
    // 「元の設計者と同一 model へ戻さない」ことは常に強制できる —— 要求の核はそこであり、
    // vendor 解決の成否に依存させてはならない。
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go'],
      authorModels: ['gpt-5.6-sol'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.candidate.model).toBe('claude-opus-5')
  })

  it('候補が全部 author model と同一なら ok:false（別 model へ勝手に広げない）', () => {
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go'],
      authorModels: ['gpt-5.6-sol', 'claude-opus-5'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(false)
  })

  it('vendor を解決できない著者は「分離済み」と主張せず unresolvedAuthors に残す', () => {
    // PL の提案は opencode-go（harness）が書いており、underlying vendor を特定できない。
    // 除外に使えないので、**確認できていないことを記録として残す**。
    const selection = selectRemediationModel({
      authorProviders: ['opencode-go', 'copilot'],
      judgeProviders: ['gemini'],
    })

    expect(selection.ok).toBe(true)
    if (!selection.ok) return
    expect(selection.unresolvedAuthors).toEqual(['opencode-go', 'copilot'])
    // 未知の著者は除外集合へ入らない（入れられない）。
    expect(selection.excludedVendors).toEqual(['google'])
  })
})

describe('isMateriallyDifferentSpec', () => {
  const REJECTED = {
    implementationScope: '広い scope',
    allowedPaths: ['apps/api/src', 'packages/shared/src'],
    acceptanceCriteria: ['typecheck が通る', 'test が通る'],
  }

  it('同一の spec は「違う」と言わない', () => {
    expect(isMateriallyDifferentSpec(REJECTED, { ...REJECTED })).toBe(false)
  })

  it('空白・大小・宣言順の違いだけでは「違う」と言わない', () => {
    // **ここが hash 比較では守れない部分。** 表現だけ変えた実質無変更の提案を、
    // 判定の揺れを狙った再提出として拒否できなければならない。
    expect(isMateriallyDifferentSpec(REJECTED, {
      implementationScope: '  広い   SCOPE ',
      allowedPaths: ['packages/shared/src', 'APPS/API/SRC'],
      acceptanceCriteria: ['test が通る', 'typecheck が通る'],
    })).toBe(false)
  })

  it('scope / allowedPaths / acceptanceCriteria のどれかが変われば「違う」', () => {
    expect(isMateriallyDifferentSpec(REJECTED, { ...REJECTED, implementationScope: '狭い scope' })).toBe(true)
    expect(isMateriallyDifferentSpec(REJECTED, { ...REJECTED, allowedPaths: ['apps/api/src/storage'] })).toBe(true)
    expect(isMateriallyDifferentSpec(REJECTED, { ...REJECTED, acceptanceCriteria: ['別の条件'] })).toBe(true)
  })

  it('scope 未指定だった Task からの変更も検出できる', () => {
    const noScope = { ...REJECTED, implementationScope: '' }

    expect(isMateriallyDifferentSpec(noScope, { ...REJECTED, implementationScope: '明示した scope' })).toBe(true)
  })
})

describe('extractDesignReviewFindings', () => {
  it('ALIGNED でない工程だけを Finding として返す', () => {
    const findings = extractDesignReviewFindings(JSON.stringify({
      focusedReviewResults: [
        { focus: 'safety_authority', decision: 'ALIGNED', summary: '問題なし' },
        {
          focus: 'scope_simplicity',
          decision: 'CONFLICT',
          summary: 'より軽い代替がある',
          findings: [{ message: 'path 正規化層は複雑すぎる' }],
        },
      ],
      finalDecision: 'CONFLICT',
    }))

    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      source: 'scope_simplicity',
      decision: 'CONFLICT',
      summary: 'より軽い代替がある',
      messages: ['path 正規化層は複雑すぎる'],
    })
  })

  it('integration / independent の非 ALIGNED も拾う', () => {
    const findings = extractDesignReviewFindings(JSON.stringify({
      focusedReviewResults: [],
      integrationReviewResult: { decision: 'UNCERTAIN', summary: '統合の観点で不明' },
      independentReviewResult: { verdict: 'blocking', summary: '権限拡大の疑い' },
    }))

    expect(findings.map((finding) => finding.source)).toEqual(['integration', 'independent'])
    expect(findings[1]?.decision).toBe('blocking')
  })

  it('independent が unavailable のときも Finding として残す', () => {
    const findings = extractDesignReviewFindings(JSON.stringify({
      focusedReviewResults: [],
      independentReviewResult: { unavailable: true, summary: 'provider 障害' },
    }))

    expect(findings[0]?.decision).toBe('unavailable')
  })

  it('壊れた JSON / 未指定では空配列（例外を投げない）', () => {
    expect(extractDesignReviewFindings('not json')).toEqual([])
    expect(extractDesignReviewFindings(undefined)).toEqual([])
    expect(extractDesignReviewFindings('[]')).toEqual([])
  })
})

describe('parseRemediationProposal', () => {
  const COMPLETE = {
    diagnosis: 'scope が広すぎた',
    resolution: '既存 validation の1箇所へ寄せる',
    implementationScope: 'validateRoadmapTasks の絶対パス検査だけ',
    allowedPaths: ['apps/api/src/storage'],
    acceptanceCriteria: ['絶対パスを含む allowedPaths が SPEC_INVALID で拒否される'],
    whyResolved: 'scope_simplicity の指摘どおり新しい層を作らない',
    safetyImpact: 'Guard も Gate も変更しないため Safety Boundary は不変',
    unresolvedConcerns: [],
    abandon: false,
  }

  it('完全な提案を受理する', () => {
    const proposal = parseRemediationProposal(JSON.stringify(COMPLETE))

    expect(proposal?.implementationScope).toBe(COMPLETE.implementationScope)
    expect(proposal?.abandon).toBe(false)
  })

  it('```json フェンス付きでも読める', () => {
    const proposal = parseRemediationProposal(`ここまで前置き\n\`\`\`json\n${JSON.stringify(COMPLETE)}\n\`\`\``)

    expect(proposal?.allowedPaths).toEqual(['apps/api/src/storage'])
  })

  it('safetyImpact が無い提案は拒否する（未検討を検討済みにしない）', () => {
    const { safetyImpact: _omitted, ...without } = COMPLETE

    expect(parseRemediationProposal(JSON.stringify(without))).toBeUndefined()
  })

  it('whyResolved が無い提案は拒否する（Finding へ答えていない）', () => {
    const { whyResolved: _omitted, ...without } = COMPLETE

    expect(parseRemediationProposal(JSON.stringify(without))).toBeUndefined()
  })

  it('unresolvedConcerns の欠落は拒否するが、空配列は受理する', () => {
    const { unresolvedConcerns: _omitted, ...without } = COMPLETE

    expect(parseRemediationProposal(JSON.stringify(without))).toBeUndefined()
    expect(parseRemediationProposal(JSON.stringify({ ...COMPLETE, unresolvedConcerns: [] }))).toBeDefined()
  })

  it('allowedPaths / acceptanceCriteria が空配列の提案は拒否する', () => {
    expect(parseRemediationProposal(JSON.stringify({ ...COMPLETE, allowedPaths: [] }))).toBeUndefined()
    expect(parseRemediationProposal(JSON.stringify({ ...COMPLETE, acceptanceCriteria: [] }))).toBeUndefined()
  })

  it('abandon:true のときは実装 spec を要求しない（作らせても使わない）', () => {
    const proposal = parseRemediationProposal(JSON.stringify({
      diagnosis: 'この項目は前提が崩れている',
      resolution: '現状のまま実装すべきでない',
      whyResolved: 'Finding は scope ではなく前提を否定している',
      safetyImpact: '何も変更しないので影響なし',
      unresolvedConcerns: ['ledger 本文の更新は CEO 判断'],
      abandon: true,
    }))

    expect(proposal?.abandon).toBe(true)
    expect(proposal?.allowedPaths).toEqual([])
  })

  it('JSON が無い応答は拒否する', () => {
    expect(parseRemediationProposal('修正案はありません')).toBeUndefined()
  })
})
