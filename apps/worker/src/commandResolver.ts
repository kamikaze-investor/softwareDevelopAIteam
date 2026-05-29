/**
 * Command Resolver
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * CommandKind → 実際のargvへの変換を一元管理する。
 * AIは CommandKind を選ぶだけ。コマンド文字列を知らない。
 * これによりコマンドインジェクションが構造的に不可能になる。
 *
 * レビュー指摘(2026-05-28):
 * "AIに自由なshell文字列を渡させるより、
 *  アプリ側が用意した安全な操作だけ選ばせる方が圧倒的に安全"
 */

import type { SafeCommand, CommandKind } from '@ai-team/shared'

export interface ResolvedCommand {
  argv: string[]   // spawn(argv[0], argv.slice(1), { shell: false }) で実行
  description: string
}

type Resolver = (params?: SafeCommand['params']) => ResolvedCommand

const RESOLVERS: Record<CommandKind, Resolver> = {
  git_status: () => ({
    argv: ['git', 'status', '--short'],
    description: 'git status',
  }),

  git_diff: () => ({
    argv: ['git', 'diff'],
    description: 'git diff',
  }),

  git_log: () => ({
    argv: ['git', 'log', '--oneline', '-10'],
    description: 'git log (last 10)',
  }),

  git_branch_create: (params) => {
    const branch = sanitizeBranchName(params?.branchName ?? 'ai/auto-branch')
    return {
      argv: ['git', 'checkout', '-b', branch],
      description: `git checkout -b ${branch}`,
    }
  },

  git_checkout: (params) => {
    const branch = sanitizeBranchName(params?.branchName ?? 'main')
    return {
      argv: ['git', 'checkout', branch],
      description: `git checkout ${branch}`,
    }
  },

  git_commit: (params) => {
    const message = sanitizeCommitMessage(params?.commitMessage ?? 'ai: auto commit')
    return {
      argv: ['git', 'commit', '-m', message],
      description: `git commit -m "${message}"`,
    }
  },

  git_revert: (params) => {
    const commit = sanitizeCommitHash(params?.revertCommit ?? 'HEAD')
    return {
      argv: ['git', 'revert', '--no-edit', commit],
      description: `git revert ${commit}`,
    }
  },

  typecheck: () => ({
    argv: ['pnpm', 'run', 'typecheck'],
    description: 'pnpm run typecheck',
  }),

  test: (params) => {
    const base = ['pnpm', 'test']
    if (params?.testPattern) {
      // testPatternはalphanumericと/.-_のみ許可
      const safe = params.testPattern.replace(/[^a-zA-Z0-9/.\-_]/g, '')
      return { argv: [...base, safe], description: `pnpm test ${safe}` }
    }
    return { argv: base, description: 'pnpm test' }
  },

  build: () => ({
    argv: ['pnpm', 'run', 'build'],
    description: 'pnpm run build',
  }),

  lint: () => ({
    argv: ['pnpm', 'run', 'lint'],
    description: 'pnpm run lint',
  }),
}

export function resolveCommand(safeCommand: SafeCommand): ResolvedCommand {
  const resolver = RESOLVERS[safeCommand.kind]
  return resolver(safeCommand.params)
}

// --- サニタイズ関数 ---

/** ブランチ名: alphanumeric / - / _ / / のみ許可 */
function sanitizeBranchName(name: string): string {
  return name.replace(/[^a-zA-Z0-9\-_/]/g, '-').slice(0, 100)
}

/** コミットメッセージ: 改行・シェルメタ文字を除去 */
function sanitizeCommitMessage(msg: string): string {
  return msg.replace(/[\n\r`$\\;"']/g, '').slice(0, 200)
}

/** コミットハッシュ: hexまたはHEAD/HEAD~N のみ許可 */
function sanitizeCommitHash(hash: string): string {
  if (/^HEAD(~\d+)?$/.test(hash)) return hash
  if (/^[a-f0-9]{7,40}$/.test(hash)) return hash
  return 'HEAD'
}
