import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * DB / API / Mobile を軽く保つためのプレビュー上限。**検証証跡の上限ではない。**
 * 全文は `stdoutPath` に最大 `MAX_LOG_SIZE` で保存されているので、
 * 「プレビューに無い＝出力されていない」は成り立たない（`readSafeCommandEvidence` 参照）。
 */
export const PREVIEW_LENGTH = 4000
const PREVIEW_TRUNCATION_NOTICE = '\n[表示上限を超えたため一部省略されています]'
const MAX_LOG_SIZE = 1_000_000

/**
 * SafeCommand の出力**だけ**を入れるファイル。`stdout.txt` は AI CLI の出力と連結されており、
 * 両者の境界は見出し文字列でしか表せない。見出しは AI CLI の出力にも、AI が書いたテストの
 * 出力にも現れ得るので、**文字列探索では「これは Worker が実行したコマンドの出力である」を
 * 保証できない**。Worker は書く時点で両者を持っているので、書き分けておく。
 */
const SAFE_COMMAND_LOG_FILENAME = 'safecommand-stdout.txt'

export interface JobLogPaths {
  stdoutPath: string
  stderrPath: string
  stdoutPreview: string
  stderrPreview: string
}

/**
 * @param safeCommandStdout SafeCommand 単体の stdout。渡された場合だけ専用ファイルへも保存する。
 *   AI CLI 自身のログ保存（`adapter.ts`）のように SafeCommand を伴わない呼び出しでは省略する。
 */
export function saveJobLogs(
  jobId: string,
  stdout: string,
  stderr: string,
  safeCommandStdout?: string,
): JobLogPaths {
  const jobLogDir = resolveJobLogDir(jobId)
  mkdirSync(jobLogDir, { recursive: true })

  const stdoutPath = path.join(jobLogDir, 'stdout.txt')
  const stderrPath = path.join(jobLogDir, 'stderr.txt')

  writeFileSync(stdoutPath, truncateLog(stdout), 'utf-8')
  writeFileSync(stderrPath, truncateLog(stderr), 'utf-8')
  if (safeCommandStdout !== undefined) {
    writeFileSync(path.join(jobLogDir, SAFE_COMMAND_LOG_FILENAME), truncateLog(safeCommandStdout), 'utf-8')
  }

  return {
    stdoutPath,
    stderrPath,
    ...buildLogPreviews(stdout, stderr),
  }
}

/**
 * stdout / stderr のプレビューを構築する。
 * ログ永続化（ファイル書き込み）に失敗しても、実行結果とプレビューは
 * 失われないようにするため、saveJobLogs の失敗時にもこのヘルパーを
 * 単体で使えるよう分離して export する。
 */
export function buildLogPreviews(
  stdout: string,
  stderr: string,
): { stdoutPreview: string; stderrPreview: string } {
  return {
    stdoutPreview: buildPreview(stdout),
    stderrPreview: buildPreview(stderr),
  }
}

/**
 * SafeCommand 出力セクションの見出し。combinedStdout を組み立てる側（jobRunner）と、
 * 後から検証証跡を取り出す側（`readSafeCommandEvidence`）が**同じ1か所**を使う。
 * リテラルを2か所に置くと、片方だけ変えたときに「見出しが見つからない＝未実行」と
 * 読み違える経路が生まれる。
 */
export function safeCommandSectionHeader(kind: string): string {
  return `=== SafeCommand (${kind}) ===`
}

/**
 * 検証証跡をどこから取れたか。**`unseparable` / `unavailable` は「取得できなかった」であって
 * 「未実行」ではない。** この区別が消えると、実際には通っている検証を reviewer が「未実行」と誤認する。
 *
 * - `safe_command_log`: SafeCommand の出力だけを保存した専用ファイル。分離が構造的に保証される
 * - `full_log`: 連結ログから切り出した（専用ファイルが無い旧 Job）。分離は見出し探索に依存する
 * - `unseparable`: 全文は読めたが SafeCommand の出力を分離できない
 * - `unavailable`: ログを読めない
 */
