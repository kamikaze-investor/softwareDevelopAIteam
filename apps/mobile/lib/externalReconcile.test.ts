import type { ApprovalRequest, TaskHumanDecisionFact } from '@ai-team/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildApprovalGateDecisionBody } from './approvalGateDecision'
import {
  MOBILE_RECONCILE_APPROVE_REASON,
  RECONCILE_ALREADY_DONE_MESSAGE,
  RECONCILE_CHANGED_MESSAGE,
  RECONCILE_DONE_MESSAGE,
  RECONCILE_PACKAGE_KIND,
  RECONCILE_STALE_MESSAGE,
  RECONCILE_UNKNOWN_RESULT_MESSAGE,
  approvalRequestsReplacedByCreate,
  approveReconcileApprovalRequest,
  buildReconcileApprovalRequestBody,
  canShowReconcileUI,
  createOneScreenReconcileRunner,
  createReconcileApprovalRequest,
  fetchReconcilePreview,
  parseReconcilePackage,
  prepareReconcileConfirmation,
  reconcileApprovalState,
  reconcileConfirmMessage,
  reconcileEvidenceLines,
  runOneScreenReconcile,
  submitReconcile,
} from './externalReconcile'
import type { ReconcileDeps, ReconcileFreshState, ReconcilePackage, ReconcilePreview } from './externalReconcile'

vi.mock('./api', () => ({ apiFetch: vi.fn() }))
const { apiFetch } = await import('./api')
const apiFetchMock = vi.mocked(apiFetch)

function jsonResponse(status: number, body: unknown): Response {
  return { json: async () => body, ok: status >= 200 && status < 300, status } as unknown as Response
}

const TASK_ID = '5ddaf485-8f2a-4f8a-bcfc-3aa7e38a180f'
const COMMIT = '7fcb93a609deeada1d94ab65e956d27272620538'
const DIFF_HASH = 'reconcile_external_completion:sha256:abc'

const evidence = {
  acceptanceEvidence: 'AC1 verified',
  approvedScope: 'Tier B: apps/worker/src/outbox only',
  ciResult: 'Typecheck & Test SUCCESS',
  commitSha: COMMIT,
  independentReviewVerdict: 'approved',
  pullRequestUrl: 'https://github.com/o/r/pull/412',
  roadmapItemId: 'outbox-blocked-critical-false-alarm',
}

const pkg: ReconcilePackage = { evidence, sourceJobId: 'job-1', taskId: TASK_ID }

function packageText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ evidence, kind: RECONCILE_PACKAGE_KIND, sourceJobId: 'job-1', taskId: TASK_ID, ...over })
}

function preview(over: Partial<ReconcilePreview> = {}): ReconcilePreview {
  return {
    approvalTargetDiffHash: DIFF_HASH,
    blockingJobIds: [],
    eligible: true,
    evidenceDigest: 'abc',
    problems: [],
    sourceJobValid: true,
    task: { id: TASK_ID, parked: true, roadmapTaskKey: evidence.roadmapItemId, status: 'pending', title: 'Outbox false alarm' },
    verification: {
      changedFiles: ['apps/worker/src/outbox.ts', 'CLAUDE.md'], codeOwnedFiles: ['CLAUDE.md'], commit: COMMIT, ok: true, stableHead: COMMIT,
    },
    ...over,
  }
}

function request(id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    requestedAction: 'reconcile_external_completion',
    status: 'WAITING_FOR_USER',
    targetCommit: COMMIT,
    targetDiffHash: DIFF_HASH,
    taskId: TASK_ID,
    ...over,
  } as ApprovalRequest
}

const decision = (approvalRequestId: string, state: TaskHumanDecisionFact['state'], requestedAction = 'reconcile_external_completion'): TaskHumanDecisionFact =>
  ({ approvalRequestId, requestedAction, state })

function freshState(over: Partial<ReconcileFreshState> = {}): ReconcileFreshState {
  return { approvalRequests: [], humanTaskDecisions: [], taskStatus: 'pending', ...over }
}

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    approveRequest: vi.fn(async (id: string) => { calls.push(`approve:${id}`); return { ok: true } as const }),
    calls,
    createRequest: vi.fn(async () => { calls.push('create'); return { approvalRequestId: 'new-1', ok: true } as const }),
    execute: vi.fn(async (_p: ReconcilePackage, id: string) => {
      calls.push(`execute:${id}`)
      return { message: RECONCILE_DONE_MESSAGE, ok: true } as const
    }),
    loadState: vi.fn(async () => { calls.push('load'); return freshState() }),
    preview: vi.fn(async () => { calls.push('preview'); return { ok: true, preview: preview() } as const }),
    ...over,
  }
}

