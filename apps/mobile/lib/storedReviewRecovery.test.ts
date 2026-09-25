import { readFileSync } from 'node:fs'
import ts from 'typescript'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { submitStoredReviewRecovery } from './storedReviewRecovery'
import type { DerivedQaEvidence } from './taskWorkflow'

// `apiFetch` だけを差し替える。**token には触らない**ので、token を持つ経路は
// この mock の内側（= 本物の apiFetch）にしか存在しないことがそのまま示される。
vi.mock('./api', () => ({ apiFetch: vi.fn() }))
const { apiFetch } = await import('./api')
const apiFetchMock = vi.mocked(apiFetch)

const TASK = 'task-1'
const REVIEW_JOB = 'review-job-1'

const EVIDENCE: DerivedQaEvidence[] = [
  {
    details: 'Job implement-1: SafeCommand kind=test status=success exitCode=0.',
    jobId: 'implement-1',
    status: 'passed',
    summary: 'Worker SafeCommand (kind=test) passed',
    type: 'unit_test',
  },
  {
    details: 'Job implement-1: safeCommand.kind=test.',
    jobId: 'implement-1',
    status: 'skipped',
    summary: 'Typecheck was not executed by this implement Job',
    type: 'typecheck',
  },
]

function jsonResponse(status: number, body: unknown): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response
}

/** 呼ばれた path だけを並べる（token は引数にも戻り値にも現れない）。 */
function calledPaths(): string[] {
  return apiFetchMock.mock.calls.map((call) => String(call[0]))
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('submitStoredReviewRecovery', () => {
  it('QA を登録してから再投入し、202 を承認待ちとして返す', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(202, {
        requestedAction: `repair_from_stored_review:${REVIEW_JOB}`,
        status: 'awaiting_approval',
      }))

    const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, EVIDENCE)

    expect(result).toEqual({
      ok: true,
      requestedAction: `repair_from_stored_review:${REVIEW_JOB}`,
      status: 'awaiting_approval',
    })
    expect(calledPaths()).toEqual([
      '/api/qa',
      '/api/qa',
      `/api/tasks/${TASK}/repair-from-stored-review`,
    ])
  })

  it('passed / skipped をそのまま送る（status を作り変えない）', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(202, { status: 'awaiting_approval' }))

    await submitStoredReviewRecovery(TASK, REVIEW_JOB, EVIDENCE)

    const bodies = apiFetchMock.mock.calls
      .filter((call) => call[0] === '/api/qa')
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)))

    expect(bodies.map((b) => `${b.type}:${b.status}`)).toEqual([
      'unit_test:passed',
      'typecheck:skipped',
    ])
    expect(bodies.every((b) => b.taskId === TASK && b.jobId === 'implement-1')).toBe(true)
  })

  it('QA 登録が失敗したら再投入を呼ばない', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }))

    const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, EVIDENCE)

    expect(result.ok).toBe(false)
    expect(calledPaths()).toEqual(['/api/qa', '/api/qa'])
    expect(calledPaths()).not.toContain(`/api/tasks/${TASK}/repair-from-stored-review`)
  })

  it('1件目の QA 登録が失敗した時点で 2件目も送らない', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }))

    const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, EVIDENCE)

    expect(result.ok).toBe(false)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('登録対象が空なら QA を送らず再投入だけ行う（重複登録しない）', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(202, { status: 'awaiting_approval' }))

    const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, [])

    expect(result.ok).toBe(true)
    expect(calledPaths()).toEqual([`/api/tasks/${TASK}/repair-from-stored-review`])
  })

  it.each(['skipped', 'escalated', 'queued'] as const)(
    '%s はその事実を返し、自動で再試行しない',
    async (status) => {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { reason: 'because', status }))

      const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, [])

      expect(result).toEqual({ detail: 'because', ok: true, status })
      // 再投入は 1 回だけ。リトライしていない。
      expect(apiFetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('409 などの失敗はそのまま失敗として返し、再試行しない', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'conflict' }))

    const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, [])

    expect(result).toEqual({ message: 'conflict', ok: false })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('通信例外でも成功へ倒さない', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('network down'))

    const result = await submitStoredReviewRecovery(TASK, REVIEW_JOB, [])

    expect(result.ok).toBe(false)
  })

  it('Approval を自動実行しない（承認系エンドポイントを呼ばない）', async () => {
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(201, {}))
      .mockResolvedValueOnce(jsonResponse(202, { status: 'awaiting_approval' }))

    await submitStoredReviewRecovery(TASK, REVIEW_JOB, EVIDENCE)

    for (const p of calledPaths()) {
      expect(p).not.toContain('/api/approval')
      expect(p).not.toContain('approve')
    }
    const methods = apiFetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method)
    expect(methods).not.toContain('PATCH')
  })
})

