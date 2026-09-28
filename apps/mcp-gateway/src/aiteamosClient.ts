/**
 * AIteamOS API への**固定された**呼び出しだけを持つ client。
 *
 * - 呼べる path はこのファイルに書かれたものだけ（任意 path を受け取る関数は無い）
 * - id は `encodeURIComponent` して path に埋める（path の乗っ取りをさせない）
 * - 使う credential は OPERATOR_GATEWAY だけ。API 側の allowlist が最終的な境界であり、
 *   ここは「それ以外を呼ぼうとしない」ための二重の制限である
 * - エラー本文に credential を含めない
 */

export class AiteamosApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface OperatorRequestInput {
  kind: 'question' | 'request'
  message: string
  targetKey?: string
  projectId?: string
  taskId?: string
}

export interface AiteamosClient {
  getSystemState(): Promise<unknown>
  getProject(projectId: string): Promise<unknown>
  listTasks(filter: { projectId?: string; status?: string; limit?: number }): Promise<unknown>
  getTask(taskId: string): Promise<unknown>
  getPlTriageSummary(): Promise<unknown>
  createOperatorRequest(input: OperatorRequestInput): Promise<unknown>
  getOperatorRequest(requestId: string): Promise<unknown>
  listOperatorRequests(filter: { status?: string; limit?: number }): Promise<unknown>
}

export function createAiteamosClient(options: {
  apiBaseUrl: string
  operatorGatewayToken: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}): AiteamosClient {
  const fetchImpl = options.fetchImpl ?? fetch

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(`${options.apiBaseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.operatorGatewayToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!res.ok) {
      const apiError = typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${res.status}`
      throw new AiteamosApiError(res.status, apiError)
    }
    return parsed
  }

  const id = (value: string): string => encodeURIComponent(value)
  const query = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value))
    }
    const text = search.toString()
    return text === '' ? '' : `?${text}`
  }

  return {
    getSystemState: () => call('GET', '/api/operator/state'),
    getProject: (projectId) => call('GET', `/api/operator/projects/${id(projectId)}`),
    listTasks: (filter) => call('GET', `/api/operator/tasks${query(filter)}`),
    getTask: (taskId) => call('GET', `/api/operator/tasks/${id(taskId)}`),
    getPlTriageSummary: () => call('GET', '/api/operator/pl/triage-summary'),
    createOperatorRequest: (input) => call('POST', '/api/operator-requests', input),
    getOperatorRequest: (requestId) => call('GET', `/api/operator-requests/${id(requestId)}`),
    listOperatorRequests: (filter) => call('GET', `/api/operator-requests${query(filter)}`),
  }
}
