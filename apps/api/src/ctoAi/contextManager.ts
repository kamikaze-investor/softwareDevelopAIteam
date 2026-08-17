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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Task } from '@ai-team/shared'

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

function collectFiles(
  dir: string,
  baseDir: string,
  result: FileContent[],
  limit: number,
): void {
  if (result.length >= limit) return
  if (!existsSync(dir)) return

  const entries = readdirSync(dir)
  for (const entry of entries) {
    if (result.length >= limit) break
    if (IGNORED_DIRS.has(entry)) continue

    const fullPath = path.join(dir, entry)
    const stat = statSync(fullPath)

    if (stat.isDirectory()) {
      collectFiles(fullPath, baseDir, result, limit)
    } else {
      const ext = path.extname(entry).toLowerCase()
      if (IGNORED_EXTS.has(ext)) continue
      if (stat.size > MAX_FILE_SIZE_BYTES) continue

      try {
        const content = readFileSync(fullPath, 'utf-8')
        result.push({
          relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
          content,
          isNew: false,
        })
      } catch {
        // 読めないファイルはスキップ
      }
    }
  }
}

function gatherRelevantFiles(
  allowedPaths: string[],
  targetProjectRoot: string,
): FileContent[] {
  const files: FileContent[] = []

  for (const allowedPath of allowedPaths) {
    const absPath = path.isAbsolute(allowedPath)
      ? allowedPath
      : path.join(targetProjectRoot, allowedPath)

    if (!existsSync(absPath)) {
      // パスが存在しない → 新規作成が必要なディレクトリ or ファイル
      files.push({
        relativePath: allowedPath,
        content: '',
        isNew: true,
      })
      continue
    }

    const stat = statSync(absPath)
    if (stat.isDirectory()) {
      collectFiles(absPath, targetProjectRoot, files, MAX_FILES_PER_PATH)
    } else {
      const ext = path.extname(absPath).toLowerCase()
      if (!IGNORED_EXTS.has(ext) && stat.size <= MAX_FILE_SIZE_BYTES) {
        try {
          files.push({
            relativePath: path.relative(targetProjectRoot, absPath).replace(/\\/g, '/'),
            content: readFileSync(absPath, 'utf-8'),
            isNew: false,
          })
        } catch {
          // スキップ
        }
      }
    }
  }

  return files
}

// ────────────────────────────────────────────────────────────
// Project Memory 読み込み
// ────────────────────────────────────────────────────────────

function readProjectMemory(targetProjectRoot: string): ProjectMemorySummary {
  const memoryDir = path.join(targetProjectRoot, 'docs', 'project_memory')
  const summary: ProjectMemorySummary = {}

  try {
    const goalPath = path.join(memoryDir, 'goal.md')
    if (existsSync(goalPath)) {
      const content = readFileSync(goalPath, 'utf-8')
      // 最初の段落を goal として取得
      const match = content.match(/^#[^\n]*\n+([\s\S]+?)(\n\n|$)/)
      summary.goal = match ? match[1].trim() : content.slice(0, 200).trim()
    }
  } catch { /* noop */ }

  try {
    const dpPath = path.join(memoryDir, 'design_philosophy.md')
    if (existsSync(dpPath)) {
      const content = readFileSync(dpPath, 'utf-8')
      summary.designPhilosophy = content
        .split('\n')
        .filter(l => l.startsWith('- ') || l.startsWith('* '))
        .map(l => l.replace(/^[-*]\s+/, '').trim())
        .filter(Boolean)
    }
  } catch { /* noop */ }

  try {
    const mvpPath = path.join(memoryDir, 'mvp_scope.md')
    if (existsSync(mvpPath)) {
      const content = readFileSync(mvpPath, 'utf-8')
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
  const lines: string[] = [
    `# Developer AI — Task: ${task.id}`,
    '',
    'AI Team OS共通行動原則は `specs/00_constitution.md` 3.14〜3.15（最小検証・必要最小反証／CEO確認最小化・自律判断）を正本として適用し、明示的なSafety Ruleを常に優先してください。',
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

export function buildContextPack(
  task: TaskSummary,
  targetProjectRoot: string,
): ContextPack {
  const relevantFiles = gatherRelevantFiles(task.allowedPaths, targetProjectRoot)
  const projectMemory = readProjectMemory(targetProjectRoot)
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