const confirmation = { approval: { kind: 'none' } as const, pkg, preview: preview(), replaced: [] as string[] }

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('parseReconcilePackage — 貼り付けた JSON そのものだけを読む', () => {
  it('reads a well-formed package for this Task', () => {
    expect(parseReconcilePackage(packageText(), TASK_ID)).toEqual({ ok: true, value: pkg })
  })

  it('accepts a ```json fenced package', () => {
    expect(parseReconcilePackage(`\`\`\`json\n${packageText()}\n\`\`\``, TASK_ID).ok).toBe(true)
  })

  it('refuses a package for another Task (incorrect Task)', () => {
    expect(parseReconcilePackage(packageText({ taskId: 'other-task' }), TASK_ID))
      .toMatchObject({ ok: false, message: expect.stringContaining('別の Task') })
  })

  it('refuses JSON embedded in other text instead of guessing which object to use', () => {
    expect(parseReconcilePackage(`AI says: ${packageText()} thanks`, TASK_ID).ok).toBe(false)
  })

  it('refuses missing or blank evidence fields', () => {
    expect(parseReconcilePackage(packageText({ evidence: { ...evidence, ciResult: '  ' } }), TASK_ID))
      .toMatchObject({ ok: false, message: expect.stringContaining('ciResult') })
  })

  it('refuses unknown keys (same as the API strict schema) and a wrong kind', () => {
    expect(parseReconcilePackage(packageText({ approvalRequestId: 'x' }), TASK_ID).ok).toBe(false)
    expect(parseReconcilePackage(packageText({ evidence: { ...evidence, extra: 'y' } }), TASK_ID).ok).toBe(false)
    expect(parseReconcilePackage(packageText({ kind: 'something-else' }), TASK_ID).ok).toBe(false)
  })
})

describe('reconcileApprovalState — 同じ commit・同じ根拠の承認だけを再利用する', () => {
  it('reuses a live approved request bound to this commit and digest', () => {
    expect(reconcileApprovalState([decision('a1', 'approved')], [request('a1')], COMMIT, DIFF_HASH))
      .toEqual({ approvalRequestId: 'a1', kind: 'approved' })
  })

  it('ignores a request bound to another commit or other evidence', () => {
    expect(reconcileApprovalState([decision('a1', 'approved')], [request('a1', { targetCommit: 'deadbeef' })], COMMIT, DIFF_HASH))
      .toEqual({ kind: 'none' })
    expect(reconcileApprovalState([decision('a1', 'waiting')], [request('a1', { targetDiffHash: 'other' })], COMMIT, DIFF_HASH))
      .toEqual({ kind: 'none' })
  })

  it('ignores a request the API no longer lists as a live human decision (expired / stale / not human)', () => {
    expect(reconcileApprovalState([], [request('a1')], COMMIT, DIFF_HASH)).toEqual({ kind: 'none' })
  })

  it('ignores other actions', () => {
    expect(reconcileApprovalState([decision('a1', 'approved', 'abort_task')], [request('a1')], COMMIT, DIFF_HASH))
      .toEqual({ kind: 'none' })
  })
})

describe('approvalRequestsReplacedByCreate — 起票で置き換わる依頼を API の規則どおりに示す', () => {
  it('lists every waiting request of the Task and an approved request of the same action', () => {
    const state = freshState({
      approvalRequests: [
        request('w-abort', { requestedAction: 'abort_task' }),
        request('a-old', { status: 'APPROVED', targetDiffHash: 'old' }),
        request('a-abort', { requestedAction: 'abort_task', status: 'APPROVED' }),
        request('c-done', { status: 'CONSUMED' }),
      ],
    })
    expect(approvalRequestsReplacedByCreate(state, { kind: 'none' }))
      .toEqual(['w-abort（abort_task）', 'a-old（reconcile_external_completion）'])
  })

  it('replaces nothing when an existing bound request is reused', () => {
    expect(approvalRequestsReplacedByCreate(freshState({ approvalRequests: [request('w1')] }), { approvalRequestId: 'w1', kind: 'waiting' }))
      .toEqual([])
  })
})