export type SafeCommandEvidenceSource = 'safe_command_log' | 'full_log' | 'unseparable' | 'unavailable'

export interface SafeCommandEvidence {
  source: SafeCommandEvidenceSource
  /**
   * SafeCommand の出力だけを取り出せたか。false は「分離できなかった」であって、未実行の証拠ではない。
   * false のとき `excerpt` / `summaryLines` は**空にする**（分離できない内容を検証証跡として出さない）。
   */
  separated: boolean
  /** bounded 抽出済みの抜粋。全文ではない */
  excerpt: string
  /** 抜粋で落とした文字数。0 なら落としていない */
  omittedChars: number
  /**
   * 位置に依存せず拾った集計行（head/tail の抜粋から落ちる中間分を補う）。
   * **網羅ではない。** ここに無いことは、その workspace が走らなかった証拠ではない。
   */
  summaryLines: string[]
  note: string
}

/**
 * prompt へ載せる抜粋の上限。全文は最大 1MB あり得るのでそのままは載せない。
 * 先頭（実行コマンドのエコー・早く終わった workspace の集計）と
 * 末尾（最後に終わった workspace の集計）の両方が要るので head + tail で取る。
 */
const EVIDENCE_HEAD_CHARS = 2_000
const EVIDENCE_TAIL_CHARS = 18_000
/** `truncateLog` の上限の2倍。これを超えるファイルは Job ログとして想定外なので読まない */
const EVIDENCE_MAX_FILE_BYTES = MAX_LOG_SIZE * 2

/**
 * 集計行として拾う形。`commandResolver` が出しうるのは pnpm script（vitest / tsc / pnpm 自身）
 * だけなので、その3つの終了サマリ形だけを対象にする。**網羅性は主張しない**（`extractSummaryLines` 参照）。
 */
const SUMMARY_LINE_PATTERNS: RegExp[] = [
  /Test Files\s/,      // vitest: "Test Files  88 passed (88)"
  /\bTests\s{2}/,      // vitest: "     Tests  1534 passed (1534)"
  /Duration\s{2}/,     // vitest: "  Duration  65.62s"
  /ELIFECYCLE/,        // pnpm: script 失敗
  /error TS\d+/,       // tsc
]
const SUMMARY_LINE_MAX_COUNT = 60
const SUMMARY_LINE_MAX_CHARS = 300
const SUMMARY_TOTAL_MAX_CHARS = 4_000

/**
 * implement Job の全文ログから SafeCommand セクションだけを bounded に取り出す。
 *
 * **なぜ必要か**: DB の `job.stdout` は先頭 `PREVIEW_LENGTH` 字のプレビューで、
 * combinedStdout は `=== AI CLI (...) ===` セクションが先頭に来る。AI CLI の
 * JSON envelope だけで数KBあるため、**SafeCommand セクションはプレビューに構造的に入らない**。
 * プレビューを検証証跡として使うと、実際には全テストが通っていても
 * 「テスト未実行」と読める（2026-09-24 Production Job 569cd4ae で実際に発生）。
 */
