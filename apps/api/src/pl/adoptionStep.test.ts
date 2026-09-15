import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import {
  parseAdoptionProposal,
  readAdoptionCandidates,
  runAdoptionStep,
  type PlAdoptionProposal,
} from './adoptionStep'

/**
 * ここで固定しているのは「PL が選べるのは CEO 承認済み ledger の中身だけで、
 * 宣言したスコープが広すぎれば通らない」ことである。
 */

const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=open-item state=planned -->',
  '1. [ ] **未着手の項目** — これは採用できる',
  '',
  '<!-- roadmap:id=in-progress-item state=in_progress -->',
  '2. [~] **進行中の項目**',
  '',
  '<!-- roadmap:id=finished-item state=done -->',
  '3. [x] **完了済みの項目** — 候補にしない',
  '',
  '<!-- roadmap:id=deferred-item state=deferred -->',
  '4. [ ] **現在は着手しない項目** — 本文に「MVP後へ延期」とあっても state が正本',
].join('\n')

/**
 * **Gate は呼び出し側から ledger の中身を受け取らない**（受け取れたら PL が根拠を偽造できる）。
 * 必ず信頼できる場所のファイルを自分で読むので、テストでも実ファイルを置いて TARGET_ROOT を向ける。
 */
let ledgerRoot: string
let previousTargetRoot: string | undefined

beforeAll(() => {
  ledgerRoot = mkdtempSync(join(tmpdir(), 'pl-adoption-'))
  mkdirSync(join(ledgerRoot, 'tasks'), { recursive: true })
  writeFileSync(join(ledgerRoot, 'tasks', 'roadmap.md'), LEDGER, 'utf-8')
  previousTargetRoot = process.env.TARGET_ROOT
  process.env.TARGET_ROOT = ledgerRoot
})

afterAll(() => {
  if (previousTargetRoot === undefined) delete process.env.TARGET_ROOT
  else process.env.TARGET_ROOT = previousTargetRoot
  rmSync(ledgerRoot, { recursive: true, force: true })
})

function seed(): { storage: IStorage; projectId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
  })
  return { storage, projectId: project.id }
}

const GOOD: PlAdoptionProposal = {
  roadmapId: 'open-item',
  implementationScope: 'サブ項目(1) のみ',
  allowedPaths: ['apps/api/src/ctoAi'],
  acceptanceCriteria: ['typecheck と test が通る'],
}

function deps(over: Partial<Parameters<typeof runAdoptionStep>[2]> = {}) {
  return {
    propose: async () => JSON.stringify(GOOD),
    readLedger: () => LEDGER,
    adopt: async () => ({ ok: true as const, taskId: 'task-1', roadmapTaskKey: 'open-item', title: 't' }),
    ...over,
  }
}

describe('readAdoptionCandidates', () => {
  it('候補は planned だけ（現在の可否は state が正本）', () => {
    // 2026-09-15 CEO 決定: 「以前は延期されていた」と「現在も実装禁止」を区別する手段は
    // **既存の `state=`**。新しい state 体系も metadata も作らない。
    const ids = readAdoptionCandidates(() => LEDGER).map((c) => c.id)

    expect(ids).toEqual(['open-item'])
  })

  it('deferred は候補にしない（本文の延期文言ではなく state で止める）', () => {
    // 従来は `!== 'done'` だったため deferred も候補に入り、PL がそれを選んでから
    // Design Review が本文の「MVP後へ延期」で止める、という回り道になっていた。
    const ids = readAdoptionCandidates(() => LEDGER).map((c) => c.id)

    expect(ids).not.toContain('deferred-item')
    expect(ids).not.toContain('in-progress-item')
    expect(ids).not.toContain('finished-item')
  })
})

describe('parseAdoptionProposal — fail-closed', () => {
  it('完全な提案だけを受け取る', () => {
    expect(parseAdoptionProposal(JSON.stringify(GOOD))?.roadmapId).toBe('open-item')
  })

  it('必須項目が欠けていれば採用しない', () => {
    expect(parseAdoptionProposal(JSON.stringify({ ...GOOD, allowedPaths: [] }))).toBeUndefined()
    expect(parseAdoptionProposal(JSON.stringify({ ...GOOD, acceptanceCriteria: [] }))).toBeUndefined()
    expect(parseAdoptionProposal(JSON.stringify({ ...GOOD, implementationScope: '  ' }))).toBeUndefined()
    expect(parseAdoptionProposal(JSON.stringify({ ...GOOD, roadmapId: '' }))).toBeUndefined()
  })

  it('JSON でない出力からは採用しない', () => {
    expect(parseAdoptionProposal('次は open-item をやりましょう')).toBeUndefined()
  })
})

