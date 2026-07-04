import { describe, expect, it } from 'vitest'
import {
  formatFinalReviewPacketMarkdown,
  generateFinalReviewPacket,
} from './finalReviewPacket.js'
import type { FinalReviewPacketInput } from './finalReviewPacket.js'

function makeInput(overrides: Partial<FinalReviewPacketInput> = {}): FinalReviewPacketInput {
  return {
    jobId: 'job-1',
    taskId: 'task-1',
    whatWasDone: 'テスト用の変更を行った',
    whyNeeded: 'テストのため',
    scope: 'ファイルAのみ',
    notChanged: 'ファイルBは変更していない',
    reviewLevel: 1,
    safetyChecklist: [
      { id: 'DB_CHANGE', present: false, detail: 'なし' },
      { id: 'AUTH_PERMISSION_CHANGE', present: false, detail: 'なし' },
      { id: 'SECURITY_CHANGE', present: false, detail: 'なし' },
      { id: 'EXTERNAL_SERVICE_ADDED', present: false, detail: 'なし' },
      { id: 'BILLING_IMPACT', present: false, detail: 'なし' },
      { id: 'PRODUCTION_IMPACT', present: false, detail: 'なし' },
      { id: 'PACKAGE_LOCKFILE_CHANGE', present: false, detail: 'なし' },
      { id: 'BREAKING_CHANGE', present: false, detail: 'なし' },
    ],
    verificationResults: [
      { kind: 'test', status: 'done', detail: '全件パス' },
      { kind: 'typecheck', status: 'done', detail: 'エラーなし' },
      { kind: 'build', status: 'not_required', detail: 'このタスクでは不要' },
      { kind: 'lint', status: 'not_run', detail: '今回は未実行' },
    ],
    geminiReviewResults: [
      { kind: 'risk_review', status: 'not_run', summary: 'Level1のため未実行' },
      { kind: 'alignment_review', status: 'not_required', summary: 'このケースでは対象外' },
      { kind: 'meta_review', status: 'pending', summary: 'PR作成後に実行予定' },
      { kind: 'pre_review', status: 'not_required', summary: 'mechanical_onlyのため不要' },
      { kind: 'post_review', status: 'done', summary: 'approved' },
    ],
    chatGptReviewNeeded: { needed: false, reason: 'Level1のため不要' },
    humanCeoJudgementNeeded: { needed: false, reason: 'Level1のため不要' },
    conclusion: 'commit_ok',
    targetFiles: ['docs/example.md'],
    commitMessageDraft: 'docs: example change',
    untrackedFilesHandling: '未追跡ファイルはなし',
    nextMinimalAction: '特になし',
    ...overrides,
  }
}

describe('generateFinalReviewPacket', () => {
  it('入力をそのまま集約し、generatedAtを付与する', () => {
    const input = makeInput()
    const packet = generateFinalReviewPacket(input)

    expect(packet.jobId).toBe(input.jobId)
    expect(packet.taskId).toBe(input.taskId)
    expect(packet.whatWasDone).toBe(input.whatWasDone)
    expect(packet.reviewLevel).toBe(1)
    expect(packet.conclusion).toBe('commit_ok')
    expect(typeof packet.generatedAt).toBe('string')
    expect(() => new Date(packet.generatedAt).toISOString()).not.toThrow()
  })

  it('リスク判定やコミット可否判定を新たに行わない（入力のconclusionをそのまま保持する）', () => {
    const input = makeInput({ conclusion: 'stop' })
    const packet = generateFinalReviewPacket(input)

    expect(packet.conclusion).toBe('stop')
  })

  it('未実行・未接続・実行待ちの項目をnot_run/not_required/pendingとして保持する（空欄にしない）', () => {
    const input = makeInput()
    const packet = generateFinalReviewPacket(input)

    const riskReview = packet.geminiReviewResults.find((item) => item.kind === 'risk_review')
    const alignmentReview = packet.geminiReviewResults.find(
      (item) => item.kind === 'alignment_review',
    )
    const metaReview = packet.geminiReviewResults.find((item) => item.kind === 'meta_review')

    expect(riskReview?.status).toBe('not_run')
    expect(alignmentReview?.status).toBe('not_required')
    expect(metaReview?.status).toBe('pending')
  })
})

describe('formatFinalReviewPacketMarkdown', () => {
  it('結論を先頭に出し、15項目すべてを含むMarkdownを生成する', () => {
    const packet = generateFinalReviewPacket(makeInput())
    const markdown = formatFinalReviewPacketMarkdown(packet)

    const conclusionIndex = markdown.indexOf('## 結論')
    const item1Index = markdown.indexOf('## 1. 今回やったこと')
    expect(conclusionIndex).toBeGreaterThanOrEqual(0)
    expect(item1Index).toBeGreaterThan(conclusionIndex)

    for (const heading of [
      '## 1. 今回やったこと',
      '## 2. なぜ必要だったか',
      '## 3. どこまで変えたか',
      '## 4. 変えていない重要部分',
      '## 5. Review Level',
      '## 6. 安全面チェック',
      '## 7. 検証結果',
      '## 8. Geminiレビュー結果',
      '## 9. ChatGPTレビューが必要か',
      '## 10. Human / CEO判断が必要か',
      '## 11. コミットしてよいか',
      '## 12. 対象ファイル',
      '## 13. コミットメッセージ案',
      '## 14. 未追跡ファイル・対象外ファイルの扱い',
      '## 15. 次にやるべき最小アクション',
    ]) {
      expect(markdown).toContain(heading)
    }
  })

  it('未実行・未接続の項目を空欄ではなく状態ラベルとして出力する', () => {
    const packet = generateFinalReviewPacket(makeInput())
    const markdown = formatFinalReviewPacketMarkdown(packet)

    expect(markdown).toContain('未実行')
    expect(markdown).toContain('不要（対象外）')
    expect(markdown).toContain('実行待ち')
  })

  it('結論ラベルを日本語の平易な文章で出力する', () => {
    const packet = generateFinalReviewPacket(makeInput({ conclusion: 'commit_ok' }))
    const markdown = formatFinalReviewPacketMarkdown(packet)

    expect(markdown).toContain('このままコミットして問題ありません')
  })
})
