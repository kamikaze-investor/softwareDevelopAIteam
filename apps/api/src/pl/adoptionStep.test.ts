import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ADOPTABLE_ROADMAP_STATES,
  ALLOWED_ROADMAP_STATES,
} from '@ai-team/worker/scripts/roadmap/roadmapParser.js'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { adoptRoadmapItem } from '../ctoAi/roadmapAdoption'
import { authorizePlAction, PlActionBlockedError } from './actionGate'
import {
  applyFollowUpBoost,
  AUDIT_FOLLOW_UP_ADOPTED,
  AUDIT_FOLLOW_UP_BOOSTED,
  AUDIT_FOLLOW_UP_SKIPPED,
  followUpAuditKey,
  classifyAdoptionCandidates,
  countConsecutiveSkips,
  FOLLOW_UP_SKIPS_BEFORE_BOOST,
  parseAdoptionProposal,
  readAdoptionCandidates,
  selectAdoptionCandidates,
  buildAdoptionPrompt,
  ADOPTION_SYSTEM_PROMPT,
  type RoadmapCandidate,
  runAdoptionStep,
  type PlAdoptionProposal,
} from './adoptionStep'

/**
 * ここで固定しているのは「PL が選べるのは CEO 承認済み ledger の中身だけで、
 * 宣言したスコープが広すぎれば通らない」ことである。
 */


/** 改行1文字。ledger を組み立てるときの join 区切りに使う。 */
const LF = String.fromCharCode(10)
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
  '',
  '<!-- roadmap:id=blocked-item state=blocked -->',
  '5. [ ] **前提が解消していない項目** — blocked も自律採用しない',
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

  it('deferred / blocked は候補にしない（本文の延期文言ではなく state で止める）', () => {
    // 従来は `!== 'done'` だったため deferred も候補に入り、PL がそれを選んでから
    // Design Review が本文の「MVP後へ延期」で止める、という回り道になっていた。
    const ids = readAdoptionCandidates(() => LEDGER).map((c) => c.id)

    expect(ids).not.toContain('deferred-item')
    expect(ids).not.toContain('blocked-item')
    expect(ids).not.toContain('in-progress-item')
    expect(ids).not.toContain('finished-item')
  })
})

describe('Roadmap state と自律採用の一致 — 3経路が同じ判定になる', () => {
  /**
   * 判定を3箇所へ重複実装しないことの回帰テスト。
   * `readAdoptionCandidates` / `adoptRoadmapItem` / Gate の alignment 検証が
   * **同じ state に対して同じ結論**を出すことを、全 state について固定する。
   */
  const ledgerFor = (state: string): string =>
    [
      '# Roadmap',
      '',
      `<!-- roadmap:id=probe-item state=${state} -->`,
      `1. [${state === 'done' ? 'x' : ' '}] **判定対象** — state=${state}`,
      '',
    ].join(LF)

  /** Gate は呼び出し側の文字列を信じず TARGET_ROOT のファイルを読むので、実ファイルを差し替える。 */
  function withLedger<T>(state: string, run: () => T): T {
    writeFileSync(join(ledgerRoot, 'tasks', 'roadmap.md'), ledgerFor(state), 'utf-8')
    try {
      return run()
    } finally {
      writeFileSync(join(ledgerRoot, 'tasks', 'roadmap.md'), LEDGER, 'utf-8')
    }
  }

  function authorizeAdoption(storage: IStorage, projectId: string): void {
    authorizePlAction(storage, {
      proposal: { kind: 'adopt_roadmap_item' },
      target: { kind: 'project', projectId },
      evidence: [{ gate: 'strategic_alignment_review', roadmapItemId: 'probe-item' }],
    })
  }

  it.each([...ALLOWED_ROADMAP_STATES])('state=%s では3経路の判定が一致する', async (state) => {
    const expected = (ADOPTABLE_ROADMAP_STATES as readonly string[]).includes(state)
    const ledger = ledgerFor(state)

    const isCandidate = readAdoptionCandidates(() => ledger).some((c) => c.id === 'probe-item')

    const { storage, projectId } = seed()
    const adoption = await adoptRoadmapItem(
      storage,
      {
        projectId,
        roadmapId: 'probe-item',
        allowedPaths: ['apps/api/src/ctoAi'],
        acceptanceCriteria: ['test'],
      },
      { readRoadmap: () => ledger, ensureInitialWorkflows: vi.fn().mockResolvedValue([]) },
    )

    const gateOk = withLedger(state, () => {
      try {
        authorizeAdoption(storage, projectId)
        return true
      } catch (error) {
        if (error instanceof PlActionBlockedError) return false
        throw error
      }
    })

    expect({ isCandidate, adopted: adoption.ok, gateOk }).toEqual({
      isCandidate: expected,
      adopted: expected,
      gateOk: expected,
    })
  })

  it('deferred は Gate の alignment 検証でも通らない', () => {
    const { storage, projectId } = seed()

    const thrown = withLedger('deferred', () => {
      try {
        authorizeAdoption(storage, projectId)
        return undefined
      } catch (error) {
        return error
      }
    })

    expect(thrown).toBeInstanceOf(PlActionBlockedError)
    const blocked = thrown as PlActionBlockedError
    expect(blocked.missingGates).toContain('strategic_alignment_review')
    // 「ledger に無い」ではなく「deferred だから通らない」という理由が残る。
    expect(blocked.rejectedEvidence.join(' ')).toContain('deferred')
  })
})