export function readSafeCommandEvidence(input: {
  kind: string
  stdoutPath?: string
  /** implement Job が AI CLI を伴ったか。伴わない Job のログは全体が SafeCommand の出力である */
  aiCliUsed: boolean
}): SafeCommandEvidence {
  // 1) SafeCommand 専用ファイル。分離が構造的に保証されるので最優先で使う。
  const dedicated = readJobLogFile(resolveSafeCommandLogPath(input.stdoutPath))
  if (dedicated !== undefined) {
    return {
      source: 'safe_command_log',
      separated: true,
      ...boundExcerpt(dedicated),
      summaryLines: extractSummaryLines(dedicated),
      note: `SafeCommand 専用ログ（${dedicated.length}字）。AI CLI の出力とは別ファイルに保存されているので、分離に文字列探索を使っていない。`,
    }
  }

  const full = readJobLogFile(input.stdoutPath)
  if (full === undefined) {
    return {
      source: 'unavailable',
      separated: false,
      excerpt: '',
      omittedChars: 0,
      summaryLines: [],
      note: 'verification evidence unavailable — ログを読めない。**未実行と断定してはならない。** DB プレビューは検証証跡ではないので、ここには載せていない（[implement Job結果].stdoutPreview を参照）。',
    }
  }

  // 2) AI CLI を伴わない Job は、連結が起きないのでログ全体が SafeCommand の出力である。
  if (!input.aiCliUsed) {
    return {
      source: 'full_log',
      separated: true,
      ...boundExcerpt(full),
      summaryLines: extractSummaryLines(full),
      note: `AI CLI を伴わない Job のため、ログ全体（${full.length}字）が SafeCommand の出力である。`,
    }
  }

  // 3) 専用ファイルが無い旧 Job。見出しで切り出すしかない。
  //    見出しより前は AI CLI が自由に書ける領域なので、最後の出現を採る。
  //    ただし SafeCommand が実行するコード自体も AI が書いたものなので、**見出しより後ろの
  //    出現まで排除できるわけではない**。この経路の分離は保証ではなく最善努力であり、
  //    その旨を note で明示する。
  const header = safeCommandSectionHeader(input.kind)
  const index = full.lastIndexOf(header)
  if (index < 0) {
    return {
      source: 'unseparable',
      separated: false,
      excerpt: '',
      omittedChars: 0,
      summaryLines: [],
      note: `ログは読めたが ${header} が無く、AI CLI の出力と SafeCommand の出力を分離できない。**分離できない内容を検証証跡としては出さない。** 未実行の証拠ではない。`,
    }
  }
  const section = full.slice(index)
  const occurrences = countOccurrences(full, header)
  return {
    source: 'full_log',
    separated: true,
    ...boundExcerpt(section),
    summaryLines: extractSummaryLines(section),
    note: `SafeCommand 専用ログが無い旧 Job のため、連結ログ（${full.length}字）から ${header} 以降を切り出した`
      + (occurrences > 1 ? `（見出しは${occurrences}箇所あり、最後のものを採った）` : '')
      + '。この切り出しは最善努力であり、コマンド自身の出力に同じ見出しが現れた場合はそれ以降だけが残る。機械的に確定しているのは exitCode である。',
  }
}

/** `<jobLogDir>/stdout.txt` の隣にある SafeCommand 専用ログのパス */
function resolveSafeCommandLogPath(stdoutPath: string | undefined): string | undefined {
  if (stdoutPath === undefined || stdoutPath === '') return undefined
  return path.join(path.dirname(stdoutPath), SAFE_COMMAND_LOG_FILENAME)
}

/**
 * Job ログ root 配下の**通常ファイル**だけを読む。`stdoutPath` は Job レコード由来なので、
 * 渡されたパスをそのまま開かない（fail-closed）。読めない場合は undefined を返し、
 * 呼び出し側は「取得できなかった」として扱う。
 *
 * 字句的な root 判定だけでは、root 内に置かれた symlink が root 外を指す経路を塞げない。
 * `realpathSync` で解決してから改めて root 内か見る。さらに、判定と読み取りの間に
 * 差し替えられないよう **開いた fd 自身**を `fstatSync` で見る。
 */
