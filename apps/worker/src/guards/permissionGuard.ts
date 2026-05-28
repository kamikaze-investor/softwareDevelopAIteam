/**
 * Permission Guard
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 役割: 実行前にJobが許可された操作かを検証する
 */

// 許可コマンドリスト (specs/11_runtime_environment.md § 9)
const ALLOWED_COMMANDS = [
  'git status',
  'git diff',
  'git checkout',
  'git commit',
  'git revert',
  'npm install',
  'npm test',
  'npm run build',
  'npm run typecheck',
  'pnpm test',
  'python -m pytest',
  'claude',
  'codex',
  'gemini',
]

// 禁止コマンドパターン
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
]

export interface GuardResult {
  allowed: boolean
  reason?: string
}

export function permissionGuard(command: string, workingDir: string): GuardResult {
  // 禁止パターンチェック
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, reason: `Forbidden command pattern: ${pattern}` }
    }
  }

  // 作業ディレクトリチェック
  if (!workingDir.startsWith('/workspace/project')) {
    return { allowed: false, reason: `Invalid working directory: ${workingDir}` }
  }

  return { allowed: true }
}
