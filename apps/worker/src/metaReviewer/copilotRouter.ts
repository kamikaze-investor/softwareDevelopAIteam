/**
 * Copilot Router — Meta Review 用 Copilot CLI 直接呼び出し
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * geminiRouter.ts の callCli() と同じ理由でBaseCliAdapterを使わない:
 * Meta Review は Control Repository 自体を審査するため、
 * BaseCliAdapter が強制する workingDir === /workspace/target 制約に合わない。
 *
 * Gemini API・CLI の両方が quota 枯渇したときのみ、
 * metaReviewFallbackRouter.ts から呼ばれる最終フォールバック。
 *
 * 認証: ai-team ユーザーの保存済みOAuth credential（実測確認済み 2026-08-28。PAT配線は撤去済み）。
 * 安全性（2026-08-26 独立レビュー2ラウンドを経て確定。すべて実測確認済み）:
 *   - --yolo / --allow-all / --allow-all-tools は使わない。
 *   - `--available-tools`（値なし）を渡し、ツールそのものをモデルから見えなくする。
 *     --allow-tool を渡さないだけでは不十分（実測: --allow-tool なしでも非対話モードで
 *     cwd 配下のファイル一覧・読み取りが確認なしで実行される）。`--available-tools`
 *     （値なし = 空allowlist）を渡すと同じ条件で `NO_FILE_ACCESS` と応答することを
 *     GitHub Actions上で実証済み。
 *   - cwd はさらに、リポジトリ外の使い捨て一時ディレクトリ（mkdtempSync、呼び出しごとに
 *     生成・実行後に削除）に固定する。bare な os.tmpdir() 直下は同一CI実行内の他ステップと
 *     共有される場所であり、隔離としては不十分なため使わない
 *     （geminiRouter.ts が --json-schema 用の一時ファイルに mkdtempSync を使うのと同じ考え方）。
 *   - env は allowlist（PATH/HOME/LANG/TERM + GITHUB_TOKEN）のみを子プロセスへ渡す。
 *     `adapter.ts` の buildSafeEnv() / geminiRouter.ts の buildAgyEnv() と同じ考え方。
 *     GEMINI_API_KEY 等の秘密情報は一切含めない。
 *   - 上記2点（ツール完全無効化 + cwd隔離）は独立した多層防御。どちらか一方が
 *     将来変更されても、もう一方が repository への到達を防ぐ。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const DEFAULT_COPILOT_META_REVIEW_MODEL = 'mai-code-1.1-flash'

/**
 * Copilot CLI 子プロセスへ渡す env。GITHUB_TOKEN 以外の秘密情報を渡さない
 * （adapter.ts の buildSafeEnv() / geminiRouter.ts の buildAgyEnv() と同じ allowlist方式）。
 */
function buildCopilotEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME
  if (process.env.LANG !== undefined) env.LANG = process.env.LANG
  if (process.env.TERM !== undefined) env.TERM = process.env.TERM
  // 認証は ai-team ユーザーの保存済みOAuth credential（HOME配下）で行う
  // （2026-08-28: PAT/token配線を撤去。COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN
  //  のいずれもこの子プロセスへは渡さない）。
  return env
}

export interface CopilotFallbackOptions {
  /** 使用モデル（既定: mai-code-1.1-flash、実測確認済みのMicrosoft系モデル） */
  model?: string
  /**
   * 呼び出し用途の識別子。ログ・将来のCredit routerでの識別用。
   * 例: 'meta_review' | 'independent_review'
   */
  usage?: string
  timeoutMs?: number
  /** テストでの差し替え用。既定はAtomics.waitによる同期sleep。 */
  sleepImpl?: (ms: number) => void
}

/** attempt 1 失敗 → 10秒待機 → attempt 2 失敗 → 30秒待機 → attempt 3。判定ロジックは追加しない固定値。 */
const RETRY_DELAYS_MS = [10_000, 30_000] as const
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1

/**
 * 同期ブロッキングsleep。この関数はdesignReviewRunner.ts経由で使い捨ての
 * 別プロセスとして実行されるため（APIやWorker本体のevent loopではない）、
 * 数十秒ブロックしても他の処理に影響しない。
 */
function defaultSleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

interface CopilotAttemptFailure {
  ok: false
  errorMessage: string
}
interface CopilotAttemptSuccess {
  ok: true
  stdout: string
}

/** 1回分の呼び出し。既存の隔離cwd・env・argv・判定はそのまま。例外は投げず結果を返す。 */
function attemptCopilotCall(
  prompt: string,
  model: string,
  usage: string,
  timeout: number,
): CopilotAttemptFailure | CopilotAttemptSuccess {
  // 呼び出しごとの使い捨て隔離ディレクトリ（bare tmpdir() は他ステップと共有されるため使わない）
  const isolatedCwd = mkdtempSync(path.join(tmpdir(), 'copilot-meta-review-'))

  try {
    const result = spawnSync(
      'copilot',
      [
        '-p', prompt, '-s', '--no-color', '--model', model,
        '--available-tools',  // 値なし = 空allowlist。ツールをモデルから完全に見えなくする（実測確認済み）
      ],
      {
        encoding: 'utf-8',
        timeout,
        env: buildCopilotEnv(),
        cwd: isolatedCwd,
      },
    )

    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''

    if (result.error) {
      return { ok: false, errorMessage: `[copilotRouter] Copilot CLI 実行エラー（usage=${usage}）: ${result.error.message}` }
    }
    if (result.status !== 0) {
      return { ok: false, errorMessage: `[copilotRouter] Copilot CLI が exit code ${result.status} で終了しました（usage=${usage}）: ${stderr || stdout || '(no output)'}` }
    }
    if (!stdout.trim()) {
      return { ok: false, errorMessage: `[copilotRouter] Copilot CLI の応答が空でした（usage=${usage}）` }
    }

    return { ok: true, stdout }
  } finally {
    try {
      rmSync(isolatedCwd, { recursive: true, force: true })
    } catch {
      // 一時ディレクトリの削除失敗はサイレントに無視
    }
  }
}

/**
 * Copilot CLI を呼び出し、非対話モードでレビュー結果テキストを取得する。
 * 401 / 429 / 5xx / network error / 一時的なnon-zero exit はいずれもCLI呼び出しの
 * 技術的失敗として同じ形（非0 exit・spawn失敗・空応答）でしか観測できないため、
 * 個別の原因判定は行わず、最大3回まで固定間隔（10秒 → 30秒）でretryする。
 * 3回とも失敗した場合は最後の失敗内容で例外を投げる（既存のfail-closedを維持）。
 * 正常に取得できた応答（意味のあるblocking結果を含む）はretryしない。
 */
export function callCopilotForMetaReview(
  prompt: string,
  options?: CopilotFallbackOptions,
): string {
  const model = options?.model ?? DEFAULT_COPILOT_META_REVIEW_MODEL
  const usage = options?.usage ?? 'meta_review'
  const timeout = options?.timeoutMs ?? 300_000
  const sleepImpl = options?.sleepImpl ?? defaultSleepSync

  let lastErrorMessage = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = attemptCopilotCall(prompt, model, usage, timeout)
    if (outcome.ok) return outcome.stdout

    lastErrorMessage = outcome.errorMessage
    if (attempt < MAX_ATTEMPTS) {
      sleepImpl(RETRY_DELAYS_MS[attempt - 1])
    }
  }

  throw new Error(lastErrorMessage)
}