function readJobLogFile(stdoutPath: string | undefined): string | undefined {
  if (stdoutPath === undefined || stdoutPath === '') return undefined

  let fd: number | undefined
  try {
    const root = realpathSync(resolveJobLogRoot())
    const resolved = path.resolve(stdoutPath)
    if (!isPathInside(resolved, root)) return undefined

    // 字句判定だけでは root 内に置かれた link が root 外を指す経路を塞げない
    const real = realpathSync(resolved)
    if (!isPathInside(real, root)) return undefined
    // 解決後の最終要素が通常ファイルであること（link へ張り替えられていないこと）
    if (!lstatSync(real).isFile()) return undefined

    fd = openSync(real, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile()) return undefined
    if (stat.size > EVIDENCE_MAX_FILE_BYTES) return undefined

    // **開いた後にファイルが伸びても読み過ぎない。** `readFileSync(fd)` は EOF まで読むため、
    // fstat で見たサイズが上限の役に立たなくなる。offset 0 から stat.size バイトだけ読む。
    const buffer = Buffer.alloc(stat.size)
    let read = 0
    while (read < stat.size) {
      const chunk = readSync(fd, buffer, read, stat.size - read, read)
      if (chunk === 0) break
      read += chunk
    }
    return buffer.subarray(0, read).toString('utf-8')
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // クローズ失敗は証跡の内容に影響しない
      }
    }
  }
}

/**
 * 集計行だけを**位置に依存せず**拾う。head/tail の抜粋は、`pnpm --parallel` で
 * 中間に終わった workspace の集計を落とし得る（先頭でも末尾でもない位置に出る）。
 * 落ちた集計を「その workspace は走っていない」と読まれるのが一番重い誤読なので、
 * 抜粋とは別に集計行だけを bounded に保持する。
 *
 * **網羅ではない。** ここに載らないことは未実行の証拠ではなく、prompt 側でもそう明示する。
 *
 * **真正性も保証しない。** 走らせるコード自体を書いたのは implement AI なので、
 * このパターンに一致する行を任意に出力させられるし、上限まで埋めて本物を押し出すこともできる。
 * 機械的に確定しているのは `exitCode` だけであり、prompt 側でもそう明示する。
 */
function extractSummaryLines(text: string): string[] {
  const lines: string[] = []
  let chars = 0
  for (const line of text.split('\n')) {
    if (!SUMMARY_LINE_PATTERNS.some((pattern) => pattern.test(line))) continue
    const trimmed = line.length > SUMMARY_LINE_MAX_CHARS ? `${line.slice(0, SUMMARY_LINE_MAX_CHARS)}…` : line
    if (lines.length >= SUMMARY_LINE_MAX_COUNT || chars + trimmed.length > SUMMARY_TOTAL_MAX_CHARS) {
      lines.push('…[集計行の上限に達したため以降は省略]')
      break
    }
    lines.push(trimmed)
    chars += trimmed.length
  }
  return lines
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function boundExcerpt(text: string): { excerpt: string; omittedChars: number } {
  const max = EVIDENCE_HEAD_CHARS + EVIDENCE_TAIL_CHARS
  if (text.length <= max) return { excerpt: text, omittedChars: 0 }

  const omittedChars = text.length - max
  return {
    excerpt: `${text.slice(0, EVIDENCE_HEAD_CHARS)}\n…[中略 ${omittedChars} 文字]…\n${text.slice(-EVIDENCE_TAIL_CHARS)}`,
    omittedChars,
  }
}

function resolveJobLogRoot(): string {
  return path.resolve(process.env.JOB_LOG_DIR ?? path.resolve(process.cwd(), 'data', 'logs'))
}

function resolveJobLogDir(jobId: string): string {
  const rootDir = resolveJobLogRoot()
  const jobLogDir = path.resolve(rootDir, jobId)

  if (!isPathInside(jobLogDir, rootDir)) {
    throw new Error(`Invalid job log path for job ${jobId}`)
  }

  return jobLogDir
}

function isPathInside(targetPath: string, rootDir: string): boolean {
  const relative = path.relative(rootDir, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function buildPreview(output: string): string {
  if (output.length <= PREVIEW_LENGTH) return output
  return output.slice(0, PREVIEW_LENGTH) + PREVIEW_TRUNCATION_NOTICE
}

function truncateLog(output: string): string {
  if (output.length <= MAX_LOG_SIZE) {
    return output
  }

  return `${output.slice(0, MAX_LOG_SIZE)}\n[truncated]`
}
