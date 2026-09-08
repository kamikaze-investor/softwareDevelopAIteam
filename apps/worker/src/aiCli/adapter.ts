/**
 * AI CLI Adapter — 基底クラス + ファクトリー
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 設計原則:
 *   AI CLIを直接自由実行させない。
 *   このアダプターがCLIをラップし、以下を強制する:
 *     1. workingDir の /workspace/target 限定チェック
 *     2. shell: false（シェルインジェクション防止）
 *     3. stdin を閉じる（対話入力を防ぐ）
 *     4. timeout 強制（暴走防止）
 *     5. Secret Scan（プロンプトに秘密情報が混入していないか確認）
 *     6. changedFiles の自動検出（git diff）
 *     7. H-1対策: provider=codex のとき CLAUDE.md 要点をプロンプトに自動注入
 *     8. M-4対策: provider=codex のとき CLI実行後に lint を自動実行
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, unlinkSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AiCliRequest,
  AiCliResult,
  AiCliAdapterConfig,
  AiCliProvider,
} from '@ai-team/shared'
import { isPromptSafe, shouldFallback } from '@ai-team/shared'
import { buildConstitutionPrinciplesPrompt, formatConstitutionPrinciplesWarning, loadConstitutionPrinciples } from '@ai-team/shared/src/constitutionPrinciples.js'
import { isInsideTargetRoot, TARGET_ROOT } from '../utils/pathUtils.js'
import { buildTargetCommandEnv } from '../utils/safeEnv.js'
import { buildWorktreeManifest, worktreeContainsName } from '../guards/changeManifest.js'
import {
  isContainmentInfrastructureError,
  runContainedOrThrow,
} from '../execution/runContainedCommand.js'
import { saveJobLogs } from '../jobLogger.js'

// ────────────────────────────────────────────────────────────
// Windows .cmd / .bat ラップユーティリティ
// ────────────────────────────────────────────────────────────

/**
 * Windows で .cmd / .bat ファイルを shell:false で実行するために
 * cmd.exe /c 経由にラップする。他プラットフォームはそのまま返す。
 *
 * AI CLI 実行（BaseCliAdapter）と postLint（pnpm）の両方で使用する。
 */
function resolveWindowsExe(cliPath: string): { exe: string; prefixArgs: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cliPath)) {
    return { exe: 'cmd.exe', prefixArgs: ['/c', cliPath] }
  }
  return { exe: cliPath, prefixArgs: [] }
}

/**
 * Windows 環境で PATH から pnpm.cmd を探す。
 * 見つかれば絶対パスを返す。見つからなければ 'pnpm' を返す（ENOENT は呼び出し元で non-fatal 処理）。
 */
function resolvePnpmPath(): string {
  if (process.platform !== 'win32') return 'pnpm'
  for (const dir of (process.env.PATH ?? '').split(';')) {
    const candidate = path.join(dir.trim(), 'pnpm.cmd')
    if (existsSync(candidate)) return candidate
  }
  return 'pnpm'  // 見つからなければ 'pnpm' のまま（catch で non-fatal）
}

/** capture用一時ディレクトリの接頭辞。 */
const CAPTURE_DIR_PREFIX = 'codex-lastmsg-'

/**
 * OS が正準と見なす実パス。
 *
 * `realpathSync.native` のみを使う。通常の `realpathSync` は symlinkでない部分の綴りを
 * 残すため、Windowsの8.3短縮名（`C:\WORKSP~1` と `C:\Workspace`）を同一と見なせない。
 * **nativeが失敗しても綴りを畳めない実装へフォールバックしない** — 「解決できなかった」を
 * 「安全」と読み替えないため（独立レビュー指摘、2026-09-08）。失敗は呼び出し元へ伝播する。
 */
function canonicalRealPath(target: string): string {
  return realpathSync.native(path.resolve(target))
}

/**
 * 2つのパスが**同一のディレクトリ実体**かを inode で判定する。
 *
 * 文字列比較では不十分。bind mount / UNC alias / mount point は、
 * 同じディレクトリに対して異なる正準文字列を与えうるので、
 * `TMPDIR` をリポジトリのbind mount先へ向けるだけで文字列ベースの封じ込めは破れる
 * （独立レビュー指摘、2026-09-08）。device + inode は綴りに依存しない同一性を与える。
 */
