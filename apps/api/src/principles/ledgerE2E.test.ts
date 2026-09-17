import { describe, expect, it } from 'vitest'
import {
  buildApplicablePrinciplesSection,
  corePrincipleSlugs,
  loadEngineeringPrinciples,
  normalizeAppliedPrinciples,
  selectPrinciples,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import { classifyReviewLoad } from '@ai-team/worker/src/approvalLevel/reviewLoadClassifier.js'
import { selectFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
import { createSQLiteStorage } from '../storage/sqlite'
import type { IStorage } from '../storage/interface'
import { createAndExecuteDesignReview } from '../designReview/designReviewCoordinator'
import {
  PRINCIPLE_SENSOR_THRESHOLDS,
  buildPrincipleStats,
  evaluateAndPersistSensors,
  recordPrincipleApplications,
} from './ledger'

/**
 * Principle 管理の入口から出口までを 1 本で通す E2E。
 *
 * 選択 → Review prompt → 原則単位の判定 → DB 保存 → 集計 → センサー発火。
 *
 * **実物を使う。** registry は実ファイル（`specs/21`）、storage は実 SQLite、
 * coordinator は本番と同じ `createAndExecuteDesignReview` を通す。
 * stub にするのは Review provider（runner の stdout）だけである。
 */

function createStorage(): IStorage {
  return createSQLiteStorage(':memory:')
}

function seedTask(storage: IStorage): { projectId: string; taskId: string } {
  const project = storage.projects.create({
    name: 'Principle E2E', goal: 'g', designPhilosophy: [], status: 'draft',
  })
  const task = storage.tasks.create({
    projectId: project.id,
    title: 'T',
    description: '',
    status: 'pending',
    assignee: 'developer_ai',
    dependencies: [],
  })
  return { projectId: project.id, taskId: task.id }
}

/**
 * focus が実際に選ばれる changedFiles。
 *
 * **low load（focus 0 件）だと原則判定はそもそも走らない。** focused review が
 * 1 件も無い経路では記録するものが無いので、E2E では focus が出る変更を使う。
 * 期待 focus はテストで手書きせず、本番と同じ分類器・選択器から導出する。
 */
const FOCUSED_FILES = ['apps/api/src/storage/sqlite.ts']

function expectedFocusesFor(changedFiles: string[]): string[] {
  return selectFocuses(classifyReviewLoad({ changedFiles }).reviewLoad, changedFiles)
}

function deps(stdout: string) {
  return {
    runnerCommand: 'node',
    runnerArgs: [],
    homeDirectory: '/tmp/home',
    workingDir: '/tmp/work',
    execute: async () => ({ ok: true, stdout, timedOut: false }),
  }
}

/**
 * 実際の選択器と実際のパーサを通して、runner が返すのと同じ形の結果を組み立てる。
 *
 * ここで \`normalizeAppliedPrinciples\` を通すのが重要で、
 * 「prompt に載せた原則」と「記録される原則」が同じ選択から来ていることを保証する。
 */
function runnerOutputWithPrincipleVerdicts(input: {
  changedFiles: string[]
  modelAnswer: unknown
  decision?: string
}): { stdout: string; unionSlugs: string[]; selectionByFocus: Map<string, ReturnType<typeof selectPrinciples>> } {
  const principles = loadEngineeringPrinciples()
  const classification = classifyReviewLoad({ changedFiles: input.changedFiles })
  const focuses = expectedFocusesFor(input.changedFiles)

  // **本番の runFocusedReview と同じ形: focus ごとに選択する。**
  // したがって記録される原則は focus 横断の和集合になる。
  const selectionByFocus = new Map(
    focuses.map((focus) => [focus, selectPrinciples({ predictedFocuses: [focus as never] }, principles)]),
  )

  return {
    selectionByFocus,
    unionSlugs: [...new Set([...selectionByFocus.values()].flatMap((items) => items.map((item) => item.slug)))],
    stdout: JSON.stringify({
      reviewLoad: classification.reviewLoad,
      selectedFocuses: focuses,
      focusedReviewResults: focuses.map((focus) => ({
        focus,
        decision: input.decision ?? 'ALIGNED',
        appliedPrinciples: normalizeAppliedPrinciples(input.modelAnswer, selectionByFocus.get(focus) ?? []),
      })),
      integrationReviewResult: { decision: input.decision ?? 'ALIGNED' },
      finalDecision: input.decision ?? 'ALIGNED',
    }),
  }
}

describe('Principle ledger E2E: selection -> review -> verdict -> DB -> aggregation -> sensor', () => {
  it('選択した原則が prompt 断片に載り、判定として DB へ入り、集計で読める', async () => {
    const storage = createStorage()
    const { projectId, taskId } = seedTask(storage)

    const principles = loadEngineeringPrinciples()
    expect(principles.ok).toBe(true)

    // --- 1. 選択 ---
    const { stdout, unionSlugs, selectionByFocus } = runnerOutputWithPrincipleVerdicts({
      changedFiles: FOCUSED_FILES,
      // --- 3. Reviewer が原則単位で判定を返す（1件は CONFLICT、1件は存在しない id） ---
      modelAnswer: [
        { principleId: 'observation-closes-loop', verdict: 'CONFLICT', reason: 'no firing condition' },
        { principleId: 'observable-behavior', verdict: 'ALIGNED', reason: 'tests assert behavior' },
        { principleId: 'not-a-real-principle', verdict: 'CONFLICT', reason: 'invented by the model' },
      ],
    })
    const allSelected = [...selectionByFocus.values()].flat()
    expect(unionSlugs).toContain('observation-closes-loop')
    // contextual 選択が実際に効いている（core だけではない）。
    expect(allSelected.some((item) => item.source === 'contextual')).toBe(true)

    // --- 2. Review prompt: one-liner だけが載り、全文は載らない ---
    const promptSection = buildApplicablePrinciplesSection(allSelected)
    expect(promptSection).toContain('observation-closes-loop:')
    expect(promptSection).not.toContain('an unfalsifiable TODO')

    // --- 4. 本番の coordinator を通して DB 保存まで ---
    const result = await createAndExecuteDesignReview(
      storage,
      { taskId, taskTitle: 'design', designText: 'd', changedFiles: FOCUSED_FILES },
      deps(stdout),
    )
    expect(result.status).toBe('evidence_registered')

    const rows = storage.principleApplications.findAll()
    // focus 横断の和集合が、原則ごとに 1 行だけ入る（focus 数ぶん重複しない）。
    expect(rows.map((row) => row.principleId).sort()).toEqual([...unionSlugs].sort())
    expect(rows.every((row) => row.projectId === projectId)).toBe(true)
    expect(rows.every((row) => row.taskId === taskId)).toBe(true)
    expect(rows.every((row) => row.reviewStage === 'design')).toBe(true)
    expect(rows.every((row) => row.reviewRunId !== undefined)).toBe(true)

    // 版は選択側の hash が入る（reviewer の自己申告ではない）。
    const observation = rows.find((row) => row.principleId === 'observation-closes-loop')
    expect(observation?.verdict).toBe('CONFLICT')
    expect(observation?.selectionSource).toBe('core')
    expect(observation?.principleVersionHash).toBe(
      allSelected.find((item) => item.slug === 'observation-closes-loop')?.versionHash,
    )

    // contextual に選ばれた原則も同じ 1 回の記録に入っている。
    const contextualSlug = allSelected.find((item) => item.source === 'contextual')?.slug
    expect(rows.find((row) => row.principleId === contextualSlug)?.selectionSource).toBe('contextual')

    // モデルが創作した id は記録しない。
    expect(rows.some((row) => row.principleId === 'not-a-real-principle')).toBe(false)

    // 判定を返さなかった core 原則は UNCERTAIN として残る（黙って消えない）。
    const unanswered = rows.find((row) => row.principleId === 'evidence-not-spec')
    expect(unanswered?.verdict).toBe('UNCERTAIN')

    // --- 5. 集計 ---
    const stats = buildPrincipleStats(storage)
    const observationAggregate = stats.aggregates.find((row) => row.principleId === 'observation-closes-loop')
    expect(observationAggregate).toMatchObject({ applications: 1, conflict: 1, aligned: 0, uncertain: 0 })
    expect(observationAggregate?.conflictRate).toBe(1)

    const designStage = stats.byReviewStage.find((entry) => entry.reviewStage === 'design')
    expect(designStage?.aggregates.length).toBe(unionSlugs.length)

    // registry にあるが一度も適用されていない原則は、行が無くても列挙できる。
    // これが「ほぼ使われていない原則」を後から見つけるための入口になる。
    expect(stats.unusedPrincipleIds.length).toBeGreaterThan(0)
    expect(stats.unusedPrincipleIds).not.toContain('observation-closes-loop')
    for (const unused of stats.unusedPrincipleIds) {
      expect(unionSlugs).not.toContain(unused)
    }
  })

  it('同じ原則を複数 focus が判定したら、強い判定（CONFLICT）を残して1行にまとめる', () => {
    const storage = createStorage()
    const { projectId, taskId } = seedTask(storage)
    const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
    const target = 'observation-closes-loop'

    recordPrincipleApplications(
      storage,
      { projectId, taskId, reviewRunId: 'run-1' },
      {
        focusedReviewResults: [
          { appliedPrinciples: normalizeAppliedPrinciples([{ principleId: target, verdict: 'ALIGNED', reason: 'a' }], selection) },
          { appliedPrinciples: normalizeAppliedPrinciples([{ principleId: target, verdict: 'CONFLICT', reason: 'b' }], selection) },
        ],
      },
    )

    const rows = storage.principleApplications.findByPrincipleId(target)
    expect(rows).toHaveLength(1)
    // ALIGNED を勝たせると衝突を見逃す方向に倒れるので、強い方を残す。
    expect(rows[0].verdict).toBe('CONFLICT')
  })

  it('同じ run / stage / 原則は二重計上しない（retry で水増ししない）', () => {
    const storage = createStorage()
    const { projectId, taskId } = seedTask(storage)
    const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
    const applied = normalizeAppliedPrinciples([], selection)

    const first = recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      focusedReviewResults: [{ appliedPrinciples: applied }],
    })
    const second = recordPrincipleApplications(storage, { projectId, taskId, reviewRunId: 'run-1' }, {
      focusedReviewResults: [{ appliedPrinciples: applied }],
    })

    expect(first.recorded).toBe(selection.length)
    expect(second.recorded).toBe(0)
    expect(storage.principleApplications.findAll()).toHaveLength(selection.length)
  })

  it('design と independent で判定が割れたら disagreement として取れる', () => {
    const storage = createStorage()
    const { projectId, taskId } = seedTask(storage)
    const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
    const target = 'observation-closes-loop'

    recordPrincipleApplications(
      storage,
      { projectId, taskId, reviewRunId: 'run-1' },
      {
        focusedReviewResults: [
          { appliedPrinciples: normalizeAppliedPrinciples([{ principleId: target, verdict: 'ALIGNED', reason: 'a' }], selection) },
        ],
        independentReviewResult: {
          appliedPrinciples: normalizeAppliedPrinciples([{ principleId: target, verdict: 'CONFLICT', reason: 'b' }], selection),
        },
      },
    )

    const disagreements = storage.principleApplications.findDisagreements()
    const targetDisagreement = disagreements.find((row) => row.principleId === target)
    expect(targetDisagreement?.subjectKind).toBe('task')
    expect(targetDisagreement?.verdicts.map((item) => item.reviewStage).sort()).toEqual(['design', 'independent'])
    expect(new Set(targetDisagreement?.verdicts.map((item) => item.verdict))).toEqual(new Set(['ALIGNED', 'CONFLICT']))

    // 全 stage が同じ判定だった原則は disagreement に載らない。
    const agreed = disagreements.find((row) => row.principleId === 'observable-behavior')
    expect(agreed).toBeUndefined()
  })

  it('閾値に達すると core 原則の降格再Review候補が発火し、audit_log へ一度だけ残る', () => {
    const storage = createStorage()
    const { projectId } = seedTask(storage)
    const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
    const target = 'observation-closes-loop'

    // 閾値の1件手前までは発火しない。
    for (let index = 0; index < PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS - 1; index += 1) {
      recordPrincipleApplications(
        storage,
        { projectId, taskId: `task-${index}`, reviewRunId: `run-${index}` },
        {
          focusedReviewResults: [{
            appliedPrinciples: normalizeAppliedPrinciples(
              selection.map((item) => ({ principleId: item.slug, verdict: 'ALIGNED', reason: 'fine' })),
              selection,
            ),
          }],
        },
      )
    }

    expect(buildPrincipleStats(storage).sensors).toHaveLength(0)

    // 閾値ちょうどで発火する。
    const lastIndex = PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS - 1
    const fired = recordPrincipleApplications(
      storage,
      { projectId, taskId: `task-${lastIndex}`, reviewRunId: `run-${lastIndex}` },
      {
        focusedReviewResults: [{
          appliedPrinciples: normalizeAppliedPrinciples(
            selection.map((item) => ({ principleId: item.slug, verdict: 'ALIGNED', reason: 'fine' })),
            selection,
          ),
        }],
      },
    )

    const demotion = fired.sensorFindings.find((finding) => finding.principleId === target)
    expect(demotion?.sensorId).toBe('core-principle-never-conflicts')
    expect(demotion?.evidence).toContain(`applications=${PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS}`)
    expect(demotion?.thresholdNote).toContain('provisional threshold')

    // 発火は durable に残り、同じセンサーは二度記録されない。
    const auditEntries = storage.auditLog.findByEntity('principle_sensor', `core-principle-never-conflicts:${target}`)
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0].result).toBe('fired')
    expect(evaluateAndPersistSensors(storage)).toHaveLength(0)
    expect(storage.auditLog.findByEntity('principle_sensor', `core-principle-never-conflicts:${target}`)).toHaveLength(1)

    // **原則そのものは書き換わっていない。** 発火は再Review候補を作るところまでが責務である。
    expect(corePrincipleSlugs(loadEngineeringPrinciples())).toContain(target)
  })

  it('CONFLICT が1件でもあれば降格候補は発火しない', () => {
    const storage = createStorage()
    const { projectId } = seedTask(storage)
    const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
    const target = 'observation-closes-loop'

    for (let index = 0; index < PRINCIPLE_SENSOR_THRESHOLDS.CORE_DEMOTION_MIN_APPLICATIONS; index += 1) {
      recordPrincipleApplications(
        storage,
        { projectId, taskId: `task-${index}`, reviewRunId: `run-${index}` },
        {
          focusedReviewResults: [{
            appliedPrinciples: normalizeAppliedPrinciples(
              selection.map((item) => ({
                principleId: item.slug,
                verdict: item.slug === target && index === 0 ? 'CONFLICT' : 'ALIGNED',
                reason: 'r',
              })),
              selection,
            ),
          }],
        },
      )
    }

    const sensors = buildPrincipleStats(storage).sensors
    expect(sensors.find((finding) => finding.principleId === target)).toBeUndefined()
  })

  it('記録に失敗しても Review を止めない', () => {
    const storage = createStorage()
    const { projectId } = seedTask(storage)
    const broken = {
      ...storage,
      principleApplications: {
        ...storage.principleApplications,
        recordMany: () => { throw new Error('disk is on fire') },
      },
    } as IStorage

    const selection = selectPrinciples(undefined, loadEngineeringPrinciples())
    const result = recordPrincipleApplications(broken, { projectId, reviewRunId: 'run-x' }, {
      focusedReviewResults: [{ appliedPrinciples: normalizeAppliedPrinciples([], selection) }],
    })

    expect(result.recorded).toBe(0)
    expect(result.error).toContain('disk is on fire')
    expect(result.sensorFindings).toEqual([])
  })
})
