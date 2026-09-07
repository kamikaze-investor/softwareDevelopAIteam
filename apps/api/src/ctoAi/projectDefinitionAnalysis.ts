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

/**
 * CEOへ質問すべきGapかどうか。
 *
 * 判定軸は`gap.decisionOwner`（誰が解決できるか）**だけ**で、`category`（主題）は見ない。
 * technicalな主題でもCEOの判断が要るもの（「既存の挙動を変えてよいか」等）はあり、
 * 逆に`other`に分類された実装詳細もあるため、categoryは決定権の所在のproxyにならない。
 *
 * **明示的に`'ai'`のときだけ**CEOへの質問を抑制する。欠落（owner軸を持たない旧形式の応答・
 * モデルが値を落とした応答）も、解釈不能な値も、すべてCEO側へfail-closedになる。
 * `=== 'ceo'`ではなく`!== 'ai'`で判定しているのはそのため — CEOが決めるべき問いを黙って
 * 落として誤った意図のままProjectを開始する方が、質問がノイズになるより重い。
 *
 * Zod側（`specAnalyzer.ts`のGapSchema）でも想定外の値はundefinedへ握りつぶしているが、
 * `isProjectDefinitionReady()`はZodを通さないSpecAnalysisからも呼ばれうるため、ここでも
 * 独立してfail-closedにする。
 */
function requiresCeoDecision(gap: SpecAnalysis['gaps'][number]): boolean {
  return gap.decisionOwner !== 'ai'
}

export function isProjectDefinitionReady(analysis: SpecAnalysis): ProjectDefinitionReadiness {
  // `analysis.gaps`自体はここで絞らない。`decisionOwner: 'ai'`のGapはCEOへ出さないだけで、
  // 情報としては破棄せず、既存のProject Memory（`projectMemoryWriter.ts`が全Gapを
  // `docs/project_memory/gap_analysis.md`へ書き出す）に残り、後続AIがrepo/spec/testを
  // 調査して解決するための内部情報になる。specAnalyzerはrepo/spec/testを見ていないため、
  // 「AIが調査可能な種類の不確実性だ」と判定できても答えを知っているわけではない。
  const importantGaps = analysis.gaps.filter(
    (gap) => gap.severity === 'must_resolve' && requiresCeoDecision(gap),
  )
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
      // Project Definitionそのものの情報不足を尋ねる合成Gapなので、常にCEOの判断対象。
      decisionOwner: 'ceo',
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
