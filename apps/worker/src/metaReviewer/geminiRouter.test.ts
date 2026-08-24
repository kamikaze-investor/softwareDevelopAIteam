/**
 * geminiRouter テスト
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * spawnSync と callGeminiForReview をモックして
 * フォールバック挙動を検証する。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

// node:child_process をモック
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

// geminiClient をモック
vi.mock('./geminiClient.js', () => ({
  callGeminiForReview: vi.fn(),
}))

// node:fs をモック（quota-exhausted.json の書き込み検証用）
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
import { callGeminiForReview } from './geminiClient.js'
import { writeFileSync } from 'node:fs'
import { callGeminiWithFallback } from './geminiRouter.js'

const mockSpawnSync = vi.mocked(spawnSync)
const mockCallApi = vi.mocked(callGeminiForReview)
const mockWriteFileSync = vi.mocked(writeFileSync)

/** CLI が成功したときの spawnSync 戻り値 */
function cliSuccess(stdout: string): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
}

/** CLI が 429 を返したときの spawnSync 戻り値 */
function cli429(): ReturnType<typeof spawnSync> {
  return { status: 1, stdout: 'error 429 quota exceeded', stderr: '', pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
}

/** CLI がプロセスエラー（exit code != 0）のとき */
function cliError(): ReturnType<typeof spawnSync> {
  return { status: 1, stdout: '', stderr: 'unknown error', pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('callGeminiWithFallback', () => {
  describe('preferCli: true（CLI優先）', () => {
    it('CLI 成功 → CLI の結果が返る', async () => {
      mockSpawnSync.mockReturnValue(cliSuccess('CLI response text'))

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: true,
        cliModel: 'gemini-3.1-flash-lite',
        featureName: 'test',
      })

      expect(result).toBe('CLI response text')
      expect(mockCallApi).not.toHaveBeenCalled()
    })

    it('CLI 429 → API にフォールバックして API の結果が返る', async () => {
      mockSpawnSync.mockReturnValue(cli429())
      mockCallApi.mockResolvedValue('API response text')

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: true,
        cliModel: 'gemini-3.1-flash-lite',
        apiModel: 'gemini-3.1-flash-lite',
        featureName: 'test',
      })

      expect(result).toBe('API response text')
      expect(mockSpawnSync).toHaveBeenCalledOnce()
      expect(mockCallApi).toHaveBeenCalledOnce()
    })

    it('両方 429 → エラーがスローされる + quota-exhausted.json が書かれる', async () => {
      mockSpawnSync.mockReturnValue(cli429())
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))

      await expect(
        callGeminiWithFallback('test prompt', {
          preferCli: true,
          featureName: 'alignment_check',
        })
      ).rejects.toThrow('quota exhausted')

      expect(mockWriteFileSync).toHaveBeenCalledOnce()
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
      expect(written.featureName).toBe('alignment_check')
      expect(written.apiExhausted).toBe(true)
      expect(written.cliExhausted).toBe(true)
      expect(written.exhaustedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('preferCli: false（API優先・デフォルト）', () => {
    it('API 成功 → API の結果が返る', async () => {
      mockCallApi.mockResolvedValue('API response text')

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: false,
        apiModel: 'gemini-3.5-flash',
        featureName: 'test',
      })

      expect(result).toBe('API response text')
      expect(mockSpawnSync).not.toHaveBeenCalled()
    })

    it('API 429 → CLI にフォールバックして CLI の結果が返る', async () => {
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))
      mockSpawnSync.mockReturnValue(cliSuccess('CLI fallback response'))

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: false,
        cliModel: 'gemini-3.5-flash',
        featureName: 'test',
      })

      expect(result).toBe('CLI fallback response')
      expect(mockCallApi).toHaveBeenCalledOnce()
      expect(mockSpawnSync).toHaveBeenCalledOnce()
    })

    it('デフォルトは preferCli: false（API が先に呼ばれる）', async () => {
      mockCallApi.mockResolvedValue('API result')

      await callGeminiWithFallback('test prompt')

      expect(mockCallApi).toHaveBeenCalledOnce()
      expect(mockSpawnSync).not.toHaveBeenCalled()
    })

    it('両方 429 → エラーがスローされる + quota-exhausted.json が書かれる', async () => {
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))
      mockSpawnSync.mockReturnValue(cli429())

      await expect(
        callGeminiWithFallback('test prompt', {
          preferCli: false,
          featureName: 'audit_explanation',
        })
      ).rejects.toThrow('quota exhausted')

      expect(mockWriteFileSync).toHaveBeenCalledOnce()
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string)
      expect(written.featureName).toBe('audit_explanation')
    })
  })

  describe('Antigravity CLI 経由の Claude Sonnet フォールバック（2026-08-24 追加）', () => {
    it('Gemini API・CLI 双方が quota 起因で失敗 → Antigravity/Claude で成功する', async () => {
      mockSpawnSync.mockImplementation((_cmd, args) => {
        const model = (args as string[])[1]
        if (model === 'claude-sonnet-4-6') return cliSuccess('Claude fallback response')
        return cli429()
      })
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: false,
        cliModel: 'gemini-3.5-flash',
        featureName: 'strategic-meta-review-scope_simplicity',
      })

      expect(result).toBe('Claude fallback response')
      expect(mockWriteFileSync).not.toHaveBeenCalled()
      // spawnSync は Gemini-CLI（quota失敗）と Claude-CLI（成功）の2回のみ
      expect(mockSpawnSync).toHaveBeenCalledTimes(2)
    })

    it('Gemini・Antigravity/Claude すべて quota 起因で失敗 → 従来どおり例外 + quota-exhausted.json', async () => {
      mockSpawnSync.mockReturnValue(cli429())
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))

      await expect(
        callGeminiWithFallback('test prompt', {
          preferCli: false,
          featureName: 'strategic-meta-review-scope_simplicity',
        })
      ).rejects.toThrow('quota exhausted')

      expect(mockWriteFileSync).toHaveBeenCalledOnce()
      // spawnSync は Gemini-CLI と Claude-CLI の2回（API呼び出しは callGeminiForReview 経由で別モック）
      expect(mockSpawnSync).toHaveBeenCalledTimes(2)
    })

    it('quota 以外の失敗（CLI・API とも）では Antigravity/Claude を試さない', async () => {
      mockSpawnSync.mockReturnValue(cliError())
      mockCallApi.mockRejectedValue(new Error('unexpected 500 internal error'))

      await expect(
        callGeminiWithFallback('test prompt', {
          preferCli: false,
          featureName: 'test',
        })
      ).rejects.toThrow('quota exhausted')

      // Gemini-CLI の1回のみ（Claude フォールバックを試みていない）
      expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    })

    it('API が quota 起因失敗・CLI が非quota失敗の混在では Antigravity/Claude を試さない', async () => {
      mockSpawnSync.mockReturnValue(cliError())
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))

      await expect(
        callGeminiWithFallback('test prompt', { preferCli: false, featureName: 'test' })
      ).rejects.toThrow('quota exhausted')

      expect(mockSpawnSync).toHaveBeenCalledTimes(1)
    })

    it('agy サブプロセスへ渡す env に秘密情報を含めない（PATH/HOME/LANG/TERM のみ）', async () => {
      const originalEnv = { ...process.env }
      process.env.CLAUDE_API_KEY = 'should-not-leak'
      process.env.GEMINI_API_KEY = 'should-not-leak'
      process.env.API_TOKEN = 'should-not-leak'
      process.env.DB_PATH = '/should/not/leak'

      try {
        mockSpawnSync.mockReturnValue(cli429())
        mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))

        await expect(
          callGeminiWithFallback('test prompt', { preferCli: false, featureName: 'test' })
        ).rejects.toThrow('quota exhausted')

        for (const call of mockSpawnSync.mock.calls) {
          const env = call[2]?.env as NodeJS.ProcessEnv | undefined
          expect(env).toBeDefined()
          const keys = Object.keys(env as object).sort()
          expect(keys).toEqual(keys.filter((k) => ['PATH', 'HOME', 'LANG', 'TERM'].includes(k)))
          expect(env?.CLAUDE_API_KEY).toBeUndefined()
          expect(env?.GEMINI_API_KEY).toBeUndefined()
          expect(env?.API_TOKEN).toBeUndefined()
          expect(env?.DB_PATH).toBeUndefined()
        }
      } finally {
        process.env = originalEnv
      }
    })

    it('agy へ --add-dir を渡さず、cwd をリポジトリ外の一時ディレクトリに固定する', async () => {
      mockSpawnSync.mockReturnValue(cli429())
      mockCallApi.mockRejectedValue(new Error('429 quota exceeded'))

      await expect(
        callGeminiWithFallback('test prompt', { preferCli: false, featureName: 'test' })
      ).rejects.toThrow('quota exhausted')

      expect(mockSpawnSync.mock.calls.length).toBeGreaterThan(0)
      for (const call of mockSpawnSync.mock.calls) {
        const args = call[1] as string[]
        expect(args).not.toContain('--add-dir')
        const options = call[2] as { cwd?: string }
        expect(options.cwd).toBe(tmpdir())
      }
    })
  })

  describe('CLI 呼び出しの詳細', () => {
    it('preferCli: true のとき CLI が先に呼ばれる', async () => {
      const callOrder: string[] = []
      mockSpawnSync.mockImplementation(() => {
        callOrder.push('cli')
        return cliSuccess('ok')
      })
      mockCallApi.mockImplementation(async () => {
        callOrder.push('api')
        return 'ok'
      })

      await callGeminiWithFallback('prompt', { preferCli: true })

      expect(callOrder[0]).toBe('cli')
      expect(mockCallApi).not.toHaveBeenCalled()
    })

    it('preferCli: false のとき API が先に呼ばれる', async () => {
      const callOrder: string[] = []
      mockSpawnSync.mockImplementation(() => {
        callOrder.push('cli')
        return cliSuccess('ok')
      })
      mockCallApi.mockImplementation(async () => {
        callOrder.push('api')
        return 'ok'
      })

      await callGeminiWithFallback('prompt', { preferCli: false })

      expect(callOrder[0]).toBe('api')
      expect(mockSpawnSync).not.toHaveBeenCalled()
    })

    it('CLI が exit code 0 以外でも null として扱われ API にフォールバックする', async () => {
      mockSpawnSync.mockReturnValue(cliError())
      mockCallApi.mockResolvedValue('API result')

      const result = await callGeminiWithFallback('prompt', { preferCli: true })
      expect(result).toBe('API result')
    })

    it('CLI が exit 0 でも stdout が空の場合は API にフォールバックする', async () => {
      // agy の実際の挙動: --print に対して exit 0 + 空 stdout を返す
      mockSpawnSync.mockReturnValue(
        { status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
      )
      mockCallApi.mockResolvedValue('API result from fallback')

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: true,
        featureName: 'alignment_check',
      })

      expect(result).toBe('API result from fallback')
      expect(mockCallApi).toHaveBeenCalledOnce()
    })

    it('CLI が exit 0 でも stdout が空白のみの場合も API にフォールバックする', async () => {
      mockSpawnSync.mockReturnValue(
        { status: 0, stdout: '   \n  ', stderr: '', pid: 1, output: [], signal: null } as unknown as ReturnType<typeof spawnSync>
      )
      mockCallApi.mockResolvedValue('API result')

      const result = await callGeminiWithFallback('test prompt', {
        preferCli: true,
        featureName: 'test',
      })

      expect(result).toBe('API result')
      expect(mockCallApi).toHaveBeenCalledOnce()
    })
  })
})
