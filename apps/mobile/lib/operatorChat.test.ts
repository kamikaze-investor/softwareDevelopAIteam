import type { OperatorRequest } from '@ai-team/shared'
import { OPERATOR_REQUEST_MESSAGE_MAX_LENGTH } from '@ai-team/shared'
import { describe, expect, it } from 'vitest'

import {
  attentionItemKey,
  buildOperatorRequestBody,
  createOperatorChatClient,
  hasPendingRequest,
  OPERATOR_REQUESTS_PATH,
  OPERATOR_STATE_PATH,
  parseOperatorState,
  plActionLines,
  requestStatusLabel,
  sendErrorMessage,
  targetFromAttention,
} from './operatorChat'
import type { OperatorAttentionItem } from './operatorChat'

function request(overrides: Partial<OperatorRequest> = {}): OperatorRequest {
  return {
    id: 'r1',
    requesterClass: 'admin',
    kind: 'question',
    message: 'なぜ止まっている？',
    status: 'pending',
    createdAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

const TASK_ATTENTION: OperatorAttentionItem = {
  kind: 'job_blocked',
  projectId: 'p1',
  projectName: 'AIteamOS',
  taskId: 't1',
  jobId: 'j1',
  detail: 'blocked',
}

describe('buildOperatorRequestBody', () => {
  it('question: kind と message だけを送る', () => {
    expect(buildOperatorRequestBody({ kind: 'question', message: '  現在何が起きている？ ', target: null }))
      .toEqual({ ok: true, body: { kind: 'question', message: '現在何が起きている？' } })
  })

  it('request: kind と message を送り、action の種類を指定する項目は無い', () => {
    const result = buildOperatorRequestBody({ kind: 'request', message: '安全なら再開して', target: null })
    expect(result).toEqual({ ok: true, body: { kind: 'request', message: '安全なら再開して' } })
    if (result.ok) expect(Object.keys(result.body).sort()).toEqual(['kind', 'message'])
  })

  it('kind 未選択では送信できない（既定値を置かない）', () => {
    const result = buildOperatorRequestBody({ kind: null, message: '再開して', target: null })
    expect(result.ok).toBe(false)
  })

  it('空白だけの message は送れない', () => {
    expect(buildOperatorRequestBody({ kind: 'question', message: '   \n ', target: null }).ok).toBe(false)
  })

  it('2000 文字ちょうどは送れ、超えると拒否する', () => {
    const max = 'あ'.repeat(OPERATOR_REQUEST_MESSAGE_MAX_LENGTH)
    expect(buildOperatorRequestBody({ kind: 'question', message: max, target: null }).ok).toBe(true)
    expect(buildOperatorRequestBody({ kind: 'question', message: `${max}い`, target: null }).ok).toBe(false)
    expect(OPERATOR_REQUEST_MESSAGE_MAX_LENGTH).toBe(2000)
  })

  it('attention を選ぶと projectId / taskId を付ける（targetKey は送らない）', () => {
    const result = buildOperatorRequestBody({
      kind: 'request',
      message: '復旧可能？',
      target: targetFromAttention(TASK_ATTENTION),
    })
    expect(result).toEqual({ ok: true, body: { kind: 'request', message: '復旧可能？', projectId: 'p1', taskId: 't1' } })
  })

  it('Task を持たない attention は projectId だけを付ける', () => {
    const target = targetFromAttention({ kind: 'continuation_pending', projectId: 'p2' })
    expect(target).toEqual({ projectId: 'p2' })
    expect(buildOperatorRequestBody({ kind: 'question', message: 'x', target })).toEqual({
      ok: true,
      body: { kind: 'question', message: 'x', projectId: 'p2' },
    })
  })
})

describe('hasPendingRequest（polling は pending がある間だけ）', () => {
  it('pending が無ければ polling しない', () => {
    expect(hasPendingRequest([])).toBe(false)
    expect(hasPendingRequest([
      request({ status: 'answered', disposition: 'answered' }),
      request({ id: 'r2', status: 'failed' }),
    ])).toBe(false)
  })

  it('pending が1件でもあれば polling する', () => {
    expect(hasPendingRequest([request({ status: 'answered' }), request({ id: 'r2' })])).toBe(true)
  })
})

describe('結果の表示', () => {
  it('status / disposition を日本語で出す', () => {
    expect(requestStatusLabel({ status: 'pending' })).toBe('PL 回答待ち')
    expect(requestStatusLabel({ status: 'failed' })).toBe('処理失敗')
    expect(requestStatusLabel({ status: 'answered', disposition: 'answered' })).toBe('回答済み')
    expect(requestStatusLabel({ status: 'answered', disposition: 'acted' })).toBe('実行済み')
    expect(requestStatusLabel({ status: 'answered', disposition: 'declined' })).toBe('実行せず')
    expect(requestStatusLabel({ status: 'answered', disposition: 'escalated' })).toBe('CEO判断へ回付')
  })

  it('plAction を記録どおりに行へ展開する', () => {
    expect(plActionLines({
      targetKey: 'job_blocked:j1',
      attempted: true,
      status: 'verified',
      proposedKind: 'resume_job',
      verification: 'attention cleared',
      executionSummary: 'job resumed',
    })).toEqual([
      '対象: job_blocked:j1',
      '実行: あり（verified）',
      '操作: resume_job',
      '確認: attention cleared',
      '結果: job resumed',
    ])
    expect(plActionLines({ targetKey: '(none)', attempted: false, status: 'declined', reason: 'no target' }))
      .toEqual(['対象: (none)', '実行: なし（declined）', '理由: no target'])
  })

  it('送信失敗は固定文だけを出す', () => {
    expect(sendErrorMessage(429)).toContain('上限')
    expect(sendErrorMessage(500)).toBe('送信に失敗しました（HTTP 500）')
  })
})

describe('parseOperatorState', () => {
  it('running / blocked / 承認待ち / attention を取り出す', () => {
    const view = parseOperatorState({
      generatedAt: 'x',
      totals: { jobs: { running: 2, blocked: 1, queued: 3 }, approvalsWaiting: 4 },
      attention: [TASK_ATTENTION, { kind: 'broken' }, null],
    })
    expect(view).toEqual({ running: 2, blocked: 1, approvalsWaiting: 4, attention: [TASK_ATTENTION] })
  })

  it('形が崩れていても 0 と空配列に倒す', () => {
    expect(parseOperatorState(null)).toEqual({ running: 0, blocked: 0, approvalsWaiting: 0, attention: [] })
  })

  it('attention の選択キーは項目ごとに異なる', () => {
    expect(attentionItemKey(TASK_ATTENTION)).not.toBe(attentionItemKey({ ...TASK_ATTENTION, jobId: 'j2' }))
  })
})

describe('createOperatorChatClient（Operator Interface の route だけを呼ぶ）', () => {
  function recorder(responses: Record<string, { status: number; body: unknown }>) {
    const calls: Array<{ path: string; method: string; body?: string; contentType?: string }> = []
    const fetchFn = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = (init.headers ?? {}) as Record<string, string>
      calls.push({ path, method: init.method ?? 'GET', body: init.body as string | undefined, contentType: headers['content-type'] })
      const key = `${init.method ?? 'GET'} ${path}`
      const found = responses[key] ?? { status: 404, body: {} }
      return new Response(JSON.stringify(found.body), { status: found.status })
    }
    return { calls, client: createOperatorChatClient(fetchFn) }
  }

  it('状態・一覧・作成で呼ぶ path と body', async () => {
    const created = request({ id: 'new' })
    const { calls, client } = recorder({
      [`GET ${OPERATOR_STATE_PATH}`]: { status: 200, body: { totals: { jobs: { running: 1 } }, attention: [] } },
      [`GET ${OPERATOR_REQUESTS_PATH}?limit=10`]: { status: 200, body: [created] },
      [`POST ${OPERATOR_REQUESTS_PATH}`]: { status: 201, body: created },
    })

    expect((await client.getState()).running).toBe(1)
    expect(await client.listRecent()).toEqual([created])
    expect(await client.create({ kind: 'request', message: '再開して', taskId: 't1', projectId: 'p1' })).toEqual(created)

    expect(calls).toEqual([
      { path: '/api/operator/state', method: 'GET', body: undefined, contentType: undefined },
      { path: '/api/operator-requests?limit=10', method: 'GET', body: undefined, contentType: undefined },
      {
        path: '/api/operator-requests',
        method: 'POST',
        body: JSON.stringify({ kind: 'request', message: '再開して', taskId: 't1', projectId: 'p1' }),
        contentType: 'application/json',
      },
    ])
    // Operator Interface 以外（resume・approval 等）へは行かない
    expect(calls.every((c) => c.path.startsWith('/api/operator/') || c.path.startsWith('/api/operator-requests'))).toBe(true)
  })

  it('HTTP エラーは status を持つ例外にする（本文は使わない）', async () => {
    const { client } = recorder({ [`POST ${OPERATOR_REQUESTS_PATH}`]: { status: 429, body: { error: 'x' } } })
    await expect(client.create({ kind: 'question', message: 'x' })).rejects.toMatchObject({ status: 429 })
  })
})