function isSameDirectory(a: string, b: string): boolean {
  const sa = statSync(a)
  const sb = statSync(b)

  return sa.dev === sb.dev && sa.ino === sb.ino
}

/**
 * `child` が `parent` と同一、またはその配下かを **inode 同一性**で判定する。
 * 祖先を辿って `parent` と同じ実体に当たるかを見る。
 * **解決できなければ例外を投げる**（判定不能を「安全」と扱わない）。
 */
function isInside(child: string, parent: string): boolean {
  const parentReal = canonicalRealPath(parent)
  let current = canonicalRealPath(child)

  for (;;) {
    if (isSameDirectory(current, parentReal)) return true

    const next = path.dirname(current)
    if (next === current) return false
    current = next
  }
}

/**
 * capture ディレクトリが **対象リポジトリの作業ツリーの中に無いこと** を、
 * リポジトリ側から実際に確認する。
 *
 * パス演算では判定できない。`/workspace/target/.tmp` を `/var/tmp/target-temp` へ
 * bind mount して `TMPDIR` をそこへ向けると、mount の内側からは元の親ディレクトリが
 * 見えないため、祖先を辿る方式（inode比較を含む）は必ず「外側」と誤判定する
 * （独立レビュー指摘、2026-09-08。攻撃者不要、静的な構成だけで再現する）。
 *
 * そこで「そのパスは外側か」を計算するのをやめ、**リポジトリに実際に現れるか**を訊く。
 * capture ディレクトリへ目印ファイルを置き、対象リポジトリ側の `git status` に
 * それが出るかどうかを見る。git は作業ツリーを実際に列挙するので、
 * どんな別名・bind mount 経由で内側にあっても検出できる。
 * `--ignored` を付けるのは、`.gitignore` されたパスへ mount された場合を取りこぼさないため。
 *
 * 判定できない場合（gitが無い等）は fail-closed。
 */
function assertCaptureDirIsOutsideRepo(captureDir: string, workingDir: string): void {
  const sentinelName = `.codex-capture-probe-${process.pid}-${randomUUID()}`
  const sentinelPath = path.join(captureDir, sentinelName)

  writeFileSync(sentinelPath, '', 'utf-8')

  try {
    if (worktreeContainsName(workingDir, sentinelName)) {
      throw new Error(
        `[aiCli] capture directory (${captureDir}) は対象リポジトリ (${workingDir}) の作業ツリー内に`
        + `現れます（bind mount 等の別名経由）。read-only保証が壊れるため中止します。`,
      )
    }
  } finally {
    try {
      unlinkSync(sentinelPath)
    } catch {
      // 目印の後始末に失敗しても、capture ディレクトリごと後で消える。
    }
  }
}

/**
 * このプロセスが作った capture ディレクトリの登録簿。
 *
 * cleanup は**ここに登録されたものだけ**を消す。引数の構造だけを信じると、
 * 内部APIへ手で組んだオブジェクトを渡すだけで無関係なツリーを再帰削除できてしまう
 * （独立レビュー指摘、2026-09-08）。所有権は実行時の事実として持つ。
 */
const OWNED_CAPTURE_DIRS = new Set<string>()

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Codexの最終回答を受け取るcapture先。**このプロセスが作ったディレクトリを保持する。** */
export interface CodexOutputCapture {
  filePath: string
  captureDir: string
}

/**
 * `--output-last-message`用のcapture先を作る。
 *
 * **対象リポジトリの外（OS temp）へ置く。** 以前は`request.workingDir`直下に作っていたため、
 * 読み取り専用のはずのレビュー・Roadmap生成が対象リポジトリのworking treeを一時的に変化させ、
 * crash / SIGKILL では残骸が残りえた（roadmap: codex-last-message-temp-file-in-target-repo）。
 * `--sandbox read-only`下でもOS tempへ書けることは実測済み（2026-09-07、CEO承認canary）。
 *
 * **検証はディレクトリを作った「後」に行う。** `TMPDIR`/`TEMP`がリポジトリ内を指しうるうえ、
 * 事前にtemp rootを検証しても、その直後にsymlinkを張り替えられれば検証は無意味になる
 * （TOCTOU。独立レビュー指摘、2026-09-08）。実際に作られたディレクトリ自身を検証すれば、
 * temp rootが途中で何を指すようになっていても「ファイルが実際に置かれる場所」を判定できる。
 * リポジトリ内だった場合は作ったものを消してから失敗させる（fail-closed）。
 */
