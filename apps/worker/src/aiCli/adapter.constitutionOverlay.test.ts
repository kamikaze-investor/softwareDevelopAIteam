import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Implementation Agent（provider非依存）へ Constitution 3.14〜3.15 が届くことの検証。
 *
 * Context Pack は Worker へ未配線で、Implementation Agent の入力は job.aiCliPrompt である。
 * そのため adapter が Policy overlay として前置しない限り共通行動原則は届かない。
 *
 * dryRun は最終プロンプトを返さないため、実際に CLI へ渡される内容
 * （argv または stdin）を execFileSync のモックで捕捉して検証する。
 */

const SECTION_HEAD = '## 3.14 Minimum Sufficient Validation'
const SECTION_HEAD_2 = '## 3.15 Autonomous Judgment'
const SECTION_BODY = 'CEO確認は、原則として次の場合に限る'
const CLAUDE_MD_BLOCK = 'システム制約（最優先・必読）'
const ORIGINAL_PROMPT = 'READMEへharmlessな1行を追記してください。'

const execFileSyncMock = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}))

/** CLI へ実際に渡されたプロンプト（argv または stdin）を返す。 */
async function capturePrompt(provider: 'claude_code' | 'codex'): Promise<string> {
  execFileSyncMock.mockReset()
  execFileSyncMock.mockReturnValue('done')

  const { createAiCliAdapter } = await import('./factory.js')
  const { TARGET_ROOT } = await import('../utils/pathUtils.js')

  const adapter = createAiCliAdapter({ provider })
  try {
    await adapter.run({
      taskId: 'task-constitution-overlay',
      provider,
      workingDir: TARGET_ROOT,
      prompt: ORIGINAL_PROMPT,
      contextFiles: [],
      mode: 'implement',
    })
  } catch {
    // CLI呼び出し後の変更検出はローカル環境に /workspace/target が無いため失敗する。
    // ここで検証したいのは「CLIへ渡されたプロンプト」なので、実行後の失敗は無視する。
  }

  expect(execFileSyncMock).toHaveBeenCalled()

  // calls[0] を決め打ちしない。codexPathResolver が実行前に `which codex` /
  // `codex --version` で execFileSync を呼ぶため、OSによって先頭callが変わる
  // （Linux CIでは解決用callがcalls[0]になり、プロンプトを含まない）。
  // 実装ではなくテストの前提がplatform依存だったので、
  // 「実際にプロンプトを載せたcall」を全callから探す形にする。
  const calls = execFileSyncMock.mock.calls as Array<[string, string[], { input?: string }]>
  const texts = calls.map((call) => {
    const argvText = (call[1] ?? []).join('\n')
    const stdinText = call[2]?.input ?? ''
    return `${argvText}\n${stdinText}`
  })

  const promptCall = texts.find((text) => text.includes(ORIGINAL_PROMPT))
  if (promptCall !== undefined) return promptCall

  // Constitution本文を取得できなかったケースの検証では ORIGINAL_PROMPT を含む call が
  // 無いこともあるため、最後のcall（＝実際のCLI実行）へfallbackする。
  return texts[texts.length - 1] ?? ''
}

describe('Constitution overlay は Implementation Agent の全providerへ届く', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('claude_code の最終プロンプトに 3.14〜3.15 の本文が含まれる', async () => {
    const prompt = await capturePrompt('claude_code')

    expect(prompt).toContain(SECTION_HEAD)
    expect(prompt).toContain(SECTION_HEAD_2)
    expect(prompt).toContain(SECTION_BODY)
  })

  it('codex の最終プロンプトに 3.14〜3.15 の本文が含まれる', async () => {
    const prompt = await capturePrompt('codex')

    expect(prompt).toContain(SECTION_HEAD)
    expect(prompt).toContain(SECTION_HEAD_2)
    expect(prompt).toContain(SECTION_BODY)
  })

  it('codex でも Constitution 本文が二重注入されない', async () => {
    const prompt = await capturePrompt('codex')

    expect(prompt.split(SECTION_HEAD).length - 1).toBe(1)
  })

  it('既存の CLAUDE.md 注入挙動（codexのみ）が維持されている', async () => {
    const codexPrompt = await capturePrompt('codex')
    const claudeCodePrompt = await capturePrompt('claude_code')

    expect(codexPrompt).toContain(CLAUDE_MD_BLOCK)
    expect(claudeCodePrompt).not.toContain(CLAUDE_MD_BLOCK)
  })

  it('元の aiCliPrompt は書き換えられず、最終プロンプトへ保持される', async () => {
    const prompt = await capturePrompt('claude_code')

    expect(prompt).toContain(ORIGINAL_PROMPT)
  })
})

describe('Constitution 本文を取得できない場合', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('黙って省略せず、未取得であることが最終プロンプトから分かる', async () => {
    vi.doMock('@ai-team/shared/src/constitutionPrinciples.js', () => ({
      loadConstitutionPrinciples: () => ({
        ok: false as const,
        reason: 'forced failure for test',
        triedPaths: ['/nonexistent/00_constitution.md'],
      }),
      buildConstitutionPrinciplesPrompt: () =>
        '【注意】AI Team OS共通行動原則の本文を取得できませんでした。',
      formatConstitutionPrinciplesWarning: () =>
        '[constitution] 本文を取得できませんでした: forced failure for test',
    }))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prompt = await capturePrompt('claude_code')

    expect(prompt).toContain('取得できませんでした')
    expect(prompt).not.toContain(SECTION_HEAD)
    expect(warnSpy).toHaveBeenCalled()
  })
})
