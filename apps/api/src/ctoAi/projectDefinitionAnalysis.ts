/**
 * Interactive Project Definition / Readiness（roadmap item
 * interactive-project-definition-readiness）
 *
 * 通常のMobile Project作成体験（名前・Goal・Design Philosophyを入力してすぐ開始できる）は
 * 維持したまま、既存のGap Analysis（specAnalyzer）を「重要なGapがある場合だけ」通常導線へ
 * 接続するためのアダプタ。CEOが手入力する構造化フィールドは増やさず、自然言語のGoal/Design
 * Philosophyから機械的に構造化制約・Gapを抽出する。
 */

import { createHash } from 'node:crypto'
import { analyzeSpec, type SpecAnalysis, type SpecAnalyzerOptions } from './specAnalyzer.js'

export const PROJECT_DEFINITION_READY_MIN_SCORE = 70

/**
 * readinessScore が低いのに具体的な must_resolve Gap が1件もない場合に使う、固定の説明文。
 * Mobile側のGap回答画面（`gaps.tsx`）はGap一覧を前提にした「質問カード＋回答欄」のUIしか
 * 持たないため、ここでGapを合成しないと画面に何も入力できる項目がない行き止まりになる
 * （独立レビュー指摘、2026-09-01）。key（description）は固定にし、CEOの回答は他のGapと
 * 同じ`gapAnswers`の枠組みでそのまま次回解析へ渡す。新しい質問経路・新しいUIは追加しない。
 */
const READINESS_CLARIFICATION_GAP_DESCRIPTION =
  '開発を安全に始めるには、Project Definitionの情報がまだ十分ではありません。もう少し詳しく教えてください。'

export interface ProjectDefinitionInput {
  goal: string
  designPhilosophy: string[]
  /** 前回提示したGapに対するCEOの回答（key: gapの description、value: 回答本文） */
  gapAnswers?: Record<string, string>
}

/**
 * specAnalyzer（Claude Haiku、`docs/project_memory/`の生成にも使う既存の解析器）へ渡す
 * 仕様書テキストを、Project.goal / designPhilosophy / 過去のGap回答から組み立てる。
 * 新しい入力欄・新しいLLM呼び出し経路は追加せず、既存`analyzeSpec()`をそのまま再利用する。
 */
export function buildSpecTextFromProjectDefinition(input: ProjectDefinitionInput): string {
  const sections = [`# Goal\n\n${input.goal}`]

  if (input.designPhilosophy.length > 0) {
    sections.push(`# Design Philosophy\n\n${input.designPhilosophy.map((item) => `- ${item}`).join('\n')}`)
  }

  const answers = Object.entries(input.gapAnswers ?? {}).filter(([, answer]) => answer.trim().length > 0)
  if (answers.length > 0) {
    sections.push(
      [
        '# CEOからの追加回答（Gap Analysisへの回答）',
        '',
        ...answers.map(([question, answer]) => `- ${question}\n  → ${answer}`),
      ].join('\n'),
    )
  }

  return sections.join('\n\n')
}

export function computeProjectDefinitionHash(canonicalText: string): string {
  return createHash('sha256').update(canonicalText, 'utf-8').digest('hex')
}

export interface ProjectDefinitionReadiness {
  ready: boolean
  reason: string
  importantGaps: SpecAnalysis['gaps']
  readinessScore: number
  readinessReason: string
}

export function isProjectDefinitionReady(analysis: SpecAnalysis): ProjectDefinitionReadiness {
  const importantGaps = analysis.gaps.filter((gap) => gap.severity === 'must_resolve')
  if (importantGaps.length > 0) {
    return {
      ready: false,
      reason: 'Project Definition has unresolved gaps',
      importantGaps,
      readinessScore: analysis.readinessScore,
      readinessReason: analysis.readinessReason,
    }
  }

  if (analysis.readinessScore < PROJECT_DEFINITION_READY_MIN_SCORE) {
    // 具体的なGapが無いまま単にスコアだけで止める場合、Mobileの回答画面に入力できる項目が
    // 無いままにしない。既存のGap回答フロー（category/description/suggestion + 自由記述欄）を
    // そのまま再利用する合成Gapを1件返す。
    const clarificationGap: SpecAnalysis['gaps'][number] = {
      category: 'other',
      description: READINESS_CLARIFICATION_GAP_DESCRIPTION,
      severity: 'must_resolve',
      suggestion: analysis.readinessReason,
    }
    return {
      ready: false,
      reason: `Project Definition readiness score is below ${PROJECT_DEFINITION_READY_MIN_SCORE}`,
      importantGaps: [clarificationGap],
      readinessScore: analysis.readinessScore,
      readinessReason: analysis.readinessReason,
    }
  }

  return {
    ready: true,
    reason: 'Project Definition is ready',
    importantGaps,
    readinessScore: analysis.readinessScore,
    readinessReason: analysis.readinessReason,
  }
}

export interface ProjectDefinitionAnalysisResult {
  analysis: SpecAnalysis
  canonicalDefinitionText: string
  definitionHash: string
  /**
   * 「重要なGap」= severity: 'must_resolve'。既存`POST /api/cto/analyze`が
   * readinessチェックに使う分類と同じ基準を再利用する（新しい重要度体系を作らない）。
   * `should_resolve`/`optional`はCEOに聞かず自動確定として扱い、通常のProject作成体験を
   * 妨げない。
   */
  importantGaps: SpecAnalysis['gaps']
  readiness: ProjectDefinitionReadiness
}

export async function analyzeProjectDefinition(
  input: ProjectDefinitionInput,
  options: SpecAnalyzerOptions = {},
): Promise<ProjectDefinitionAnalysisResult> {
  const specText = buildSpecTextFromProjectDefinition(input)
  const analysis = await analyzeSpec(specText, options)
  const readiness = isProjectDefinitionReady(analysis)
  return {
    analysis,
    canonicalDefinitionText: specText,
    definitionHash: computeProjectDefinitionHash(specText),
    importantGaps: readiness.importantGaps,
    readiness,
  }
}
