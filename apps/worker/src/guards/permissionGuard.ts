/**
 * Permission Guard
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 役割: 実行前にJobが許可された操作かを検証する
 *
 * セキュリティ方針:
 * - ホワイトリスト方式を優先（許可リストにないコマンドは全て拒否）
 * - ブラックリストは二重チェックとして併用
 * - ブラックリストのみでは未知コマンドを防げないため、ホワイトリストが必須
 */

// ホワイトリスト: このプレフィックスで始まるコマンドのみ許可
// (specs/11_runtime_environment.md § 9)
const ALLOWED_PREFIXES = [
  'git status',
  'git diff',
  'git checkout',
  'git commit',
  'git revert',
  'git add',
  'git branch',
  'git log',
  'npm install',
  'npm test',
  'npm run build',
  'npm run typecheck',
  'npm run lint',
  'pnpm install',
  'pnpm test',
  'pnpm run build',
  'pnpm run typecheck',
  'pnpm run lint',
  'python -m pytest',
  'python3 -m pytest',
  'claude',
  'codex',
  'gemini',
]

// ブラックリスト: ホワイトリストを通過しても二重チェック
const FORBIDDEN_PATTERNS = [
  /^sudo/,
  /^su\s/,
  /rm\s+-rf\s+\//,
  /curl.*\|\s*sh/,
  /wget.*\|\s*sh/,
  /chmod\s+777/,
  /^chown/,
  /^ssh\s/,
  /^scp\s/,
  /^rsync\s/,
  /docker\s+run/,
  /docker\s+compose/,
  /^systemctl/,
  /^ufw/,
  /apt\s+install/,
  /brew\s+install/,
  // package.jsonのscripts経由での任意コード実行を防ぐ
  /npm\s+run\s+(?!build|test|typecheck|lint)/,
  /pnpm\s+run\s+(?!build|test|typecheck|lint)/,
]

export interface GuardResult {
  allowed: boolean
  reason?: string
  /** シェルを経由せず直接実行するための分割済みコマンド */
  argv?: string[]
}

/**
 * コマンド文字列を [実行ファイル, ...引数] に分割する
 * シェルメタ文字(; && | ` $())を含む場合は拒否
 */
function parseCommand(command: string): string[] | null {
  const trimmed = command.trim()

  // シェルインジェクション文字を含む場合は拒否
  // ; && || | ` $() などで複数コマンドを繋げることを防ぐ
  if (/[;&|`$()]/.test(trimmed)) {
    return null
  }

  // 単純なスペース分割（クォート対応は意図的に省略 — 複雑な引数は不要）
  return trimmed.split(/\s+/)
}

export function permissionGuard(command: string, workingDir: string): GuardResult {
  // 1. 作業ディレクトリチェック
  if (!workingDir.startsWith('/workspace/project')) {
    return { allowed: false, reason: `Invalid working directory: ${workingDir}` }
  }

  // 2. シェルインジェクション文字チェック + argv分割
  const argv = parseCommand(command)
  if (!argv || argv.length === 0) {
    return { allowed: false, reason: `Command contains shell metacharacters or is empty: "${command}"` }
  }

  // 3. ホワイトリストチェック（許可されたプレフィックスで始まるか）
  const trimmed = command.trim()
  const isWhitelisted = ALLOWED_PREFIXES.some((prefix) =>
    trimmed === prefix || trimmed.startsWith(prefix + ' ')
  )
  if (!isWhitelisted) {
    return { allowed: false, reason: `Command not in allowlist: "${trimmed}"` }
  }

  // 4. ブラックリストチェック（二重確認）
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason: `Forbidden command pattern matched: ${pattern}` }
    }
  }

  // argv を返すことでWorkerはシェルを経由せず直接実行できる
  // spawn(argv[0], argv.slice(1), { shell: false }) で実行すること
  return { allowed: true, argv }
}
