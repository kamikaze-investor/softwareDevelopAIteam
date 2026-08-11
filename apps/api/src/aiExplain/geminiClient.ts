import { GoogleGenerativeAI } from '@google/generative-ai'

const DEFAULT_MODEL = 'gemini-2.5-flash'

export interface GeminiRequestOptions {
  apiKey?: string
  model?: string
  mockResponse?: string
}

export function parseJsonObject(raw: string): unknown {
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!jsonMatch) {
    throw new Error('AI response did not contain a JSON object')
  }
  return JSON.parse(jsonMatch[1] ?? jsonMatch[0])
}

export function createGeminiClient(apiKey: string): GoogleGenerativeAI {
  return new GoogleGenerativeAI(apiKey)
}

export async function requestText(
  system: string,
  userContent: string,
  options: GeminiRequestOptions,
  maxTokens: number,
): Promise<string> {
  if (options.mockResponse !== undefined) {
    return options.mockResponse
  }

  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured')
  }

  const client = createGeminiClient(apiKey)
  const model = client.getGenerativeModel({
    model: options.model ?? DEFAULT_MODEL,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: maxTokens,
    },
  })
  const result = await model.generateContent(`${system}\n\n${userContent}`)

  return result.response.text().trim()
}