function createCodexOutputCapture(request: AiCliRequest): CodexOutputCapture | undefined {
  if (request.provider !== 'codex' || request.expectJson !== true) return undefined

  const safeTaskId = request.taskId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 64) || 'task'

  // **作る前に**temp rootを検査する。作ってから消す方式だと、TMPDIRがリポジトリ内を
  // 指しているときに一瞬だけリポジトリ内へディレクトリが現れ、その間にSIGKILLされると
  // 残骸が残る（独立レビュー指摘、2026-09-08）。「一瞬も作らない」を実際に満たすため、
  // 事前チェックと事後チェックの両方を持つ。事後チェックはこの後のTOCTOU用。
  const tmpRoot = canonicalRealPath(os.tmpdir())
  if (isInside(tmpRoot, request.workingDir)) {
    throw new Error(
      `[aiCli] OS temp directory (${tmpRoot}) が対象リポジトリ (${request.workingDir}) の内側です。`
      + `capture fileをリポジトリ内へ書くとread-only保証が壊れるため中止します。`,
    )
  }

  const captureDir = mkdtempSync(path.join(tmpRoot, CAPTURE_DIR_PREFIX))

  // 1) 祖先を辿る判定（symlink等の通常の別名を捕まえる）
  let insideRepo: boolean
  try {
    insideRepo = isInside(captureDir, request.workingDir)
  } catch (err) {
    // 正規化できない＝リポジトリ内かどうか判定できない。安全側に倒して中止する。
    rmSync(captureDir, { recursive: true, force: true })
    throw new Error(
      `[aiCli] capture directory (${captureDir}) の正規化に失敗し、対象リポジトリ`
      + `(${request.workingDir}) の内外を判定できませんでした: ${formatErrorMessage(err)}`,
    )
  }

  if (insideRepo) {
    rmSync(captureDir, { recursive: true, force: true })
    throw new Error(
      `[aiCli] OS temp directory (${captureDir}) が対象リポジトリ (${request.workingDir}) の内側に`
      + `解決されました。capture fileをリポジトリ内へ書くとread-only保証が壊れるため中止します。`,
    )
  }

  // 2) リポジトリ側からの実測（bind mount 等、パス演算では見えない別名を捕まえる）
  try {
    assertCaptureDirIsOutsideRepo(captureDir, request.workingDir)
  } catch (err) {
    rmSync(captureDir, { recursive: true, force: true })
    throw err instanceof Error
      ? err
      : new Error(`[aiCli] capture directory の検証に失敗しました: ${formatErrorMessage(err)}`)
  }

  OWNED_CAPTURE_DIRS.add(captureDir)

  return {
    captureDir,
    filePath: path.join(
      captureDir,
      `.codex-last-message-${safeTaskId}-${process.pid}-${Date.now()}-${randomUUID()}.json`,
    ),
  }
}

function readCodexOutputLastMessage(filePath: string | undefined): Record<string, unknown> | undefined {
  if (filePath === undefined || !existsSync(filePath)) return undefined

  try {
    return tryParseJson(readFileSync(filePath, 'utf-8'))
  } catch {
    return undefined
  }
}

/**
 * capture先を後片付けする。
 *
 * **このプロセスが`mkdtemp`で作ったディレクトリだけを、パスを推測せずに消す。**
 * 以前は任意の文字列を受け取り「接頭辞が一致するか」で削除可否を判断していたが、
 * 文字列からowner shipは証明できない —
 * `/srv/data/f.json`を渡せば無関係なファイルがunlinkされ、
 * `/tmp/codex-lastmsg-backup/result.json`を渡せば無関係なディレクトリが再帰削除された
 * （独立レビュー指摘、2026-09-08）。
 * 引数を`CodexOutputCapture`にして**信頼できないパスを受け取る入口自体を無くした**ので、
 * 判定ロジックは不要になった。ディレクトリごと消すためファイル単体のunlinkも要らない
 * （unlink失敗でrmSyncが巻き添えでskipされる問題も同時に消える）。
 */
