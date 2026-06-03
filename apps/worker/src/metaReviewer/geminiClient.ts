/**
 * Gemini API クライアント
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * Meta Reviewer AI は Gemini（Google）を使用する。
 * Developer AI（Claude）と別プロバイダにすることで
 * 相関バイアス（Correlated Blind Spots）を排除する。
 */

import { GoogleGenerativeAI } from '@google/generative-ai'

// レビュー用モデル設定
// gemini-2.5-flash: CI の無料枠でも動かしやすい安定版をデフォルトにする
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

/**
 * Gemini にレビューを依頼し、生のテキスト応答を返す
 */
export async function callGeminiForReview(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY が設定されていません。.env を確認してください。'
    )
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  const modelName = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      // 低温度 = 決定論的な判断（セキュリティレビューに適切）
      temperature: 0.1,
      maxOutputTokens: 4096,
    },
  })

  const result = await model.generateContent(prompt)
  const text = result.response.text()

  if (!text) {
    throw new Error('Gemini からの応答が空でした')
  }

  return text
}