describe('runAdoptionStep — PL は ledger の外を採用できない', () => {
  it('ledger にある未完了項目なら Gate を通って採用される', async () => {
    const { storage, projectId } = seed()

    const result = await runAdoptionStep(storage, projectId, deps())

    expect(result.status).toBe('adopted')
    expect(result.roadmapId).toBe('open-item')
    // Gate を通った記録が残る
    const audit = storage.auditLog.findAll().filter((e) => e.operation === 'pl_action_authorize')
    expect(audit.some((e) => e.result === 'authorized' && e.detail?.includes('adopt_roadmap_item'))).toBe(true)
  })

  it('候補に無い id を選んだら採用しない', async () => {
    const { storage, projectId } = seed()

    const result = await runAdoptionStep(
      storage,
      projectId,
      deps({ propose: async () => JSON.stringify({ ...GOOD, roadmapId: 'not-in-ledger' }) }),
    )

    expect(result.status).toBe('proposal_unusable')
    expect(result.reason).toContain('not-in-ledger')
  })

  it('done な項目は採用しない', async () => {
    const { storage, projectId } = seed()

    const result = await runAdoptionStep(
      storage,
      projectId,
      deps({ propose: async () => JSON.stringify({ ...GOOD, roadmapId: 'finished-item' }) }),
    )

    // 候補一覧にも載らないので、そもそも選べない
    expect(result.status).toBe('proposal_unusable')
  })

  it('広すぎる allowedPaths は Gate 後の検査で止める', async () => {
    const { storage, projectId } = seed()
    let adopted = 0

    for (const tooBroad of [['apps'], ['.'], ['/workspace/target/apps/api'], ['apps/../..']]) {
      const result = await runAdoptionStep(
        storage,
        projectId,
        deps({
          propose: async () => JSON.stringify({ ...GOOD, allowedPaths: tooBroad }),
          adopt: async () => { adopted += 1; return { ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' } },
        }),
      )

      expect(result.status, JSON.stringify(tooBroad)).toBe('blocked')
    }

    expect(adopted).toBe(0)
  })

  it('採用 API が拒否したらその理由をそのまま返す（握りつぶさない）', async () => {
    const { storage, projectId } = seed()

    const result = await runAdoptionStep(
      storage,
      projectId,
      deps({
        adopt: async () => ({ ok: false as const, code: 'ALREADY_EXECUTED' as const, reason: 'already executed' }),
      }),
    )

    expect(result.status).toBe('adoption_rejected')
    expect(result.reason).toContain('already executed')
  })

  it('ledger に未完了項目が無ければ何もしない', async () => {
    const { storage, projectId } = seed()

    const result = await runAdoptionStep(
      storage,
      projectId,
      deps({ readLedger: () => '# Roadmap\n\n<!-- roadmap:id=only-done state=done -->\n1. [x] **完了** — x\n' }),
    )

    expect(result.status).toBe('no_candidate')
  })
})

describe('runAdoptionStep — 実行済みの項目は候補にしない', () => {
  // 2026-09-15 production 実測: Candidate の ledger が master に遅れている間、PL は完了済み
  // 項目を open と見て選び、ALREADY_EXECUTED 却下で attempt 予算を2回消費した。
  // DB（実行済みか）は ledger より新しい事実なので、候補の段階で除く。
  it('Job を持つ Task がある roadmap item は PL へ提示しない', async () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const done = storage.tasks.create({
      projectId: project.id, title: 'done one', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapTaskKey: 'open-item',
    } as Parameters<IStorage['tasks']['create']>[0])
    storage.jobs.create({
      taskId: done.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])

    let offered: string | undefined
    const result = await runAdoptionStep(storage, project.id, {
      propose: async (_system, user) => { offered = user; return '{}' },
      readLedger: () => LEDGER,
      adopt: async () => ({ ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' }),
    })

    // LEDGER の open item は 'open-item' だけ。実行済みなので候補が空になる
    expect(result.status).toBe('no_candidate')
    expect(offered).toBeUndefined()
  })

  it('Job がまだ無い Task の項目は候補に残る（採用前の Task を締め出さない）', async () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })
    storage.tasks.create({
      projectId: project.id, title: 'not started', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [], roadmapTaskKey: 'open-item',
    } as Parameters<IStorage['tasks']['create']>[0])

    let offered = ''
    await runAdoptionStep(storage, project.id, {
      propose: async (_system, user) => { offered = user; return '{}' },
      readLedger: () => LEDGER,
      adopt: async () => ({ ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' }),
    })

    expect(offered).toContain('open-item')
  })
})
