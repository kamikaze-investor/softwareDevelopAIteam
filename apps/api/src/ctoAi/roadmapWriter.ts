/**
 * CTO AI — Roadmap / Task一覧 ファイルライター（task-102）
 *
 * generateRoadmap() の結果を target-project の以下パスに書き出す:
 *   docs/roadmap.md
 *   tasks/task_graph.md
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Roadmap, GeneratedTask } from './roadmapGenerator.js'
import { commitGeneratedDocs } from './commitGeneratedDocs.js'

export interface RoadmapWriteResult {
  writtenFiles: string[]
  targetDir: string
}

// ────────────────────────────────────────────────────────────
// マークダウン生成ヘルパー
// ────────────────────────────────────────────────────────────

function complexityLabel(c: GeneratedTask['estimatedComplexity']): string {
  return { small: '🟢 S', medium: '🟡 M', large: '🔴 L' }[c]
}

export function buildRoadmapMd(roadmap: Roadmap): string {
  const lines: string[] = [
    '# Roadmap',
    '',
    `> 生成日時: ${new Date().toISOString()}`,
    `> 総タスク数: ${roadmap.totalTasks} / 想定期間: ${roadmap.estimatedWeeks} 週`,
    '',
  ]

  for (const phase of roadmap.phases) {
    lines.push(`## Phase ${phase.number}: ${phase.name}`, '')
    lines.push(`**Goal**: ${phase.goal}`, '')
    const phaseTasks = roadmap.tasks.filter(t => t.phase === phase.number)
    for (const task of phaseTasks) {
      lines.push(`### ${task.id}: ${task.title}`)
      lines.push(`- **担当**: ${task.assignee}`)
      lines.push(`- **規模**: ${complexityLabel(task.estimatedComplexity)}`)
      if (task.dependencies.length > 0) {
        lines.push(`- **依存**: ${task.dependencies.join(', ')}`)
      }
      lines.push(`- **説明**: ${task.description}`)
      if (task.acceptanceCriteria.length > 0) {
        lines.push('- **受入条件**:')
        task.acceptanceCriteria.forEach(c => lines.push(`  - ${c}`))
      }
      if (task.allowedPaths.length > 0) {
        lines.push(`- **変更可能パス**: \`${task.allowedPaths.join('`, `')}\``)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function buildTaskGraphMd(roadmap: Roadmap): string {
  const lines: string[] = [
    '# Task Graph',
    '',
    `**生成日時**: ${new Date().toISOString()}`,
    `**ステータス凡例**: \`[ ]\` 未着手 / \`[>]\` 進行中 / \`[x]\` 完了 / \`[!]\` ブロック`,
    '',
  ]

  for (const phase of roadmap.phases) {
    lines.push(`## Phase ${phase.number}: ${phase.name}`)
    lines.push('')
    lines.push('| ID | タイトル | ステータス | 依存 | 担当 | 規模 |')
    lines.push('|---|---|---|---|---|---|')

    const phaseTasks = roadmap.tasks.filter(t => t.phase === phase.number)
    for (const task of phaseTasks) {
      const deps = task.dependencies.length > 0 ? task.dependencies.join(' ') : '—'
      lines.push(
        `| ${task.id} | ${task.title} | [ ] | ${deps} | ${task.assignee} | ${complexityLabel(task.estimatedComplexity)} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ────────────────────────────────────────────────────────────
// メインライター
// ────────────────────────────────────────────────────────────

export function writeRoadmap(
  roadmap: Roadmap,
  targetProjectRoot: string,
): RoadmapWriteResult {
  const docsDir = path.join(targetProjectRoot, 'docs')
  const tasksDir = path.join(targetProjectRoot, 'tasks')

  mkdirSync(docsDir, { recursive: true })
  mkdirSync(tasksDir, { recursive: true })

  const roadmapPath = path.join(docsDir, 'roadmap.md')
  const taskGraphPath = path.join(tasksDir, 'task_graph.md')

  writeFileSync(roadmapPath, buildRoadmapMd(roadmap), 'utf-8')
  writeFileSync(taskGraphPath, buildTaskGraphMd(roadmap), 'utf-8')

  // CTO AIが機械的に生成したドキュメントをその場でcommitする。
  // uncommittedのまま残すと、直後にauto-startされる実装JobのFile Change Guardが
  // これらを誤って「Taskによる変更」として検出し、allowedPaths外として誤blockする。
  commitGeneratedDocs(
    targetProjectRoot,
    [roadmapPath, taskGraphPath],
    'chore(cto-ai): update roadmap docs',
  )

  return {
    writtenFiles: [roadmapPath, taskGraphPath],
    targetDir: targetProjectRoot,
  }
}