describe('prepareReconcileConfirmation — 確認ダイアログは押した時点の preview から作る', () => {
  it('builds the confirmation from a fresh preview and names the requests it will replace', async () => {
    const d = deps({
      loadState: vi.fn(async () => freshState({ approvalRequests: [request('w-abort', { requestedAction: 'abort_task' })] })),
    })
    const prepared = await prepareReconcileConfirmation(pkg, preview(), d)
    expect(prepared.kind).toBe('confirm')
    if (prepared.kind !== 'confirm') return
    expect(prepared.confirmation.replaced).toEqual(['w-abort（abort_task）'])
    expect(prepared.confirmation.message).toContain('w-abort（abort_task）')
    expect(d.preview).toHaveBeenCalledTimes(1)
  })

  it('refuses to show the dialog when the evidence snapshot changed (stale display → re-confirm)', async () => {
    const changed = preview({
      verification: { changedFiles: ['CLAUDE.md'], codeOwnedFiles: ['CLAUDE.md'], commit: COMMIT, ok: true, stableHead: 'newhead' },
    })
    const d = deps({ preview: vi.fn(async () => ({ ok: true, preview: changed }) as const) })
    const prepared = await prepareReconcileConfirmation(pkg, preview(), d)
    expect(prepared).toEqual({ kind: 'changed', message: RECONCILE_CHANGED_MESSAGE, preview: changed })
  })

  it('refuses when the evidence no longer verifies (missing / invalid / undeployed)', async () => {
    const invalid = preview({ eligible: false, problems: ['commit x is not an ancestor of the deployed Stable HEAD'] })
    const d = deps({ preview: vi.fn(async () => ({ ok: true, preview: invalid }) as const) })
    expect((await prepareReconcileConfirmation(pkg, invalid, d)).kind).toBe('error')
  })

  it('reports an already-done Task without previewing', async () => {
    const d = deps({ loadState: vi.fn(async () => freshState({ taskStatus: 'done' })) })
    expect(await prepareReconcileConfirmation(pkg, preview(), d)).toEqual({ kind: 'already_done', message: RECONCILE_ALREADY_DONE_MESSAGE })
    expect(d.preview).not.toHaveBeenCalled()
  })
})

