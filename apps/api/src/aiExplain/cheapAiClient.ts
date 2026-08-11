const CHEAP_AI_CONFIG = {
  role: 'cheap_explainer',
  model: 'deepseek-v4-flash',
  endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
} as const

export interface CheapAiRequestOptions {
  apiKey?: string
  mockResponse?: string
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown
    }
  }>
}

export function parseJsonObject(raw: string): unknown {
  const jsonMatch = raw.match(/```json\s*([\s\S]+?)\s*```/) ?? raw.match(/(\{[\s\S]+\})/)
  if (!jsonMatch) {
    throw new Error('AI response did not contain a JSON object')
  }
  return JSON.parse(jsonMatch[1] ?? jsonMatch[0])
}

export async function requestText(
  system: string,
  userContent: string,
  options: CheapAiRequestOptions,
  maxTokens: number,
): Promise<string> {
  if (options.mockResponse !== undefined) {
    return options.mockResponse
  }

  const apiKey = options.apiKey ?? process.env.OPENCODE_GO_API_KEY
  if (!apiKey) {
    throw new Error('OPENCODE_GO_API_KEY is not configured')
  }

  const response = await fetch(CHEAP_AI_CONFIG.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CHEAP_AI_CONFIG.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    throw new Error(`OpenCode Go request failed with status ${response.status}`)
  }

  const payload = await response.json() as ChatCompletionResponse
  const content = payload.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('OpenCode Go response did not contain text')
  }

  return content.trim()
}
