/**
 * Context Manager AI（task-103）
 *
 * 役割:
 *   タスク情報（ID・title・description・allowedPaths・acceptanceCriteria・dependencies）と
 *   target-project のファイルシステムを読み込み、
 *   Developer AI が実行前に必要な「Context Pack」を生成する。
 *
 * Context Pack の内容:
 *   - タスク概要（何をするか・受入条件）
 *   - allowedPaths に含まれる既存ファイルの内容（存在する場合）
 *   - 依存タスクのContext Pack要約（再帰的にならないよう1段階のみ）
 *   - tech stack / goal（Project Memoryから）
 *   - 実行時の制約（変更禁止パスなど）
 */

import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { buildConstitutionPrinciplesPrompt, formatConstitutionPrinciplesWarning, loadConstitutionPrinciples } from '@ai-team/shared/src/constitutionPrinciples.js'
import type { Task } from '@ai-team/shared'
import { ALWAYS_FORBIDDEN_PATTERNS } from '@ai-team/worker/src/guards/fileChangeGuard.js'
import { containedRealPath } from '../utils/pathGuard.js'

// ────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────

export interface TaskSummary {
  id: string
  title: string
  description: string
  phase: number
  assignee: string
  dependencies: string[]
  acceptanceCriteria: string[]
  allowedPaths: string[]
  estimatedComplexity: 'small' | 'medium' | 'large'
}

export interface FileContent {
  relativePath: string
  content: string
  /** ファイルが存在しない場合は true（新規作成が必要） */
  isNew: boolean
}

export interface ProjectMemorySummary {
  goal?: string
  designPhilosophy?: string[]
  techStack?: string[]
  mvpScopeDescription?: string
}

export interface ContextPack {
  /** コンテキストを生成した日時 */
  generatedAt: string
  /** 対象タスク */
  task: TaskSummary
  /** target-project のルートパス */
  targetProjectRoot: string
  /** allowedPaths 内の既存ファイル内容 */
  relevantFiles: FileContent[]
  /** Project Memory から読んだプロジェクト概要 */
  projectMemory: ProjectMemorySummary
  /** Developer AI へのインストラクション（プロンプト用） */
  instruction: string
}

/**
 * DB Task を Context Pack 入力（TaskSummary）へ変換する。
 * DB列を追加しない前提のため estimatedComplexity は 'medium' 固定を使う。
 * dependencies は roadmapTaskKey 表示のため、UUID→roadmapTaskKey の解決が必要。
 * 解決できない依存（他Projectや削除済み等）は無視する（配列から除外）。
 */
export function taskToContextPackSummary(
  task: Task,
  allProjectTasks: Task[],
): TaskSummary {
  const roadmapTaskKeyById = new Map(
    allProjectTasks
      .filter((projectTask) => projectTask.roadmapTaskKey !== undefined)
      .map((projectTask) => [projectTask.id, projectTask.roadmapTaskKey as string] as const),
  )

  return {
    id: task.roadmapTaskKey ?? task.id,
    title: task.title,
    description: task.description,
    phase: task.phase ?? 0,
    assignee: task.assignee,
    dependencies: task.dependencies
      .map((dependencyId) => roadmapTaskKeyById.get(dependencyId))
      .filter((roadmapTaskKey): roadmapTaskKey is string => roadmapTaskKey !== undefined),
    acceptanceCriteria: task.acceptanceCriteria ?? [],
    allowedPaths: task.allowedPaths ?? [],
    estimatedComplexity: 'medium',
  }
}

// ────────────────────────────────────────────────────────────
// ファイル収集ヘルパー
// ────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 50_000  // 50KB
const MAX_FILES_PER_PATH = 20
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', '.astro', 'coverage', '.next'])
const IGNORED_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.db', '.db-shm', '.db-wal'])

/** File Change Guard の一覧に無いが、秘密情報を含みうる拡張子・ファイル名。 */
const EXTRA_WITHHELD_PATTERNS = [/\.p12$/i, /\.pfx$/i, /\.keystore$/i, /\.jks$/i, /(^|\/)credentials\.json$/i]

/** collectFiles の再帰の深さ上限（symlink の循環がなくても深すぎる木を辿らない）。 */
const MAX_DIRECTORY_DEPTH = 12

/**
 * root からの相対パスとして**返してはいけない**ファイルか。
 *
 * - dotfile / dot ディレクトリ配下（`.env`・`.secrets/`・`.ssh/` 等）
 * - 既存の File Change Guard が常に禁止しているパターン（`ALWAYS_FORBIDDEN_PATTERNS`: `.env*`・
 *   `*.pem`・`*.key`・`id_rsa` 等）。**一覧を複製せず Guard 本体の export を使う**
 * - 上記に無い証明書・keystore 類（`EXTRA_WITHHELD_PATTERNS`）
 */
function isWithheldPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized.split('/').some((segment) => segment.startsWith('.') && segment !== '.')) return true
  return ALWAYS_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalized))
    || EXTRA_WITHHELD_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * root 内の 1 ファイルを**安全に**読む。関連ファイルと Project Memory の両方がここを通る。
 *
 * 1. realpath が root の内側（symlink で外へ出ない）で、秘密ファイルでない
 * 2. `O_NOFOLLOW | O_NONBLOCK` で開き、**開いた handle を** `fstat` して通常ファイル・サイズ上限・
 *    hardlink でないこと（`nlink === 1`）を確かめてから、その handle から読む。
 *    path で確かめてから path で読む間に差し替えられる隙（TOCTOU）を作らず、FIFO で止まらない
 *
 * 条件を満たさなければ undefined（読まない）。
 */
function readContainedFile(realRoot: string, candidate: string): { relativePath: string; content: string } | undefined {
  const real = containedRealPath(realRoot, candidate)
  if (real === undefined) return undefined
  const relativePath = path.relative(realRoot, real).replace(/\\/g, '/')
  if (isWithheldPath(relativePath)) return undefined

  let fd: number | undefined
  try {
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
    // O_NOFOLLOW は最後の要素にしか効かない。確認後に途中のディレクトリを symlink へ差し替えられても
    // 外を読まないよう、**実際に開いたもの**の場所を /proc/self/fd から確かめ直す。
    // /proc が無い環境では確かめられないので読まない（fail closed）。
    const opened = containedRealPath(realRoot, readlinkSync(`/proc/self/fd/${fd}`))
    if (opened === undefined || opened !== real) return undefined
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE_BYTES || stat.nlink > 1) return undefined
    // 読み取り量も自分で上限を切る（読んでいる間に伸びたファイルで上限を超えない）。
    const buffer = Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const bytesRead = readSync(fd, buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > MAX_FILE_SIZE_BYTES) return undefined
    return { relativePath, content: buffer.subarray(0, length).toString('utf-8') }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function pushFileIfSafe(realRoot: string, candidate: string, result: FileContent[]): void {
  if (IGNORED_EXTS.has(path.extname(candidate).toLowerCase())) return
  const file = readContainedFile(realRoot, candidate)
  if (file) result.push({ ...file, isNew: false })
}

function collectFiles(
  dir: string,
  realRoot: string,
  result: FileContent[],
  limit: number,
  visited: Set<string> = new Set(),
  depth = 0,
): void {
  if (result.length >= limit || depth > MAX_DIRECTORY_DEPTH) return
  // ディレクトリ自体も realpath で root の内側を確かめる（symlink のディレクトリで外へ出ない）。
  const realDir = containedRealPath(realRoot, dir)
  if (realDir === undefined) return
  // 一度辿った実ディレクトリは二度辿らない（`self -> .` / `up -> ..` の循環で重複・暴走しない）。
  if (visited.has(realDir)) return
  visited.add(realDir)
  if (isWithheldPath(path.relative(realRoot, realDir))) return

  let entries: string[]
  try {
    entries = readdirSync(realDir).sort()
  } catch {
    return
  }
  for (const entry of entries) {
    if (result.length >= limit) break
    if (IGNORED_DIRS.has(entry)) continue

    const fullPath = path.join(realDir, entry)
    const real = containedRealPath(realRoot, fullPath)
    if (real === undefined) continue
    let stat
    try {
      stat = statSync(real)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      collectFiles(real, realRoot, result, limit, visited, depth + 1)
    } else if (stat.isFile()) {
      pushFileIfSafe(realRoot, real, result)
    }
  }
}

function gatherRelevantFiles(
  allowedPaths: string[],
  realRoot: string,
): FileContent[] {
  const files: FileContent[] = []

  for (const allowedPath of allowedPaths) {
    const absPath = path.resolve(realRoot, allowedPath)
    // 字句上も root の内側であること（区切り文字込み）。外なら何も返さない。
    if (absPath !== realRoot && !absPath.startsWith(realRoot + path.sep)) continue

    if (!existsSync(absPath)) {
      // パスが存在しない → 新規作成が必要なディレクトリ or ファイル（中身は返さない）
      files.push({
        relativePath: allowedPath,
        content: '',
        isNew: true,
      })
      continue
    }

    const real = containedRealPath(realRoot, absPath)
    if (real === undefined) continue
    let stat
    try {
      stat = statSync(real)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      collectFiles(real, realRoot, files, MAX_FILES_PER_PATH)
    } else if (stat.isFile()) {
      pushFileIfSafe(realRoot, real, files)
    }
  }

  return files
}

// ────────────────────────────────────────────────────────────
// Project Memory 読み込み
// ────────────────────────────────────────────────────────────

/**
 * Project Memory の 1 ファイルを読む。**関連ファイルと同じ `readContainedFile()` を通す**
 * （root 内の `.env` への symlink・FIFO・巨大ファイル・hardlink を読まない。独立レビュー指摘）。
 */
function readMemoryFile(realRoot: string, filePath: string): string | undefined {
  return readContainedFile(realRoot, filePath)?.content
}

function readProjectMemory(realRoot: string): ProjectMemorySummary {
  const memoryDir = path.join(realRoot, 'docs', 'project_memory')
  const summary: ProjectMemorySummary = {}

  try {
    const content = readMemoryFile(realRoot, path.join(memoryDir, 'goal.md'))
    if (content !== undefined) {
      // 最初の段落を goal として取得
      const match = content.match(/^#[^\n]*\n+([\s\S]+?)(\n\n|$)/)
      summary.goal = match ? match[1].trim() : content.slice(0, 200).trim()
    }
  } catch { /* noop */ }

  try {
    const content = readMemoryFile(realRoot, path.join(memoryDir, 'design_philosophy.md'))
    if (content !== undefined) {
      summary.designPhilosophy = content
        .split('\n')
        .filter(l => l.startsWith('- ') || l.startsWith('* '))
        .map(l => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean)
    }
  } catch { /* noop */ }

  try {
    const content = readMemoryFile(realRoot, path.join(memoryDir, 'mvp_scope.md'))
    if (content !== undefined) {
      const match = content.match(/^#[^\n]*\n+([\s\S]+?)(\n\n|$)/)
      summary.mvpScopeDescription = match ? match[1].trim() : ''
    }
  } catch { /* noop */ }

  return summary
}

// ────────────────────────────────────────────────────────────
// インストラクション生成
// ────────────────────────────────────────────────────────────

function buildInstruction(task: TaskSummary, projectMemory: ProjectMemorySummary): string {
  const constitutionPrinciples = loadConstitutionPrinciples()
  const constitutionWarning = formatConstitutionPrinciplesWarning(constitutionPrinciples)
  if (constitutionWarning) console.warn(constitutionWarning)
  const lines: string[] = [
    `# Developer AI — Task: ${task.id}`,
    '',
    'AI Team OS共通行動原則は `specs/00_constitution.md` 3.14〜3.15（最小検証・必要最小反証／CEO確認最小化・自律判断）を正本として適用し、明示的なSafety Ruleを常に優先してください。',
    buildConstitutionPrinciplesPrompt(constitutionPrinciples),
    '',
    `## あなたの使命`,
    `**${task.title}** を実装してください。`,
    `${task.description}`,
    '',
  ]

  if (projectMemory.goal) {
    lines.push(`## プロジェクトの目標`, projectMemory.goal, '')
  }

  if (task.acceptanceCriteria.length > 0) {
    lines.push('## 受入条件（すべて満たすこと）')
    task.acceptanceCriteria.forEach(c => lines.push(`- [ ] ${c}`))
    lines.push('')
  }

  lines.push('## 変更可能パス（これ以外は変更禁止）')
  task.allowedPaths.forEach(p => lines.push(`- \`${p}\``))
  lines.push('')

  if (task.dependencies.length > 0) {
    lines.push(`## 依存タスク`, task.dependencies.join(', '), '')
  }

  lines.push(
    '## 実装ルール',
    '- TypeScript で書く（型エラーがないこと）',
    '- テストを書く（vitest）',
    '- allowedPaths 外のファイルは変更しない',
    '- `.env` やシークレットをハードコードしない',
    '- 完了後に「実装完了」と報告する',
    '',
  )

  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// メイン関数
// ────────────────────────────────────────────────────────────

/**
 * Context Pack を作る。**読み取りは `targetProjectRoot` の realpath の内側に閉じる**
 * （symlink で外へ出ない・秘密ファイルと dotfile を返さない）。root 自体の妥当性（設定済み
 * target root と一致すること）は呼び出し側が `resolveContextPackRoot()` で確かめる。
 */
export function buildContextPack(
  task: TaskSummary,
  targetProjectRoot: string,
): ContextPack {
  let realRoot: string
  try {
    realRoot = realpathSync(targetProjectRoot)
  } catch {
    throw new Error('target root does not exist')
  }
  const relevantFiles = gatherRelevantFiles(task.allowedPaths, realRoot)
  const projectMemory = readProjectMemory(realRoot)
  const instruction = buildInstruction(task, projectMemory)

  return {
    generatedAt: new Date().toISOString(),
    task,
    targetProjectRoot,
    relevantFiles,
    projectMemory,
    instruction,
  }
}