export function cleanupCodexOutputCapture(capture: CodexOutputCapture | undefined): void {
  if (capture === undefined) return
  // **このプロセスが実際に作ったディレクトリでなければ何もしない。**
  if (!OWNED_CAPTURE_DIRS.has(capture.captureDir)) return

  try {
    rmSync(capture.captureDir, { recursive: true, force: true })
    OWNED_CAPTURE_DIRS.delete(capture.captureDir)
  } catch {
    // 失敗しても登録は残す（次の機会に再試行できる）。OS temp配下なので
    // 残ってもリポジトリのread-only保証は壊れない。
  }
}

// CLAUDE.md / AGENTS.md のパス（コンテナ内 = /workspace/control、ローカル開発 = プロジェクトルート）
const CLAUDE_MD_PATHS = [
  '/workspace/control/CLAUDE.md',
  path.resolve(process.cwd(), '../../CLAUDE.md'),
  path.resolve(process.cwd(), 'CLAUDE.md'),
]

const AGENTS_MD_PATHS = [
  '/workspace/control/AGENTS.md',
  path.resolve(process.cwd(), '../../AGENTS.md'),
  path.resolve(process.cwd(), 'AGENTS.md'),
]

// ────────────────────────────────────────────────────────────
// インターフェース
// ────────────────────────────────────────────────────────────

export interface IAiCliAdapter {
  run(request: AiCliRequest): Promise<AiCliResult>
}

interface CodexLastMessageRequest extends AiCliRequest {
  codexOutputLastMessagePath?: string
}

/**
 * containment cgroup の識別子。
 * `AiCliRequest` は元々 Job ID を持たないため、渡されていれば jobId、無ければ taskId を使う。
 * cgroup 名の一意性は attemptId 側で担保する。
 */
function containmentId(request: AiCliRequest): string {
  return request.jobId ?? request.taskId
}

let containmentAttemptCounter = 0

/** cgroup ディレクトリを決して再利用しないための、プロセス内で単調な試行 ID */
function nextAttemptId(label: string): string {
  containmentAttemptCounter += 1
  return `${label}-${process.pid}-${containmentAttemptCounter}`
}

// ────────────────────────────────────────────────────────────
// 基底クラス（全アダプター共通のセキュリティ制御）
// ────────────────────────────────────────────────────────────

export abstract class BaseCliAdapter implements IAiCliAdapter {
  protected readonly config: Required<AiCliAdapterConfig>

  constructor(config: AiCliAdapterConfig) {
    this.config = {
      cliPath: this.defaultCliName(),
      maxRetries: 2,
      defaultTimeoutMs: 300_000,
      ...config,
    }
  }

  /** サブクラスがCLI名（パス）を返す */
  protected abstract defaultCliName(): string

  /** サブクラスがプロンプト+モードをargvに変換する */
  protected abstract buildArgv(request: AiCliRequest): string[]

  /**
   * prompt を argv ではなく stdin で渡す場合は true を返す。
   * true の場合: buildArgv は末尾に '-' を置き、BaseCliAdapter が input: finalPrompt を渡す。
   * false の場合（デフォルト）: buildArgv が prompt を argv 末尾に含める従来動作。
   */
  protected useStdinPrompt(): boolean { return false }

  /**
   * Windows で .cmd / .bat ファイルを shell:false で実行するために cmd.exe /c でラップする。
   * module-level の resolveWindowsExe() に委譲する。
   */
  private resolveExe(): { exe: string; prefixArgs: string[] } {
    return resolveWindowsExe(this.config.cliPath)
  }

