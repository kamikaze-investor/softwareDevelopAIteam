/**
 * Target Command Env — target-project 側コマンドへ渡す環境変数の allowlist
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * SafeCommand（test/build/lint/typecheck/git_commit等）と postLint（AI CLI 実行後の
 * 自動lint）は、target-project 管理の package script（AI/target が書き換え可能）を
 * 経由する。env を未指定で execFileSync すると Worker プロセスの全環境変数
 * （API_TOKEN・DB_PATH・provider API key 等）がそのまま子プロセスへ継承され、
 * target 側スクリプト経由で秘密情報が読み取れてしまう（2026-08-01 実測確認済み）。
 *
 * denylist ではなく allowlist にする理由: 将来 Worker 側に新しい秘密情報
 * （Outbox認証情報等）が追加された場合、denylist は追従漏れで自動的に秘密を
 * 漏らす側に倒れるが、allowlist は明示的に許可しない限り自動的に遮断される側に倒れる。
 *
 * 実ユーザーホーム（HOME/USERPROFILE/APPDATA/LOCALAPPDATA）は含めない。
 * ホームには git/npm/AI CLI/SSH 等の認証情報が存在し得るため、target 側へ
 * 自動公開しない（2026-08-01 CEO承認）。必要性が実証された場合は、実ホームではなく
 * 専用の空ホームを別途検討する。
 *
 * AI CLI 本体（provider 認証を必要とする）用の env 構築（`aiCli/adapter.ts` の
 * `buildSafeEnv()`）とは責務が異なるため統合しない。こちらは target 側コマンド専用で、
 * 秘密情報を一切含めない。
 */

const COMMON_KEYS = ['PATH'] as const
const WINDOWS_KEYS = ['TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT'] as const
const POSIX_KEYS = ['TMPDIR', 'LANG', 'LC_ALL'] as const

/**
 * target-project 側コマンド専用の env を allowlist 方式で構築する。
 * `process.env` をコピーしてから不要なキーを削除する方式ではなく、
 * 空の object へ許可したキーだけを追加する方式にすることで、
 * 新しい環境変数が Worker プロセスへ追加されても自動的に遮断される側に倒す。
 */
export function buildTargetCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  const allowedKeys: readonly string[] =
    process.platform === 'win32' ? [...COMMON_KEYS, ...WINDOWS_KEYS] : [...COMMON_KEYS, ...POSIX_KEYS]

  for (const key of allowedKeys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }

  // CI は process.env からのコピーではなく固定値にする（test runner の非対話化を明示的に強制する）
  env.CI = '1'

  return env
}
