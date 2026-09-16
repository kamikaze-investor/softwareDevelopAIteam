import { describe, expect, it, vi } from 'vitest'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { adoptRoadmapItem, buildAdoptedDescription, extractItemDescription } from './roadmapAdoption'

const LEDGER = [
  '# Roadmap',
  '',
  '<!-- roadmap:id=first-item state=planned -->',
  '1. [ ] **最初の項目** — これは実装対象である',
  '   詳細な本文がここに続く。',
  '',
  '<!-- roadmap:id=second-item state=planned priority=high -->',
  '2. [~] **進行中の項目** — 追加属性つき',
  '',
  '<!-- roadmap:id=in-progress-item state=in_progress -->',
  '6. [~] **着手済みの項目** — 重ねて採用しない',
  '',
  '<!-- roadmap:id=finished-item state=done -->',
  '3. [x] **完了済みの項目** — 再実行してはいけない',
  '',
  '<!-- roadmap:id=deferred-item state=deferred -->',
  '4. [ ] **今はやらない項目** — deferred は自律採用しない',
  '',
  '<!-- roadmap:id=blocked-item state=blocked -->',
  '5. [ ] **前提が解消していない項目** — blocked も自律採用しない',
].join('\n')

function makeStorage(): { storage: IStorage; projectId: string } {
  const storage = createSQLiteStorage(':memory:')
  const project = storage.projects.create({
    name: 'AIteamOS Continuous Development',
    goal: '正式Roadmapの続きから開発する',
    designPhilosophy: [],
    status: 'paused',
  })
  return { storage, projectId: project.id }
}

const SPEC = {
  allowedPaths: ['apps/worker/scripts/roadmap'],
  acceptanceCriteria: ['roadmap:check が通る'],
}

function deps(ensure = vi.fn().mockResolvedValue([])) {
  return { readRoadmap: () => LEDGER, ensureInitialWorkflows: ensure }
}

describe('adoptRoadmapItem — 選択した1件だけを実行可能なTaskへ採用する', () => {
  it('roadmap:id を roadmapTaskKey にして追跡可能な roadmapActive Task を作る', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.roadmapTaskKey).toBe('first-item')
    const task = storage.tasks.findById(result.taskId)
    expect(task?.roadmapTaskKey).toBe('first-item')
    expect(task?.roadmapActive).toBe(true)
    expect(task?.status).toBe('pending')
    expect(task?.assignee).toBe('developer_ai')
    // PL が明示した spec がそのまま Task へ載る（ledger の散文からは推測しない）。
    expect(task?.allowedPaths).toEqual(SPEC.allowedPaths)
    expect(task?.acceptanceCriteria).toEqual(SPEC.acceptanceCriteria)
    // 本文は ledger からそのまま取る。
    expect(task?.description).toContain('詳細な本文がここに続く')
  })

  it('採用すると hasActiveRoadmap 相当が true になり、running 遷移で再生成へ戻らない', async () => {
    const { storage, projectId } = makeStorage()

    expect(storage.tasks.findByProjectId(projectId).some((t) => t.roadmapActive)).toBe(false)

    await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())

    // projects.ts の再生成ゲートと同一の判定。
    expect(storage.tasks.findByProjectId(projectId).some((t) => t.roadmapActive)).toBe(true)
  })

  it('採用しただけで初回 Implement Job 生成の既存経路を呼ぶ（running な Project でも着火する）', async () => {
    const { storage, projectId } = makeStorage()
    const ensure = vi.fn().mockResolvedValue([])

    await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps(ensure))

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(storage, projectId)
  })

  it('追加属性つき・[~] 表記の項目も採用できる', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'second-item', ...SPEC }, deps())

    expect(result.ok).toBe(true)
  })
})