  async run(request: AiCliRequest): Promise<AiCliResult> {
    const startTime = Date.now()

    // ── セキュリティチェック1: workingDir ──────────────────
    if (!isInsideTargetRoot(request.workingDir)) {
      throw new Error(
        `[AiCliAdapter] workingDir が TARGET_ROOT 外です: ${request.workingDir}\n` +
        `AI CLI は /workspace/target 配下のみ実行できます。`
      )
    }

    // ── セキュリティチェック2: Secret Scan ─────────────────
    if (!isPromptSafe(request.prompt)) {
      throw new Error(
        `[AiCliAdapter] プロンプトに secret が検出されました（taskId: ${request.taskId}）\n` +
        `ContextPackにAPIキー・秘密鍵・パスワードを含めてはいけません。`
      )
    }

    // ── H-1対策: Codex向けCLAUDE.md注入 ──────────────────
    // Codex は CLAUDE.md を自動読込しないため、プロンプト先頭に必ず注入する。
    // injectClaudeMd が明示的に false の場合のみスキップ（テスト用）。
    const shouldInject = request.provider === 'codex' && request.injectClaudeMd !== false
    const promptWithClaudeMd = shouldInject
      ? injectClaudeMdEssentials(request.prompt)
      : request.prompt

    // Constitution 3.14〜3.15（AI Team OS共通行動原則）のPolicy overlay。
    // Control Repository由来の固定Policyのみをprovider非依存で1回だけ前置する。
    // request.prompt（= 保存済み job.aiCliPrompt、Design Review hashの対象）は変更しない。
    // 任意のcontextを注入する汎用機構へは拡張しないこと。
    const finalPrompt = prependConstitutionPrinciples(promptWithClaudeMd)

    if (request.dryRun) {
      return {
        taskId: request.taskId,
        provider: request.provider,
        exitCode: 0,
        stdout: '[DRY RUN] 実行をスキップしました',
        stderr: '',
        changedFiles: [],
        durationMs: 0,
      }
    }

    // ── CLI 実行 ───────────────────────────────────────────
    //
    // ⚠️ 設計上の注意（Meta Review 指摘: medium）:
    //   この実行経路は CommandKind / permissionGuard を通らない。
    //   AI CLI はファイル編集・git操作を自律的に行うため、
    //   CommandKind の細粒度制御とは別レイヤーで動作する。
    //
    //   代わりに以下の多層防御を適用する:
    //     1. workingDir = /workspace/target 限定（このクラスで強制）
    //     2. Docker read-only mount（Control Repo を物理的に保護）
    //     3. File Change Guard（実行後の差分を検査）
    //     4. Meta Reviewer AI（コミット前に差分を審査）
    //
    //   CommandKind Guard との統合は task-009（Worker Job実行エンジン）で設計する。
    //
    // finalPrompt = H-1注入済みプロンプト（Codexの場合のみCLAUDE.md先頭付与）
    const codexOutputCapture = createCodexOutputCapture(request)
    const argvRequest: CodexLastMessageRequest = codexOutputCapture
      ? { ...request, prompt: finalPrompt, codexOutputLastMessagePath: codexOutputCapture.filePath }
      : { ...request, prompt: finalPrompt }
    const argv = this.buildArgv(argvRequest)
    // task-024: request > config > デフォルト(5分) の優先順位でタイムアウト決定
    const timeout = request.timeoutMs ?? this.config.defaultTimeoutMs
    const { exe, prefixArgs } = this.resolveExe()
    const stdinInput = this.useStdinPrompt() ? finalPrompt : undefined

    let stdout = ''
    let stderr = ''
    let exitCode = 0
    let isTimeoutError = false
    let isApiError = false
    let providerFailureKind: AiCliResult['providerFailureKind']
    let parsedOutputFromLastMessage: Record<string, unknown> | undefined

    try {
      // P1 Phase 2: AI CLI は子孫を fork し得るため per-job cgroup へ封じ込めて実行する。
      // containment が安全と証明できなかった場合は ContainmentInfrastructureError が飛び、
      // 下の catch では吸収せず再 throw する（通常の provider 失敗と混同してはならない）。
      const contained = await runContainedOrThrow({
        jobId: containmentId(request),
        attemptId: nextAttemptId('ai-cli'),
        argv: [exe, ...prefixArgs, ...argv],
        cwd: request.workingDir,      // ⚠️ シェルを経由しない（インジェクション防止）
        env: buildSafeEnv(request.provider),
        timeoutMs: timeout,
        input: stdinInput,
      })
      stdout = contained.stdout
      if (contained.exitCode === 0) {
        stderr = contained.stderr
      } else {
        // execFileSync は非ゼロ終了で throw していたので、同じ分類をここで再現する。
        exitCode = contained.exitCode ?? 1
        stderr = contained.stderr
        // timeout は cgroup.kill（SIGKILL）で起きるため signal 名では判定できない。
        // containment が観測した timedOut を唯一の真実として使う。
        if (contained.timedOut) providerFailureKind = 'provider_timeout'
        // task-024: タイムアウト・APIエラーを分類
        isTimeoutError = contained.timedOut || stderr.includes('ETIMEDOUT')
        isApiError = exitCode >= 500 || stderr.includes('API Error') || stderr.includes('5xx')
      }
    } catch (err: any) {
      if (isContainmentInfrastructureError(err)) throw err
      exitCode = typeof err.status === 'number' ? err.status : 1
      stdout   = typeof err.stdout === 'string' ? err.stdout : ''
      stderr   = typeof err.stderr === 'string' ? err.stderr : String(err)
      isTimeoutError = err.signal === 'SIGTERM' || (err.code === 'ETIMEDOUT') || stderr.includes('ETIMEDOUT')
      isApiError = exitCode >= 500 || stderr.includes('API Error') || stderr.includes('5xx')
    } finally {
      parsedOutputFromLastMessage = readCodexOutputLastMessage(codexOutputCapture?.filePath)
      cleanupCodexOutputCapture(codexOutputCapture)
    }

    // task-024: フォールバックポリシーが設定されていて条件を満たす場合は再実行
    if (
      request.fallbackPolicy &&
      shouldFallback(request.fallbackPolicy, exitCode, isTimeoutError, isApiError) &&
      request.fallbackPolicy.fallbackProvider !== request.provider
    ) {
      const fallbackRequest: AiCliRequest = {
        ...request,
        provider: request.fallbackPolicy.fallbackProvider,
        fallbackPolicy: undefined,  // 無限ループ防止
      }
      const { createAiCliAdapter } = await import('./factory.js')
      const fallbackAdapter = createAiCliAdapter({ provider: request.fallbackPolicy.fallbackProvider })
      return fallbackAdapter.run(fallbackRequest)
    }

    // ── 変更ファイル検出（実行後の git diff） ──────────────
    const changedFiles = getChangedFiles(request.workingDir)

    // ── M-4対策: Codex実行後のlint自動実行 ────────────────
    // Codex はスタイルが不一致になりやすいため、デフォルトでlintを実行する。
    // postLint が明示的に false の場合のみスキップ。
    const shouldPostLint = request.provider === 'codex' && request.postLint !== false
    if (shouldPostLint && changedFiles.length > 0) {
      // P1 Phase 2: await を落とすと containment 完了前に次へ進む（floating promise）。
      await runPostLint(request.workingDir, containmentId(request))
    }

    // ── サマリー抽出（JSON出力があれば） ───────────────────
    const summary = extractSummary(stdout)

    // ── task-023: JSON出力パーサー + リトライ ───────────────
    let parsedOutput: Record<string, unknown> | undefined
    let blocked = false
    let retryCount = 0
    if (request.expectJson) {
      const maxRetries = this.config.maxRetries
      parsedOutput = parsedOutputFromLastMessage ?? tryParseJson(stdout)

      while (parsedOutput === undefined && retryCount < maxRetries) {
        retryCount++
        // リトライ: "JSONで出力し直してください" を付け加えて再実行
        const retryPromptText = `${finalPrompt}\n\n## 再試行指示（リトライ ${retryCount}/${maxRetries}）\n前回の出力がJSONとして解析できませんでした。必ず有効なJSON形式のみを出力してください。`
        const retryArgv = this.buildArgv({ ...request, prompt: retryPromptText })
        const retryInput = this.useStdinPrompt() ? retryPromptText : undefined
        let retryStdout = ''
        try {
          const contained = await runContainedOrThrow({
            jobId: containmentId(request),
            attemptId: nextAttemptId(`ai-cli-retry-${retryCount}`),
            argv: [exe, ...prefixArgs, ...retryArgv],
            cwd: request.workingDir,
            env: buildSafeEnv(request.provider),
            timeoutMs: timeout,
            input: retryInput,
          })
          retryStdout = contained.stdout
        } catch (err: any) {
          if (isContainmentInfrastructureError(err)) throw err
          retryStdout = typeof err.stdout === 'string' ? err.stdout : ''
        }
        parsedOutput = tryParseJson(retryStdout)
        if (parsedOutput !== undefined) {
          stdout = retryStdout  // パース成功したリトライ出力で上書き
        }
      }

      if (parsedOutput === undefined) {
        blocked = true
      }
    }

    // ── ログ永続化（task-022） ──────────────────────────────
    let stdoutPath: string | undefined
    let stderrPath: string | undefined
    if (request.taskId) {
      try {
        const logPaths = saveJobLogs(`cli-${request.taskId}`, stdout, stderr)
        stdoutPath = logPaths.stdoutPath
        stderrPath = logPaths.stderrPath
      } catch {
        // ログ保存失敗は非致命的（実行結果には影響しない）
      }
    }

    return {
      taskId: request.taskId,
      provider: request.provider,
      exitCode,
      stdout,
      stderr,
      stdoutPath,
      stderrPath,
      changedFiles,
      durationMs: Date.now() - startTime,
      ...(providerFailureKind ? { providerFailureKind } : {}),
      summary,
      parsedOutput,
      ...(request.expectJson ? { blocked, retryCount } : {}),
    }
  }
}

