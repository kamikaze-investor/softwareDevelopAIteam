/**
 * CTO AI — 生成ドキュメントのcommitヘルパー（MVP hotfix）
 *
 * roadmapWriter / projectMemoryWriter が target-project へ書き出した
 * ファイルをuncommittedのまま残すと、直後にauto-startされる実装Jobの
 * File Change Guardが「HEAD以降の差分」としてこれらを誤って検出し、
 * そのTaskのallowedPathsに含まれないため誤ってblockする
 * （2026-08-23 live E2Eで実測・再現。Claude Code等のAIはこれらのファイルを
 * 一切変更していない — CTO AIの決定的な書き込み処理自体が原因だった）。
 *
 * ここでのcommitはAV-001のApproval Gateを経由しない。AIが自由記述した
 * コード変更ではなく、CTO AIが自身のレスポンスから機械的に生成した
 * 構造化ドキュメントの書き込みであり、既存のJobベースgit_commit
 * （Approval Gate付き）とは対象が異なるため。
 */

import { execFileSync } from 'node:child_process'

/**
 * 指定ファイルだけをstage・commitする。差分が無ければ何もしない（fail-open）。
 * git自体のエラー（identity未設定等）はそのまま呼び出し元へ伝播する（fail-closed）。
 */
export function commitGeneratedDocs(
  targetProjectRoot: string,
  relativeFilePaths: string[],
  message: string,
): void {
  if (relativeFilePaths.length === 0) return

  execFileSync('git', ['add', '--', ...relativeFilePaths], {
    cwd: targetProjectRoot,
    stdio: 'pipe',
  })

  try {
    execFileSync('git', ['commit', '-m', message, '--', ...relativeFilePaths], {
      cwd: targetProjectRoot,
      stdio: 'pipe',
    })
  } catch (error: unknown) {
    const output =
      ((error as { stdout?: Buffer })?.stdout?.toString() ?? '') +
      ((error as { stderr?: Buffer })?.stderr?.toString() ?? '')
    if (/nothing to commit/i.test(output)) {
      return
    }
    throw error
  }
}