describe('runOneScreenReconcile — create → human approve → execute', () => {
  it('runs the whole chain once on success', async () => {
    const d = deps()
    const result = await runOneScreenReconcile(confirmation, d)
    expect(result).toMatchObject({ approvalRequestId: 'new-1', ok: true, outcome: 'done' })
    expect(d.calls).toEqual(['load', 'create', 'approve:new-1', 'execute:new-1'])
  })

  it('does nothing when the Task is already done (completed by an earlier run whose response was lost)', async () => {
    const d = deps({ loadState: vi.fn(async () => freshState({ taskStatus: 'done' })) })
    expect(await runOneScreenReconcile(confirmation, d)).toEqual({ message: RECONCILE_ALREADY_DONE_MESSAGE, ok: true, outcome: 'already_done' })
    expect(d.createRequest).not.toHaveBeenCalled()
    expect(d.execute).not.toHaveBeenCalled()
  })

  it('recovers "created but not approved": approves the existing bound request instead of creating another', async () => {
    const d = deps({
      loadState: vi.fn(async () => freshState({ approvalRequests: [request('w1')], humanTaskDecisions: [decision('w1', 'waiting')] })),
    })
    expect((await runOneScreenReconcile({ ...confirmation, approval: { approvalRequestId: 'w1', kind: 'waiting' } }, d)).ok).toBe(true)
    expect(d.createRequest).not.toHaveBeenCalled()
    expect(d.approveRequest).toHaveBeenCalledWith('w1')
    expect(d.execute).toHaveBeenCalledWith(pkg, 'w1')
  })

  it('recovers "approved but not executed": executes with the existing human approval only', async () => {
    const d = deps({
      loadState: vi.fn(async () => freshState({
        approvalRequests: [request('p1', { status: 'APPROVED' })], humanTaskDecisions: [decision('p1', 'approved')],
      })),
    })
    expect((await runOneScreenReconcile({ ...confirmation, approval: { approvalRequestId: 'p1', kind: 'approved' } }, d)).ok).toBe(true)
    expect(d.createRequest).not.toHaveBeenCalled()
    expect(d.approveRequest).not.toHaveBeenCalled()
    expect(d.execute).toHaveBeenCalledWith(pkg, 'p1')
  })

  it('stops before creating when creating would replace a request the CEO was not shown', async () => {
    const d = deps({
      loadState: vi.fn(async () => freshState({ approvalRequests: [request('w-new', { requestedAction: 'abort_task' })] })),
    })
    const result = await runOneScreenReconcile(confirmation, d)
    expect(result).toMatchObject({ message: RECONCILE_STALE_MESSAGE, ok: false, stage: 'check' })
    expect(d.createRequest).not.toHaveBeenCalled()
  })

  it('creates (and replaces) when the replaced request was shown in the confirmation', async () => {
    const d = deps({
      loadState: vi.fn(async () => freshState({
        approvalRequests: [request('p1', { status: 'APPROVED', targetCommit: 'deadbeef' })],
        humanTaskDecisions: [decision('p1', 'approved')],
      })),
    })
    await runOneScreenReconcile({ ...confirmation, replaced: ['p1（reconcile_external_completion）'] }, d)
    expect(d.createRequest).toHaveBeenCalledTimes(1)
    expect(d.execute).toHaveBeenCalledWith(pkg, 'new-1')
  })

  it('stops when the request shown in the confirmation was rejected / expired meanwhile (no silent re-issue)', async () => {
    const d = deps({ loadState: vi.fn(async () => freshState({ approvalRequests: [request('w1', { status: 'REJECTED' })] })) })
    const result = await runOneScreenReconcile({ ...confirmation, approval: { approvalRequestId: 'w1', kind: 'waiting' } }, d)
    expect(result).toMatchObject({ message: RECONCILE_STALE_MESSAGE, ok: false, stage: 'check' })
    expect(d.createRequest).not.toHaveBeenCalled()
    expect(d.approveRequest).not.toHaveBeenCalled()
    expect(d.execute).not.toHaveBeenCalled()
  })

  it('stops when a different bound request appeared after the confirmation was built', async () => {
    const d = deps({
      loadState: vi.fn(async () => freshState({ approvalRequests: [request('w9')], humanTaskDecisions: [decision('w9', 'waiting')] })),
    })
    expect(await runOneScreenReconcile(confirmation, d)).toMatchObject({ ok: false, stage: 'check' })
    expect(d.approveRequest).not.toHaveBeenCalled()
  })

  it('does not execute when the human approval was refused (expired / non-ADMIN credential)', async () => {
    const d = deps({ approveRequest: vi.fn(async () => ({ code: 'APPROVAL_EXPIRED', message: 'expired', ok: false }) as const) })
    expect(await runOneScreenReconcile(confirmation, d)).toMatchObject({ approvalRequestId: 'new-1', ok: false, stage: 'approve' })
    expect(d.execute).not.toHaveBeenCalled()
  })

  it('reports an unknown result (not failure) when the execute response is lost and the Task is not done', async () => {
    const d = deps({ execute: vi.fn(async () => { throw new Error('network') }) })
    expect(await runOneScreenReconcile(confirmation, d))
      .toMatchObject({ message: RECONCILE_UNKNOWN_RESULT_MESSAGE, ok: false, stage: 'execute' })
  })

  it('decides "already registered" by re-reading the Task, not by the error text', async () => {
    let done = false
    const d = deps({
      execute: vi.fn(async () => { done = true; throw new Error('response lost after the server completed it') }),
      loadState: vi.fn(async () => freshState({ taskStatus: done ? 'done' : 'pending' })),
    })
    expect(await runOneScreenReconcile(confirmation, d)).toMatchObject({ ok: true, outcome: 'already_done' })
  })

  it('a retry after a lost execute response reuses the approval and never creates a second request', async () => {
    let state = freshState()
    const d = deps({
      approveRequest: vi.fn(async () => {
        state = { ...state, humanTaskDecisions: [decision('new-1', 'approved')] }
        return { ok: true } as const
      }),
      createRequest: vi.fn(async () => {
        state = freshState({ approvalRequests: [request('new-1')], humanTaskDecisions: [decision('new-1', 'waiting')] })
        return { approvalRequestId: 'new-1', ok: true } as const
      }),
      loadState: vi.fn(async () => state),
    })
    d.execute = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ message: RECONCILE_DONE_MESSAGE, ok: true })
    expect((await runOneScreenReconcile(confirmation, d)).ok).toBe(false)
    // 再試行は押し直し = 確認ダイアログを作り直す（いまの承認状況 = 承認済み new-1 を示す）
    const retryConfirmation = { ...confirmation, approval: { approvalRequestId: 'new-1', kind: 'approved' } as const }
    expect(await runOneScreenReconcile(retryConfirmation, d)).toMatchObject({ ok: true, outcome: 'done' })
    expect(d.createRequest).toHaveBeenCalledTimes(1)
    expect(d.approveRequest).toHaveBeenCalledTimes(1)
    expect(d.execute).toHaveBeenLastCalledWith(pkg, 'new-1')
  })
})