// ────────────────────────────────────────────────────────────
// ヘルパー
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// H-1対策: CLAUDE.md注入
// ────────────────────────────────────────────────────────────

/**
 * Constitution 3.14〜3.15（AI Team OS共通行動原則）をプロンプト先頭へ1回だけ前置する。
 *
 * Implementation Agentの入力は `job.aiCliPrompt` であり、Context Packは未配線のため、
 * ここで前置しない限り共通行動原則がAgentへ届かない。
 * 対象はControl Repository由来の固定Policyのみで、Task/user入力やfailure context等の
 * 動的情報は扱わない（汎用のcontext注入機構へ拡張しないこと）。
 * 取得できなかった場合も黙って省略せず、未取得である旨をpromptへ明示する。
 */
function prependConstitutionPrinciples(prompt: string): string {
  const principles = loadConstitutionPrinciples()
  const warning = formatConstitutionPrinciplesWarning(principles)
  if (warning) console.warn(`[AiCliAdapter] ${warning}`)

  return [
    '## AI Team OS 共通行動原則（Constitution 3.14〜3.15）',
    '',
    buildConstitutionPrinciplesPrompt(principles),
    '',
    prompt,
  ].join('\n')
}

/**
 * Codex向けにCLAUDE.mdの要点をプロンプト先頭に注入する（Rule-001 H-1）
 *
 * Codex CLI は CLAUDE.md を自動読込しないため、
 * システムの制約（禁止事項・コーディングルール）をプロンプトに含めることで
 * Codexが知らずにルール違反するリスクを排除する。
 */
