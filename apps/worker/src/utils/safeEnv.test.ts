import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { buildTargetCommandEnv } from './safeEnv.js'

/**
 * buildTargetCommandEnv() のユニットテスト。
 *
 * P0-2（target-project 側コマンドへの環境変数継承の最小修正）で新設した
 * allowlist 構築関数。denylist ではなく allowlist であることそのものが
 * 安全境界の本質のため、「未知の変数が自動で漏れないこと」を明示的に検証する。
 */

const PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform')!

function stubPlatform(platform: 'win32' | 'linux' | 'darwin'): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', PLATFORM_DESCRIPTOR)
}

describe('buildTargetCommandEnv', () => {
  const SECRET_KEYS = [
    'API_TOKEN',
    'DB_PATH',
    'API_BASE_URL',
    'ANTHROPIC_API_KEY',
    'CLAUDE_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_USER_ID',
    'SLACK_WEBHOOK_URL',
    'CONTROL_ROOT',
    'CONTROL_REPO_PATH',
    'TARGET_REPO_PATH',
    'JOB_LOG_DIR',
  ] as const

  const HOME_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'] as const

  const ENV_BACKUP: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of [...SECRET_KEYS, ...HOME_KEYS, 'FUTURE_OUTBOX_SECRET', 'CI']) {
      ENV_BACKUP[key] = process.env[key]
      process.env[key] = `test-value-for-${key}`
    }
  })

  afterEach(() => {
    restorePlatform()
    for (const [key, value] of Object.entries(ENV_BACKUP)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('PATH は維持される', () => {
    const env = buildTargetCommandEnv()
    expect(env.PATH).toBe(process.env.PATH)
  })

  it('CI は process.env のコピーではなく固定値 "1" になる', () => {
    // 親側で CI に別の値（"test-value-for-CI"）が入っていても、固定値で上書きされる
    const env = buildTargetCommandEnv()
    expect(env.CI).toBe('1')
  })

  it.each(SECRET_KEYS)('秘密情報 %s は含まれない', (key) => {
    const env = buildTargetCommandEnv()
    expect(env[key]).toBeUndefined()
  })

  it.each(HOME_KEYS)('実ユーザーホーム %s は含まれない（2026-08-01 CEO承認）', (key) => {
    const env = buildTargetCommandEnv()
    expect(env[key]).toBeUndefined()
  })

  it('親 process.env へ未知の変数（将来の Outbox 秘密情報等）を追加しても子へ継承されない', () => {
    // beforeEach で既に FUTURE_OUTBOX_SECRET を設定済み。allowlist に無いキーのため必ず落ちる。
    const env = buildTargetCommandEnv()
    expect(env.FUTURE_OUTBOX_SECRET).toBeUndefined()
    expect(Object.keys(env)).not.toContain('FUTURE_OUTBOX_SECRET')
  })

  describe('Windows', () => {
    beforeEach(() => stubPlatform('win32'))

    it('Windows 必須変数（TEMP/TMP/SystemRoot/ComSpec/PATHEXT）が含まれる', () => {
      process.env.TEMP = 'C:\\Users\\test\\AppData\\Local\\Temp'
      process.env.TMP = 'C:\\Users\\test\\AppData\\Local\\Temp'
      process.env.SystemRoot = 'C:\\WINDOWS'
      process.env.ComSpec = 'C:\\WINDOWS\\system32\\cmd.exe'
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const env = buildTargetCommandEnv()
      expect(env.TEMP).toBe(process.env.TEMP)
      expect(env.TMP).toBe(process.env.TMP)
      expect(env.SystemRoot).toBe(process.env.SystemRoot)
      expect(env.ComSpec).toBe(process.env.ComSpec)
      expect(env.PATHEXT).toBe(process.env.PATHEXT)
    })

    it('POSIX 専用変数（TMPDIR/LANG/LC_ALL）は含まれない', () => {
      process.env.TMPDIR = '/tmp'
      process.env.LANG = 'en_US.UTF-8'
      process.env.LC_ALL = 'en_US.UTF-8'

      const env = buildTargetCommandEnv()
      expect(env.TMPDIR).toBeUndefined()
      expect(env.LANG).toBeUndefined()
      expect(env.LC_ALL).toBeUndefined()
    })
  })

  describe('POSIX', () => {
    beforeEach(() => stubPlatform('linux'))

    it('POSIX 必須変数（TMPDIR/LANG/LC_ALL）が含まれる', () => {
      process.env.TMPDIR = '/tmp'
      process.env.LANG = 'en_US.UTF-8'
      process.env.LC_ALL = 'en_US.UTF-8'

      const env = buildTargetCommandEnv()
      expect(env.TMPDIR).toBe('/tmp')
      expect(env.LANG).toBe('en_US.UTF-8')
      expect(env.LC_ALL).toBe('en_US.UTF-8')
    })

    it('Windows 専用変数（TEMP/TMP/SystemRoot/ComSpec/PATHEXT）は含まれない', () => {
      process.env.TEMP = 'C:\\Users\\test\\AppData\\Local\\Temp'
      process.env.SystemRoot = 'C:\\WINDOWS'
      process.env.ComSpec = 'C:\\WINDOWS\\system32\\cmd.exe'
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'

      const env = buildTargetCommandEnv()
      expect(env.TEMP).toBeUndefined()
      expect(env.SystemRoot).toBeUndefined()
      expect(env.ComSpec).toBeUndefined()
      expect(env.PATHEXT).toBeUndefined()
    })
  })

  describe('AI CLI 用 buildSafeEnv（adapter.ts）との分離', () => {
    it('provider 認証キー（ANTHROPIC/GEMINI/OPENAI）は一切含まれない', () => {
      const env = buildTargetCommandEnv()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.GEMINI_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
    })
  })

  describe('実子プロセス統合テスト（実測でも秘密が見えないことを確認）', () => {
    const SPAWN_SECRET_BACKUP: Record<string, string | undefined> = {}

    beforeEach(() => {
      for (const key of ['API_TOKEN', 'DB_PATH', 'OPENAI_API_KEY', 'FUTURE_OUTBOX_SECRET']) {
        SPAWN_SECRET_BACKUP[key] = process.env[key]
        process.env[key] = `real-secret-${key}`
      }
    })

    afterEach(() => {
      for (const [key, value] of Object.entries(SPAWN_SECRET_BACKUP)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    it('実際の Node 子プロセスに buildTargetCommandEnv() を渡すと4つの秘密変数がすべて undefined になり、通常実行は成功する', () => {
      const env = buildTargetCommandEnv()

      const script =
        "console.log(JSON.stringify({" +
        "API_TOKEN: process.env.API_TOKEN," +
        "DB_PATH: process.env.DB_PATH," +
        "OPENAI_API_KEY: process.env.OPENAI_API_KEY," +
        "FUTURE_OUTBOX_SECRET: process.env.FUTURE_OUTBOX_SECRET," +
        "PATH_EXISTS: typeof process.env.PATH === 'string' && process.env.PATH.length > 0," +
        "})) "

      const stdout = execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf-8',
        env,
        shell: false,
        timeout: 10_000,
      })

      const parsed = JSON.parse(stdout.trim())
      expect(parsed.API_TOKEN).toBeUndefined()
      expect(parsed.DB_PATH).toBeUndefined()
      expect(parsed.OPENAI_API_KEY).toBeUndefined()
      expect(parsed.FUTURE_OUTBOX_SECRET).toBeUndefined()
      expect(parsed.PATH_EXISTS).toBe(true)
    })
  })
})