describe('follow-up 候補の検出・skip・boost（CEO 判断 2026-09-17）', () => {
  /** open-item を実行済み・done にした Project を作る。 */
  function projectWithExecutedItem(): { storage: IStorage; projectId: string } {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const task = storage.tasks.create({
      projectId: project.id, title: 'done one', description: '', status: 'done',
      assignee: 'developer_ai', dependencies: [], roadmapTaskKey: 'open-item',
    } as Parameters<IStorage['tasks']['create']>[0])
    storage.jobs.create({
      taskId: task.id, projectId: project.id, agentRole: 'developer_ai', status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])
    return { storage, projectId: project.id }
  }

  it('実行済み・active なし・continuation なしを follow_up として分類する', () => {
    const { storage, projectId } = projectWithExecutedItem()

    const classified = classifyAdoptionCandidates(storage, projectId, readAdoptionCandidates(() => LEDGER))

    expect(classified.find((c) => c.id === 'open-item')?.kind).toBe('follow_up')
  })

  it('一度も採用されていない項目は従来どおり fresh', () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })

    const classified = classifyAdoptionCandidates(storage, project.id, readAdoptionCandidates(() => LEDGER))

    expect(classified.find((c) => c.id === 'open-item')?.kind).toBe('fresh')
  })

  it('Project に active Task があれば follow-up 候補にしない（検出と強制を一致させる）', () => {
    // 採用 seam は Project 全体の active Task を見て拒否する。検出側が甘いと、PL が選んだ末に
    // FOLLOW_UP_NOT_ELIGIBLE で落ちて採用 attempt 予算だけを焼く。
    const { storage, projectId } = projectWithExecutedItem()
    // occupying な Task にする（手動 Task の既定 roadmapActive=false は parked で占有しない）。
    const unrelated = storage.tasks.create({
      projectId, title: 'unrelated', description: '', status: 'pending',
      assignee: 'developer_ai', dependencies: [],
    } as Parameters<IStorage['tasks']['create']>[0])
    storage.tasks.update(unrelated.id, { status: 'in_progress' })

    const classified = classifyAdoptionCandidates(storage, projectId, readAdoptionCandidates(() => LEDGER))

    expect(classified.find((c) => c.id === 'open-item')?.kind).toBe('not_available')
  })

  it('candidate limit より前に follow-up を検出する', () => {
    const { storage, projectId } = projectWithExecutedItem()

    // limit 1 でも、分類は open 全件へ先に当たっているので follow_up の事実は失われない。
    const classified = classifyAdoptionCandidates(storage, projectId, readAdoptionCandidates(() => LEDGER))
    const selected = selectAdoptionCandidates(classified, 1, 0)

    expect(classified.some((c) => c.kind === 'follow_up')).toBe(true)
    expect(selected).toHaveLength(1)
  })

  it('skip を audit へ記録し、3回連続で順序を繰り上げる', async () => {
    const { storage, projectId } = projectWithExecutedItem()
    // PL は毎回別の項目を選ぶ = open-item は毎回 skip される。
    const chooseOther = {
      propose: async () => JSON.stringify({ ...GOOD, roadmapId: 'in-progress-item' }),
      readLedger: () => LEDGER,
      adopt: async () => ({ ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' }),
    }

    for (let round = 1; round <= FOLLOW_UP_SKIPS_BEFORE_BOOST; round += 1) {
      await runAdoptionStep(storage, projectId, chooseOther)
      expect(countConsecutiveSkips(storage, projectId, 'open-item'), `round ${round}`).toBe(round)
    }

    const skips = storage.auditLog
      .findByEntity('roadmap_item', followUpAuditKey(projectId, 'open-item'))
      .filter((entry) => entry.operation === AUDIT_FOLLOW_UP_SKIPPED)
    expect(skips).toHaveLength(FOLLOW_UP_SKIPS_BEFORE_BOOST)

    // 閾値に達したので、次からは先頭へ出る。
    const classified = classifyAdoptionCandidates(storage, projectId, readAdoptionCandidates(() => LEDGER))
    const boosted = applyFollowUpBoost(storage, projectId, classified)
    expect(boosted[0]?.id).toBe('open-item')
    expect(boosted[0]?.boosted).toBe(true)

    await runAdoptionStep(storage, projectId, chooseOther)
    const boostEvents = storage.auditLog
      .findByEntity('roadmap_item', followUpAuditKey(projectId, 'open-item'))
      .filter((entry) => entry.operation === AUDIT_FOLLOW_UP_BOOSTED)
    expect(boostEvents.length).toBeGreaterThan(0)
  })

  it('boost は順序だけを変え、候補の種別や件数を変えない', () => {
    const { storage, projectId } = projectWithExecutedItem()
    for (let round = 0; round < FOLLOW_UP_SKIPS_BEFORE_BOOST; round += 1) {
      storage.auditLog.record({
        actor: 'api', operation: AUDIT_FOLLOW_UP_SKIPPED, entityType: 'roadmap_item',
        entityId: followUpAuditKey(projectId, 'open-item'), result: 'success', detail: 'test',
      })
    }
    const classified = classifyAdoptionCandidates(storage, projectId, readAdoptionCandidates(() => LEDGER))

    const boosted = applyFollowUpBoost(storage, projectId, classified)

    // 並び替えただけ。集合も kind も同じ。
    expect(boosted.map((c) => c.id).sort()).toEqual(classified.map((c) => c.id).sort())
    for (const candidate of boosted) {
      expect(candidate.kind).toBe(classified.find((c) => c.id === candidate.id)?.kind)
    }
  })

  it('採用されれば連続 skip は途切れる（採用イベントは本番経路が書く）', async () => {
    const { storage, projectId } = projectWithExecutedItem()
    const chooseOther = {
      propose: async () => JSON.stringify({ ...GOOD, roadmapId: 'in-progress-item' }),
      readLedger: () => LEDGER,
      adopt: async () => ({ ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' }),
    }
    await runAdoptionStep(storage, projectId, chooseOther)
    expect(countConsecutiveSkips(storage, projectId, 'open-item')).toBe(1)

    // 今度は follow-up 候補そのものを選ぶ。**採用イベントは runAdoptionStep が書く**
    // （テストが手で書かない。書いていなければこのテストが落ちる）。
    await runAdoptionStep(storage, projectId, {
      propose: async () => JSON.stringify({ ...GOOD, roadmapId: 'open-item' }),
      readLedger: () => LEDGER,
      adopt: async () => ({ ok: true as const, taskId: 'x', roadmapTaskKey: 'open-item#2', title: 't' }),
    })

    const adopted = storage.auditLog
      .findByEntity('roadmap_item', followUpAuditKey(projectId, 'open-item'))
      .filter((entry) => entry.operation === AUDIT_FOLLOW_UP_ADOPTED)
    expect(adopted.length).toBeGreaterThan(0)
    expect(countConsecutiveSkips(storage, projectId, 'open-item')).toBe(0)
  })

  it('別 Project の skip 履歴は順序へ影響しない', () => {
    const { storage, projectId } = projectWithExecutedItem()
    for (let round = 0; round < FOLLOW_UP_SKIPS_BEFORE_BOOST; round += 1) {
      storage.auditLog.record({
        actor: 'api', operation: AUDIT_FOLLOW_UP_SKIPPED, entityType: 'roadmap_item',
        entityId: followUpAuditKey('some-other-project', 'open-item'), result: 'success', detail: 'test',
      })
    }

    expect(countConsecutiveSkips(storage, projectId, 'open-item')).toBe(0)
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

  it('deferred な項目は採用しない', async () => {
    const { storage, projectId } = seed()

    const result = await runAdoptionStep(
      storage,
      projectId,
      deps({ propose: async () => JSON.stringify({ ...GOOD, roadmapId: 'deferred-item' }) }),
    )

    // 候補一覧に載らないので、PL が名指ししても選べない。
    expect(result.status).toBe('proposal_unusable')
    expect(result.reason).toContain('deferred-item')
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

describe('runAdoptionStep — 実行済みの項目は follow-up 候補として提示する', () => {
  // 2026-09-15 production 実測: Candidate の ledger が master に遅れている間、PL は完了済み
  // 項目を open と見て選び、ALREADY_EXECUTED 却下で attempt 予算を2回消費した。
  //
  // **2026-09-17 CEO 判断で方針が変わった。** 実行済みでも ledger 上 open で、active Task も
  // pending continuation も無いなら、残作業に対する follow-up を作れる。そのため候補からは
  // 除かず、**FOLLOW-UP と明示して提示する**。予算を無駄に焼かない防御は候補除外ではなく、
  // 「新しい implementationScope を名指しできなければ `adoptRoadmapItem()` が拒否する」
  // （FOLLOW_UP_NOT_ELIGIBLE / FOLLOW_UP_NO_PROGRESS）ことで担保する。
  it('Job を持つ done Task の roadmap item は FOLLOW-UP として提示する', async () => {
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

    // 候補として提示される。stub の propose が '{}' を返すので採用自体は成立しない。
    expect(result.status).toBe('proposal_unusable')
    expect(offered).toContain('open-item')
    expect(offered).toContain('FOLLOW-UP')
  })

  it('active Task が残っていれば follow-up 候補にしない（resume 経路の領分）', async () => {
    const storage = createSQLiteStorage(':memory:')
    const project = storage.projects.create({
      name: 'AIteamOS', goal: 'g', designPhilosophy: [], status: 'running',
    })
    const stuck = storage.tasks.create({
      projectId: project.id, title: 'stuck', description: '', status: 'blocked',
      assignee: 'developer_ai', dependencies: [], roadmapTaskKey: 'open-item',
    } as Parameters<IStorage['tasks']['create']>[0])
    storage.jobs.create({
      taskId: stuck.id, projectId: project.id, agentRole: 'developer_ai', status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' }, dryRun: false,
    } as Parameters<IStorage['jobs']['create']>[0])

    let offered: string | undefined
    const result = await runAdoptionStep(storage, project.id, {
      propose: async (_system, user) => { offered = user; return '{}' },
      readLedger: () => LEDGER,
      adopt: async () => ({ ok: true as const, taskId: 'x', roadmapTaskKey: 'y', title: 't' }),
    })

    // blocked な Task は resume 経路が扱う。follow-up で迂回させない。
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

describe('採用 context — PL に判断材料を渡す', () => {
  // 2026-09-15 事故: PL は `id — state — title` しか渡されておらず、
  // `mobile-approval-role-docs — 2種類の承認の役割整理とMobile導線設計` の1行から
  // 存在しない `docs/approval-roles` を創作した。原因は能力ではなく材料不足だった。
  it('候補には title だけでなく本文の先頭が載る', () => {
    const ledger = [
      '# Roadmap', '',
      '<!-- roadmap:id=approval-docs state=planned -->',
      '1. [ ] **2種類の承認の役割整理** — 未完了なのは文書化のみ。',
      '   正本は docs/project_memory/rules/approval_rules.md にある。',
    ].join('\n')

    const [c] = readAdoptionCandidates(() => ledger)

    expect(c?.bodyPreview).toContain('docs/project_memory/rules/approval_rules.md')
    expect(buildAdoptionPrompt([c as RoadmapCandidate])).toContain('approval_rules.md')
  })

  it('本文は先頭だけ。ledger 全文を prompt へ入れない', () => {
    const long = 'あ'.repeat(5000)
    const ledger = [
      '# Roadmap', '',
      '<!-- roadmap:id=big state=planned -->',
      '1. [ ] **大きい項目**',
      '   ' + long,
    ].join('\n')

    const [c] = readAdoptionCandidates(() => ledger)

    expect((c?.bodyPreview.length ?? 0)).toBeLessThan(260)
  })

  it('Goal が渡されれば prompt の先頭に載る', () => {
    const prompt = buildAdoptionPrompt(
      [{ id: 'x', title: 't', state: 'planned', bodyPreview: 'b', highPriority: false }],
      'AIteamOS の正式 Roadmap を完遂する。',
    )

    expect(prompt).toContain('Project goal')
    expect(prompt).toContain('正式 Roadmap を完遂する')
  })

  it('system prompt が path 創作を禁じ、実在する home を示す', () => {
    expect(ADOPTION_SYSTEM_PROMPT).toContain('Never invent a path')
    expect(ADOPTION_SYSTEM_PROMPT).toContain('docs/project_memory/rules/')
    // 触れないものも明示する（採用段階で実装不能な項目を選ばせない）
    expect(ADOPTION_SYSTEM_PROMPT).toContain('apps/worker/src/guards/**')
  })

  it('system prompt が allowedPaths の記法（前方一致・glob 不可）を明示する', () => {
    // 2026-09-16 実測: PL は `apps/api/src/**` を宣言した。Guard は前方一致なので
    // この文字列は **何にも一致しない** — 範囲が狭いのではなく実質的に空だった。
    // 「path を創作するな」では防げない（`apps/api/src` は実在する）。記法の問題である。
    expect(ADOPTION_SYSTEM_PROMPT).toContain('allowedPaths is not a glob')
    expect(ADOPTION_SYSTEM_PROMPT).toContain('matches NOTHING')
    expect(ADOPTION_SYSTEM_PROMPT).toContain('never "apps/api/src/**"')
  })
})

describe('selectAdoptionCandidates — 全項目がいずれ候補になる', () => {
  const make = (id: string, high = false): RoadmapCandidate =>
    ({ id, title: id, state: 'planned', bodyPreview: '', highPriority: high })

  it('上限以下ならそのまま全件', () => {
    const all = [make('a'), make('b')]
    expect(selectAdoptionCandidates(all, 40, 0).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('priority=high は回転に関わらず常に載る', () => {
    const all = [make('h', true), ...Array.from({ length: 10 }, (_, i) => make(`n${i}`))]
    for (const offset of [0, 1, 5, 9, 100]) {
      expect(selectAdoptionCandidates(all, 3, offset).map((c) => c.id), `offset ${offset}`).toContain('h')
    }
  })

  it('回転により、上限を超える項目もいずれ全部が候補になる', () => {
    // 2026-09-16 実測: planned 55件 / 上限 40 で 15件が恒久的に不可視だった。
    const all = Array.from({ length: 10 }, (_, i) => make(`n${i}`))
    const seen = new Set<string>()
    for (let offset = 0; offset < 10; offset += 1) {
      for (const c of selectAdoptionCandidates(all, 3, offset)) seen.add(c.id)
    }
    expect(seen.size).toBe(10)
  })

  it('負の回転位置でも壊れない', () => {
    const all = Array.from({ length: 5 }, (_, i) => make(`n${i}`))
    expect(selectAdoptionCandidates(all, 2, -3)).toHaveLength(2)
  })
})