function injectClaudeMdEssentials(originalPrompt: string): string {
  // CLAUDE.md を探して読み込む
  let claudeMdContent: string | undefined
  for (const claudeMdPath of CLAUDE_MD_PATHS) {
    if (existsSync(claudeMdPath)) {
      try {
        claudeMdContent = readFileSync(claudeMdPath, 'utf-8')
        break
      } catch {
        // 次のパスを試す
      }
    }
  }

  if (!claudeMdContent) {
    console.error('[AiCliAdapter] WARNING: CLAUDE.md が見つかりません。フォールバックルールを使用します。')
    claudeMdContent = CLAUDE_MD_FALLBACK_ESSENTIALS
  }

  // AGENTS.md も読み込む（共同運用ルール + TypeScript品質ルール）
  let agentsMdContent: string | undefined
  for (const p of AGENTS_MD_PATHS) {
    if (existsSync(p)) {
      try { agentsMdContent = readFileSync(p, 'utf-8'); break } catch { /* 次を試す */ }
    }
  }

  return [
    '## ⚠️ システム制約（最優先・必読）',
    '',
    '以下はAI Development Team OSの憲法です。この制約はタスクの内容よりも優先されます。',
    '',
    claudeMdContent,
    '',
    ...(agentsMdContent ? [
      '---',
      '',
      '## 共同運用ルール（AGENTS.md）',
      '',
      agentsMdContent,
    ] : []),
    '',
    '---',
    '',
    '## タスク',
    '',
    originalPrompt,
  ].join('\n')
}

/**
 * CLAUDE.md が見つからない場合のフォールバック（最重要事項のみ）
 * 実際の CLAUDE.md と同期を保つこと
 */
const CLAUDE_MD_FALLBACK_ESSENTIALS = `
絶対禁止:
  - ai-team-backend/ / apps/ / packages/ / specs/ / docs/ / sandbox/ の変更（Control Repository）
  - target-project/ 以外のファイルの編集
  - .env / secret files の読み書き
  - sudo / rm -rf / curl | sh などの危険コマンド

Repository Boundary:
  - 編集可能: /workspace/target 配下のみ
  - 編集不可: /workspace/control 配下（このOSのコード）

コミットルール:
  - コミットメッセージ: [task-xxx] 変更内容の要約
  - テストなしで完了とみなさない
`.trim()