describe('adoptRoadmapItem — fail-closed', () => {
  it('allowedPaths が空なら採用しない', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(
      storage,
      { projectId, roadmapId: 'first-item', allowedPaths: ['  '], acceptanceCriteria: SPEC.acceptanceCriteria },
      deps(),
    )

    expect(result).toMatchObject({ ok: false, code: 'SPEC_INVALID' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('acceptanceCriteria が空なら採用しない', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(
      storage,
      { projectId, roadmapId: 'first-item', allowedPaths: SPEC.allowedPaths, acceptanceCriteria: [] },
      deps(),
    )

    expect(result).toMatchObject({ ok: false, code: 'SPEC_INVALID' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('allowedPaths が repository-relative でなければ既存 validation が弾く', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(
      storage,
      { projectId, roadmapId: 'first-item', allowedPaths: ['/workspace/target/apps'], acceptanceCriteria: SPEC.acceptanceCriteria },
      deps(),
    )

    expect(result).toMatchObject({ ok: false, code: 'SPEC_INVALID' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('存在しない roadmap:id は採用しない', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'no-such-item', ...SPEC }, deps())

    expect(result).toMatchObject({ ok: false, code: 'ITEM_NOT_FOUND' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('done の項目は再実行しない', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'finished-item', ...SPEC }, deps())

    expect(result).toMatchObject({ ok: false, code: 'ITEM_ALREADY_DONE' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('in_progress の項目は id を直接指定しても採用しない', async () => {
    const { storage, projectId } = makeStorage()

    // CEO 決定（2026-09-15 / PR #211）。着手済みのものを重ねて採用しない。
    // 候補一覧だけでなく採用 API 側でも止める（PR #211 は候補一覧しか塞いでいなかった）。
    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'in-progress-item', ...SPEC }, deps())

    expect(result).toMatchObject({ ok: false, code: 'ITEM_NOT_ADOPTABLE' })
    if (!result.ok) expect(result.reason).toContain('in_progress')
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('deferred の項目は id を直接指定しても採用しない', async () => {
    const { storage, projectId } = makeStorage()

    // 候補一覧を経由せず採用 API を直接叩いても、ledger 上の「今はやらない」は守られる。
    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'deferred-item', ...SPEC }, deps())

    expect(result).toMatchObject({ ok: false, code: 'ITEM_NOT_ADOPTABLE' })
    if (!result.ok) expect(result.reason).toContain('deferred')
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('blocked の項目も id を直接指定して採用できない', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'blocked-item', ...SPEC }, deps())

    expect(result).toMatchObject({ ok: false, code: 'ITEM_NOT_ADOPTABLE' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('ledger 自体が壊れていれば採用しない（既存 parser の検証をそのまま使う）', async () => {
    const { storage, projectId } = makeStorage()
    const broken = ['<!-- roadmap:id=broken state=planned -->', 'not a checkbox'].join('\n')

    const result = await adoptRoadmapItem(
      storage,
      { projectId, roadmapId: 'broken', ...SPEC },
      { readRoadmap: () => broken, ensureInitialWorkflows: vi.fn() },
    )

    expect(result).toMatchObject({ ok: false, code: 'ROADMAP_INVALID' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })

  it('ledger を読めなければ採用しない', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(
      storage,
      { projectId, roadmapId: 'first-item', ...SPEC },
      {
        readRoadmap: () => { throw new Error('ENOENT') },
        ensureInitialWorkflows: vi.fn(),
      },
    )

    expect(result).toMatchObject({ ok: false, code: 'ROADMAP_UNREADABLE' })
    expect(storage.tasks.findByProjectId(projectId)).toHaveLength(0)
  })
})

describe('adoptRoadmapItem — 重複実行の防止', () => {
  it('同じ roadmap:id を再採用しても Task が重複しない（既存同期の冪等性）', async () => {
    const { storage, projectId } = makeStorage()

    const first = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())
    const second = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.taskId).toBe(first.taskId)
    expect(storage.tasks.findByProjectId(projectId).filter((t) => t.roadmapTaskKey === 'first-item')).toHaveLength(1)
  })

  it('既に Job が動いた roadmap:id は採用し直さない', async () => {
    const { storage, projectId } = makeStorage()
    const adopted = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())
    expect(adopted.ok).toBe(true)
    if (!adopted.ok) return

    storage.jobs.create({
      taskId: adopted.taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })

    const again = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())

    expect(again).toMatchObject({ ok: false, code: 'ALREADY_EXECUTED' })
  })

  it('別項目を採用しても、完了済み Task の履歴と Job は失われない', async () => {
    const { storage, projectId } = makeStorage()
    const first = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())
    expect(first.ok).toBe(true)
    if (!first.ok) return

    storage.jobs.create({
      taskId: first.taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'success',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.tasks.update(first.taskId, { status: 'done' })

    const second = await adoptRoadmapItem(storage, { projectId, roadmapId: 'second-item', ...SPEC }, deps())
    expect(second.ok).toBe(true)

    // 直前の Task は roadmapActive=false の履歴になるが、行も Job も消えない。
    const previous = storage.tasks.findById(first.taskId)
    expect(previous?.status).toBe('done')
    expect(storage.jobs.findByTaskId(first.taskId)).toHaveLength(1)
    // 新しく採用した1件が roadmapActive なので、再生成ゲートは引き続き閉じている。
    expect(storage.tasks.findByProjectId(projectId).some((t) => t.roadmapActive)).toBe(true)
  })
})

describe('extractItemDescription', () => {
  it('次の roadmap metadata 行の直前までを本文として取る', () => {
    const items = [
      { id: 'first-item', checkboxLineIndex: 3 },
    ]
    const description = extractItemDescription(LEDGER, items[0] as never)

    expect(description).toContain('最初の項目')
    expect(description).toContain('詳細な本文がここに続く')
    expect(description).not.toContain('進行中の項目')
  })
})

/**
 * implementation scope（`roadmap-adoption-followups` サブ項目(1)）。
 *
 * production で2回踏んだ欠陥への回帰テスト: description が ledger 本文全文になるため、
 * 複数サブ項目を含む項目では対象外のサブ項目まで実装され、File Change Guard が停止させていた。
 */
describe('adoptRoadmapItem — 今回実装する範囲の明示', () => {
  it('implementationScope を指定すると description の先頭に載り、ledger 本文もその後に残る', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(
      storage,
      {
        projectId,
        roadmapId: 'first-item',
        ...SPEC,
        implementationScope: 'サブ項目(1) のみ。(2) は対象外',
      },
      deps(),
    )

    expect(result.ok).toBe(true)
    const task = storage.tasks.findById((result as { taskId: string }).taskId)!
    const scopeIndex = task.description.indexOf('今回実装する範囲')
    const bodyIndex = task.description.indexOf('詳細な本文がここに続く')

    expect(scopeIndex).toBeGreaterThanOrEqual(0)
    expect(task.description).toContain('サブ項目(1) のみ。(2) は対象外')
    // ledger 本文は削らない。scope はその**前**に出る
    expect(bodyIndex).toBeGreaterThan(scopeIndex)
    expect(task.description).toContain('上記以外は対象外である')
  })

  it('implementationScope 未指定なら従来どおり ledger 本文だけになる（後方互換）', async () => {
    const { storage, projectId } = makeStorage()

    const result = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())

    expect(result.ok).toBe(true)
    const task = storage.tasks.findById((result as { taskId: string }).taskId)!
    expect(task.description).not.toContain('今回実装する範囲')
    expect(task.description).toContain('詳細な本文がここに続く')
  })

  it('空文字・空白のみの scope は指定なしと同じに扱う（見出しだけの無意味な上書きを作らない）', () => {
    expect(buildAdoptedDescription('本文', undefined)).toBe('本文')
    expect(buildAdoptedDescription('本文', '')).toBe('本文')
    expect(buildAdoptedDescription('本文', '   \n  ')).toBe('本文')
  })

  it('ledger 本文そのものは書き換えない（採用は ledger へ構造を持ち込まない）', () => {
    const body = '1. [ ] **項目** — 本文\n   続き'
    const built = buildAdoptedDescription(body, 'ここだけ')

    expect(built.endsWith(body)).toBe(true)
  })
})

/**
 * 「done な Task の blocked Job が以後の採用を恒久的に詰まらせる」への回帰テスト。
 *
 * 2026-09-15 production 実測: 外部セッションで実装を完了させて Task を done にした後、
 * 次項目の採用が `Cannot deactivate roadmap task ... because job ... is blocked` で 409 になった。
 * blocked Job は resume の対象だが、resume が向くのは blocked Task であって done Task ではないため、
 * この状態は自力で解けない。
 */
describe('adoptRoadmapItem — 直前 Task の残 Job が採用を詰まらせない', () => {
  function blockedJobOn(storage: IStorage, taskId: string, projectId: string): void {
    const job = storage.jobs.create({
      taskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'blocked',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    expect(job.status).toBe('blocked')
  }

  it('done な Task に blocked Job が残っていても次の項目を採用できる', async () => {
    const { storage, projectId } = makeStorage()
    const first = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())
    expect(first.ok).toBe(true)

    const firstTaskId = (first as { taskId: string }).taskId
    blockedJobOn(storage, firstTaskId, projectId)
    storage.tasks.update(firstTaskId, { status: 'done' })

    const second = await adoptRoadmapItem(storage, { projectId, roadmapId: 'second-item', ...SPEC }, deps())

    expect(second.ok).toBe(true)
    // 直前 Task は非活性化され、Job 自体は履歴として残る
    expect(storage.tasks.findById(firstTaskId)!.roadmapActive).toBe(false)
    expect(storage.jobs.findByTaskId(firstTaskId)[0]!.status).toBe('blocked')
  })

  it('done でない Task の blocked Job は従来どおり採用を止める（進行中の作業を黙って捨てない）', async () => {
    const { storage, projectId } = makeStorage()
    const first = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())
    const firstTaskId = (first as { taskId: string }).taskId
    blockedJobOn(storage, firstTaskId, projectId)

    const second = await adoptRoadmapItem(storage, { projectId, roadmapId: 'second-item', ...SPEC }, deps())

    expect(second.ok).toBe(false)
    expect((second as { reason: string }).reason).toContain('blocked')
  })

  it('done な Task でも queued Job が残っていれば止める（Worker が掴み得るため）', async () => {
    const { storage, projectId } = makeStorage()
    const first = await adoptRoadmapItem(storage, { projectId, roadmapId: 'first-item', ...SPEC }, deps())
    const firstTaskId = (first as { taskId: string }).taskId
    storage.jobs.create({
      taskId: firstTaskId,
      projectId,
      agentRole: 'developer_ai',
      status: 'queued',
      safeCommand: { kind: 'test', workingDir: '/workspace/target' },
      dryRun: false,
    })
    storage.tasks.update(firstTaskId, { status: 'done' })

    const second = await adoptRoadmapItem(storage, { projectId, roadmapId: 'second-item', ...SPEC }, deps())

    expect(second.ok).toBe(false)
    expect((second as { reason: string }).reason).toContain('queued')
  })
})