// ── token boundary（ソース不変条件）────────────────────────────────────────
//
// token は Secure Storage から `apiFetch()` が読む。ここが崩れると
// token が引数・ログ・URL へ漏れうるので、実装側をソースで固定する。
describe('token boundary', () => {
  const read = (relative: string): string =>
    readFileSync(path.resolve(__dirname, relative), 'utf-8')

  /**
   * **AST で見る。** 正規表現でコメントを落とす方式は、文字列リテラル中の `/*` や `//` で
   * 後続の実コードごと消せてしまい、`const marker = '/*'; fetch('/leak')` のような形を
   * 見逃した（独立レビュー指摘）。逆にエラーメッセージ中の `Failed to fetch jobs` を
   * 違反と誤判定もしていた。`typescript` は既に依存にあるので、新しい道具は増やさない。
   *
   * 見るのは**識別子とモジュール指定子だけ**である。文字列リテラルやコメントの中に
   * 同じ語があっても違反にしない —— そこは通信経路ではない。
   */
  const FORBIDDEN_IDENTIFIERS = new Set([
    'fetch',
    'getApiToken', 'setApiToken', 'clearApiToken',
    'SecureStore', 'AsyncStorage', 'localStorage', 'sessionStorage', 'Clipboard',
  ])
  /**
   * **import 元で塞ぐ。** local alias を付けられても、これらから何かを持ち込んだ時点で違反。
   * `import { setStringAsync as save } from 'expo-clipboard'` のような形はここで捕まる。
   */
  const FORBIDDEN_MODULES = [
    'expo-secure-store',
    'expo-clipboard',
    '@react-native-clipboard/clipboard',
    '@react-native-async-storage/async-storage',
  ]

  /**
   * token 境界の違反を列挙する。**空配列でなければ違反。**
   * 実ファイルが空であることと、作為的な違反例を捕まえることの両方で意味を持たせる。
   */
  function scanTokenViolations(source: string): string[] {
    const sourceFile = ts.createSourceFile('scan.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const found: string[] = []

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        // `fetch` / `SecureStore` 等。alias（`const { fetch: request } = globalThis`）でも
        // property 名として `fetch` の識別子が現れるので捕まる。
        if (FORBIDDEN_IDENTIFIERS.has(node.text)) found.push(`identifier:${node.text}`)
        // token を持つ識別子（引数・戻り値・ログ・URL 埋め込みのどれでも identifier で出る）
        else if (/token/i.test(node.text)) found.push(`identifier:${node.text}`)
        else if (/^authorization$/i.test(node.text)) found.push('identifier:authorization')
      }
      // URL の query に token を載せる形。**ここだけは文字列の中身を見る。**
      // 変数名が `t` でも URL の形自体が漏洩経路なので、識別子だけでは捕まえられない。
      // 散文には現れない `?token=` / `&token=` に限るので、メッセージ文言は誤検出しない。
      if (
        (ts.isStringLiteralLike(node) || ts.isTemplateHead(node)
          || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        && /[?&]token=/i.test(node.text)
      ) {
        found.push('url:token query parameter')
      }
      // `['fetch']` のような文字列経由のアクセス
      if (
        ts.isElementAccessExpression(node)
        && ts.isStringLiteralLike(node.argumentExpression)
        && FORBIDDEN_IDENTIFIERS.has(node.argumentExpression.text)
      ) {
        found.push(`elementAccess:${node.argumentExpression.text}`)
      }
      // `Authorization` という文字列そのもの。property キーでも
      // `headers.set('Authorization', credential)` の引数でも同じく捕まえる
      // （変数名が中立でもヘッダー名は隠せない）。散文には単独で現れない。
      if (ts.isStringLiteralLike(node) && /^authorization$/i.test(node.text)) {
        found.push('string:authorization')
      }
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined
        && ts.isStringLiteralLike(node.moduleSpecifier)
        && FORBIDDEN_MODULES.includes(node.moduleSpecifier.text)
      ) {
        found.push(`import:${node.moduleSpecifier.text}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return found
  }

  it.each([
    ['./storedReviewRecovery.ts'],
    ['./taskWorkflow.ts'],
    ['../app/tasks/[id].tsx'],
  ])('%s は apiFetch 以外で token を扱わない', (file) => {
    expect(scanTokenViolations(read(file))).toEqual([])
  })

  // **検査自体の negative control。** 「実ファイルが空だった」だけでは、
  // 検査が何も見ていないのか本当に安全なのか区別できない。
  it.each([
    ['素の fetch', 'const r = await fetch(url)'],
    ['空白を挟んだ fetch', 'const r = await fetch (url)'],
    ['globalThis 経由', "const r = await globalThis['fetch'](url)"],
    ['fetch を変数へ束ねる', 'const f = fetch, r = await f(url)'],
    ['token を読む', 'const t = await getApiToken()'],
    ['SecureStore を直接使う', "import * as SecureStore from 'expo-secure-store'"],
    ['Authorization を自前で組む', "headers: { authorization: `Bearer ${t}` }"],
    ['clipboard へ出す', 'await Clipboard.setStringAsync(t)'],
    ['別 storage へ書く', 'await AsyncStorage.setItem("t", t)'],
    ['globalThis.fetch を束ねる', 'const f = globalThis.fetch.bind(globalThis)'],
    ['分割代入で alias する', 'const { fetch: request } = globalThis; request("/leak")'],
    ['文字列リテラルでコメントを偽装する', "const marker = '/*'; fetch('/leak'); const end = '*/'"],
    ['行コメントを偽装する', "const s = '//'; fetch('/leak')"],
    ['中立名で Authorization を組む', "headers.set('Authorization', credential)"],
    ['clipboard を alias import する', "import { setStringAsync as save } from 'expo-clipboard'"],
    ['secure store を名前空間 import する', "import * as S from 'expo-secure-store'"],
    ['async storage から alias import する', "import { getItem as read } from '@react-native-async-storage/async-storage'"],
    ['token をログへ出す', 'console.log(apiToken)'],
    ['token を引数で受け取る', 'export function send(token: string) {}'],
    ['token を戻り値にする', 'function readToken(): string { return t }'],
    ['token を URL へ埋める', "await apiFetch(`/api/qa?token=${t}`)"],
  ])('検査は「%s」を違反として捕まえる', (_label, snippet) => {
    expect(scanTokenViolations(snippet).length).toBeGreaterThan(0)
  })

  it('正当な apiFetch 利用や既存の文言は違反にしない', () => {
    expect(scanTokenViolations("const r = await apiFetch('/api/qa')")).toEqual([])
    expect(scanTokenViolations('const jobs = await fetchJobs(taskId)')).toEqual([])
    expect(scanTokenViolations('// apiFetch が Authorization を付ける')).toEqual([])
    // 文字列リテラル内の語は境界違反ではない（既存のエラーメッセージ・表示ラベル）
    expect(scanTokenViolations('throw new Error(`Failed to fetch jobs: ${s}`)')).toEqual([])
    expect(scanTokenViolations("'secrets / env / token': '秘密情報'")).toEqual([])
  })

  it('storedReviewRecovery は apiFetch を使っている', () => {
    const source = read('./storedReviewRecovery.ts')
    expect(source).toContain("import { apiFetch } from './api'")
    expect(source).toContain('await apiFetch(')
  })
})