// ────────────────────────────────────────────────────────────
// M-4対策: lint後処理
// ────────────────────────────────────────────────────────────

/**
 * Codex実行後のlint自動実行（Rule-001 M-4）
 * スタイル不一致を自動修正する。失敗しても実行は継続する（non-fatal）。
 */
async function runPostLint(workingDir: string, jobId: string): Promise<void> {
  try {
    const pnpmPath = resolvePnpmPath()
    const { exe, prefixArgs } = resolveWindowsExe(pnpmPath)
    // P1 Phase 2: pnpm の lifecycle script は子孫を fork し得るため封じ込める。
    await runContainedOrThrow({
      jobId,
      attemptId: nextAttemptId('post-lint'),
      argv: [exe, ...prefixArgs, 'lint', '--fix'],
      cwd: workingDir,
      env: buildTargetCommandEnv(),
      timeoutMs: 60_000,  // 1分
    })
  } catch (err) {
    // containment の失敗だけは non-fatal 扱いにしない。lint を諦めることと、
    // workspace に生き残ったプロセスがいるかもしれないことは別問題である。
    if (isContainmentInfrastructureError(err)) throw err
    // lint失敗は警告のみ（ブロックしない）
    // lint結果はFile Change Guard + Meta Reviewer AIが後から確認する
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown'
    console.warn(`[AiCliAdapter] post-lint failed (non-fatal, code=${code}). File Change Guard will check the diff.`)
  }
}

/**
 * プロバイダーごとに必要な環境変数だけを渡す
 * 不要な秘密情報をCLIプロセスに渡さない
 */
function buildSafeEnv(provider: AiCliProvider): NodeJS.ProcessEnv {
  // PATH・HOME・LANG等の基本変数は全プロバイダーで必要
  const base: NodeJS.ProcessEnv = {
    PATH:     process.env.PATH,
    HOME:     process.env.HOME,
    LANG:     process.env.LANG,
    TERM:     process.env.TERM,
    NODE_ENV: process.env.NODE_ENV,
  }

  // プロバイダー固有の認証情報のみ追加
  switch (provider) {
    case 'claude_code':
      return { ...base, ANTHROPIC_API_KEY: process.env.CLAUDE_API_KEY }
    case 'gemini':
      return {
        ...base,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      }
    case 'codex':
      return { ...base, OPENAI_API_KEY: process.env.OPENAI_API_KEY }
    case 'copilot':
      // GITHUB_TOKEN のみで認証可能（PAT不要、実測確認済み 2026-08-26）
      return { ...base, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  }
}

/**
 * 実行後の変更ファイルを検出する。
 *
 * `git diff --name-only HEAD` は untracked を検出せず、失敗時に [] を返して
 * fail-open になっていたため、buildWorktreeManifest() へ置き換えた。
 * 検出できない場合は例外を投げ、呼び出し元（jobRunner）が fail-closed で扱う。
 */
function getChangedFiles(workingDir: string): string[] {
  return buildWorktreeManifest(workingDir).paths
}

/**
 * stdout から summary を抽出する
 * CLIがJSON形式で出力している場合に対応
 */
/**
 * task-023: JSON文字列のパースを試みる
 * stdout内のコードブロックまたは生のJSONオブジェクトを探す
 */
export function tryParseJson(stdout: string): Record<string, unknown> | undefined {
  // ```json ... ``` ブロックを優先
  const jsonBlockMatch = stdout.match(/```json\n([\s\S]+?)\n```/)
  if (jsonBlockMatch) {
    try { return JSON.parse(jsonBlockMatch[1]) } catch { /* fall through */ }
  }
  // 生JSONオブジェクト（最初の { ... } を探す）
  const rawMatch = stdout.match(/\{[\s\S]+\}/)
  if (rawMatch) {
    try { return JSON.parse(rawMatch[0]) } catch { /* fall through */ }
  }
  return undefined
}

function extractSummary(stdout: string): string | undefined {
  try {
    const jsonMatch = stdout.match(/```json\n([\s\S]+?)\n```/) ||
                      stdout.match(/\{[\s\S]+\}/)
    if (!jsonMatch) return undefined
    const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0])
    return typeof parsed.summary === 'string' ? parsed.summary : undefined
  } catch {
    return undefined
  }
}