describe('createOneScreenReconcileRunner — double tap', () => {
  it('a second tap while running calls no API and returns null', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const d = deps({ loadState: vi.fn(async () => { await gate; return freshState() }) })
    const runner = createOneScreenReconcileRunner(d)
    const first = runner.run(confirmation)
    expect(runner.isRunning()).toBe(true)
    expect(await runner.run(confirmation)).toBeNull()
    release()
    expect((await first)?.ok).toBe(true)
    expect(d.loadState).toHaveBeenCalledTimes(1)
    expect(d.createRequest).toHaveBeenCalledTimes(1)
  })
})

describe('API calls keep the existing contracts', () => {
  it('preview posts the evidence in the body (never the URL)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, preview()))
    expect((await fetchReconcilePreview(pkg)).ok).toBe(true)
    const [path, init] = apiFetchMock.mock.calls[0]!
    expect(path).toBe(`/api/tasks/${TASK_ID}/reconcile-external-completion/preview`)
    expect(path).not.toContain(COMMIT)
    expect(JSON.parse(String(init?.body))).toEqual({ evidence, sourceJobId: 'job-1' })
  })

  it('the approval request is bound to the exact Task, action, commit and evidence digest', () => {
    expect(buildReconcileApprovalRequestBody(pkg, preview())).toMatchObject({
      requestedAction: 'reconcile_external_completion',
      riskLevel: 'HIGH',
      targetCommit: COMMIT,
      targetDiffHash: DIFF_HASH,
      taskId: TASK_ID,
    })
  })

  it('create reads the id from 201', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(201, { id: 'approval-1' }))
    expect(await createReconcileApprovalRequest(pkg, preview())).toEqual({ approvalRequestId: 'approval-1', ok: true })
  })

  it('approve uses the same human-only PATCH body as the approvals list', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
    expect(await approveReconcileApprovalRequest('approval-1')).toEqual({ ok: true })
    const [path, init] = apiFetchMock.mock.calls[0]!
    expect(path).toBe('/api/approval-requests/approval-1/status')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual(buildApprovalGateDecisionBody('APPROVED', MOBILE_RECONCILE_APPROVE_REASON))
  })

  it('approve surfaces a refusal (e.g. Worker / Operator credential → 403) without claiming success', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'forbidden' }))
    expect((await approveReconcileApprovalRequest('approval-1')).ok).toBe(false)
  })

  it('execute sends exactly the confirmed evidence with the approval id', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { task: { status: 'done' } }))
    expect(await submitReconcile(pkg, 'approval-1')).toEqual({ message: RECONCILE_DONE_MESSAGE, ok: true })
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]![1]?.body))).toEqual({ approvalRequestId: 'approval-1', evidence, sourceJobId: 'job-1' })
  })

  it('execute reports a refusal (wrong commit / evidence / expired approval) as not executed', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { code: 'APPROVAL_EVIDENCE_MISMATCH', error: 'not issued for this evidence' }))
    expect(await submitReconcile(pkg, 'a')).toMatchObject({ message: expect.stringContaining('not issued for this evidence'), ok: false, outcome: 'refused' })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'approval request a has expired' }))
    expect(await submitReconcile(pkg, 'a')).toMatchObject({ ok: false, outcome: 'refused' })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(502, {}))
    expect(await submitReconcile(pkg, 'a')).toMatchObject({ ok: false, outcome: 'unknown' })
  })
})

describe('screen content', () => {
  it('separates API-verified items from AI claims and lists problems', () => {
    const lines = reconcileEvidenceLines(pkg, preview({ problems: ['Source Job not found for this Task'] }))
    expect(lines.find((line) => line.label === 'commit')?.source).toBe('verified')
    expect(lines.find((line) => line.label === 'CI')?.source).toBe('claimed')
    expect(lines.find((line) => line.label === 'Code Owner 対象（保護範囲）')?.value).toBe('CLAUDE.md')
    expect(lines.some((line) => line.source === 'problem' && line.value.includes('Source Job'))).toBe(true)
  })

  it('the confirmation names the Task, commit, PR and the irreversible effect', () => {
    const message = reconcileConfirmMessage(pkg, preview(), { kind: 'none' }, [])
    expect(message).toContain('Outbox false alarm')
    expect(message).toContain(COMMIT)
    expect(message).toContain(evidence.pullRequestUrl)
    expect(message).toContain('元に戻す操作はありません')
  })

  it('shows the section only for a parked Task that is not done', () => {
    expect(canShowReconcileUI({ parked: true, status: 'pending' })).toBe(true)
    expect(canShowReconcileUI({ parked: true, status: 'done' })).toBe(false)
    expect(canShowReconcileUI({ parked: false, status: 'pending' })).toBe(false)
    expect(canShowReconcileUI({ status: 'pending' })).toBe(false)
  })
})
