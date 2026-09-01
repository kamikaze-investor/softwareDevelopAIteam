/**
 * Interactive Project Definition / Readiness（roadmap item
 * interactive-project-definition-readiness）
 *
 * 通常のMobile Project作成体験（名前・Goal・Design Philosophyを入力してすぐ開始できる）は
 * 維持したまま、既存のGap Analysis（specAnalyzer）を「重要なGapがある場合だけ」通常導線へ
 * 接続するためのアダプタ。CEOが手入力する構造化フィールドは増やさず、自然言語のGoal/Design
 * Philosophyから機械的に構造化制約・Gapを抽出する。
 */

import { analyzeSpec, type SpecAnalysis, type SpecAnalyzerOptions } from './specAnalyzer.js'

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

export interface ProjectDefinitionAnalysisResult {
  analysis: SpecAnalysis
  /**
   * 「重要なGap」= severity: 'must_resolve'。既存`POST /api/cto/analyze`が
   * readinessチェックに使う分類と同じ基準を再利用する（新しい重要度体系を作らない）。
   * `should_resolve`/`optional`はCEOに聞かず自動確定として扱い、通常のProject作成体験を
   * 妨げない。
   */
  importantGaps: SpecAnalysis['gaps']
}

export async function analyzeProjectDefinition(
  input: ProjectDefinitionInput,
  options: SpecAnalyzerOptions = {},
): Promise<ProjectDefinitionAnalysisResult> {
  const specText = buildSpecTextFromProjectDefinition(input)
  const analysis = await analyzeSpec(specText, options)
  const importantGaps = analysis.gaps.filter((gap) => gap.severity === 'must_resolve')
  return { analysis, importantGaps }
}
