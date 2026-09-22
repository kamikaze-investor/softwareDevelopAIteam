#!/usr/bin/env node
/**
 * repair lineage / repair budget / resume boundary の**保証が本当にテストで固定されているか**を、
 * ガードを壊してみて確かめる harness。
 *
 * 各 mutation は「その 1 行を無効化したら、どのテストも落ちなくなるか」を測る。
 *   - KILLED   : mutation を当てたらテストが落ちた（= その保証は固定されている）
 *   - SURVIVED : mutation を当ててもテストが通った（= 保証が固定されていない → 失敗）
 *   - SKIPPED  : anchor が見つからず mutation を当てられなかった（= 測れていない → 失敗）
 *
 * **SKIPPED も失敗として扱う。** 測れなかったことを「問題なし」と読み替えない。
 *
 * 使い方: node scripts/repairLineageMutationGuard.mjs
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiDir = path.join(repoRoot, 'apps', 'api')
// `.bin/vitest` は shell wrapper なので node から直接は読めない。JS entry を指す。
const vitestBin = path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs')

const POLICY = 'apps/api/src/designReview/repairPolicy.ts'
const ACTOR = 'apps/api/src/designReview/resumeActor.ts'
const TASK_ROUTES = 'apps/api/src/routes/tasks.ts'
const PL_LOOP = 'apps/api/src/pl/executionLoop.ts'
const REPAIR_FLOW = 'apps/api/src/designReview/repairFlow.ts'

/** mutation を当てたとき、**必ず落ちてほしい**テスト群。 */
const POLICY_TESTS = ['src/designReview/repairPolicy.test.ts']
const ACTOR_TESTS = [
  'src/designReview/resumeActor.test.ts',
  'src/designReview/resumeActorAuthorization.test.ts',
]
const ROUTE_TESTS = ['src/designReview/resumeActorAuthorization.test.ts']
const PL_TESTS = ['src/pl/executionLoop.test.ts']
const FLOW_TESTS = ['src/designReview/repairFlow.test.ts']

const MUTATIONS = [
  {
    id: 'G1-ai-resume-resets-budget',
    guard: 'AI / unknown の resume は generation を跨がない',
    file: POLICY,
    from: "if (job.resumeActorClass === 'human') {",
    to: "if (job.resumeActorClass !== undefined) {",
    tests: POLICY_TESTS,
  },
  {
    id: 'G2-every-resume-resets-budget',
    guard: 'resume なら誰でも新しい generation、にはしない',
    file: POLICY,
    from: "if (job.resumeActorClass === 'human') {",
    to: 'if (true) {',
    tests: POLICY_TESTS,
  },
  {
    id: 'G3-unknown-actor-treated-as-human',
    guard: '記録が無い / 矛盾する actor を human へ倒さない',
    file: ACTOR,
    from: "  if (seen.size !== 1) return 'unknown'",
    to: "  if (seen.size !== 1) return 'human'",
    tests: ACTOR_TESTS,
  },
  {
    id: 'G4-non-admin-credential-becomes-human',
    guard: 'human の根拠は ADMIN credential だけ',
    file: ACTOR,
    from: "    case 'worker':\n    case 'actions_readonly':\n      return 'ai'\n",
    to: "    case 'worker':\n    case 'actions_readonly':\n      return 'human'\n",
    tests: ACTOR_TESTS,
  },
  {
    id: 'G5-legacy-credential-becomes-human',
    guard: 'legacy 単一 token を human と扱わない',
    file: ACTOR,
    from: "    default:\n      return 'unknown'\n  }\n}\n\n/** credential 種別 → 根拠の種別名。 */",
    to: "    default:\n      return 'human'\n  }\n}\n\n/** credential 種別 → 根拠の種別名。 */",
    tests: ACTOR_TESTS,
  },
  {
    id: 'G6-cross-task-ancestry-allowed',
    guard: 'この Task に無い親を辿ったら数え直さず止める',
    file: POLICY,
    from: "      return { ok: false, reason: `lineage references job ${cursor}, which is not a job of this task` }",
    to: "      return { ok: true, depth, rootJobId: cursor, rootKind: 'origin', crossedAiResume }",
    tests: POLICY_TESTS,
  },
  {
    id: 'G7-cycle-detection-removed',
    guard: '環を検出して止める',
    file: POLICY,
    from: '    if (seen.has(cursor)) {\n      return { ok: false, reason: `lineage forms a cycle at job ${cursor}` }\n    }',
    to: '    if (false) {\n      return { ok: false, reason: `lineage forms a cycle at job ${cursor}` }\n    }',
    tests: POLICY_TESTS,
  },
  {
    id: 'G8-max-repair-attempts-raised',
    guard: '上限は既存の MAX_REPAIR_ATTEMPTS のまま',
    file: POLICY,
    from: 'export const MAX_REPAIR_ATTEMPTS = 3',
    to: 'export const MAX_REPAIR_ATTEMPTS = 99',
    tests: POLICY_TESTS,
  },
  {
    id: 'G9-lineage-failure-falls-open',
    guard: '数え切れなかったら escalate（depth 0 の repair にしない）',
    file: POLICY,
    from: '  const walk = walkRepairGeneration(sourceJobId, priorJobs)\n  if (!walk.ok) {',
    to: '  const walk = walkRepairGeneration(sourceJobId, priorJobs)\n  if (false && !walk.ok) {',
    tests: POLICY_TESTS,
  },
  {
    id: 'G10-malformed-repair-key-ignored',
    guard: '壊れた repair stepKey を黙って根にしない',
    file: POLICY,
    from: '        return { ok: false, reason: `malformed repair step key on job ${cursor}` }',
    to: "        return { ok: true, depth, rootJobId: cursor, rootKind: 'origin', crossedAiResume }",
    tests: POLICY_TESTS,
  },
  {
    id: 'G11-malformed-resume-key-ignored',
    guard: '壊れた resume stepKey を黙って根にしない',
    file: POLICY,
    from: '        return { ok: false, reason: `malformed resume step key on job ${cursor}` }',
    to: "        return { ok: true, depth, rootJobId: cursor, rootKind: 'origin', crossedAiResume }",
    tests: POLICY_TESTS,
  },
  {
    id: 'G12-ambiguous-lineage-ignored',
    guard: '同じ id が 2 件ある入力を曖昧として止める',
    file: POLICY,
    from: '      return { ok: false, reason: `ambiguous lineage: duplicate job id ${job.id}` }',
    to: '      byId.set(job.id, job)',
    tests: POLICY_TESTS,
  },
  {
    id: 'G13-bounded-walk-removed',
    guard: '歩数の上限を超えたら止める',
    file: POLICY,
    from: 'const MAX_ANCESTRY_STEPS = 64',
    to: 'const MAX_ANCESTRY_STEPS = 100_000',
    tests: POLICY_TESTS,
  },
  {
    id: 'G19-human-resume-parent-unchecked',
    guard: 'human と記録されていても、親リンクが使えない resume は根にしない',
    file: POLICY,
    from: '        if (parent === cursor || seen.has(parent) || !byId.has(parent)) {',
    to: '        if (false) {',
    tests: POLICY_TESTS,
  },
  {
    id: 'G20-queued-repair-accepts-loose-stepkey',
    guard: 'executeQueuedRepair は規約形の stepKey しか受けない',
    file: REPAIR_FLOW,
    from: '  const sourceJobId = parseRepairSource(stepKey)',
    to: "  const sourceJobId = stepKey.slice(REPAIR_STEP_PREFIX.length).split(':')[0]",
    tests: FLOW_TESTS,
  },
  {
    id: 'G21-queued-repair-accepts-cross-task-source',
    guard: 'executeQueuedRepair は別 Task の source を受けない',
    file: REPAIR_FLOW,
    from: '  if (sourceJob.taskId !== taskId) {',
    to: '  if (false) {',
    tests: FLOW_TESTS,
  },
  {
    id: 'G17-stepkey-race-becomes-500',
    guard: 'stepKey の一意制約 race は already_started（例外を投げ返さない）',
    file: REPAIR_FLOW,
    from: '    if (isWorkflowStepKeyConflict(error)) {',
    to: '    if (false && isWorkflowStepKeyConflict(error)) {',
    tests: FLOW_TESTS,
  },
  {
    id: 'G18-generation-not-recorded',
    guard: 'repair Job の generation を既存 audit へ残す',
    file: REPAIR_FLOW,
    from: '  recordGenerationForCreatedRepairJob(storage, repairJob)\n\n  return {\n    status: ',
    to: '  if (false) recordGenerationForCreatedRepairJob(storage, repairJob)\n\n  return {\n    status: ',
    tests: FLOW_TESTS,
  },
  {
    id: 'G14-route-declares-every-resume-human',
    guard: 'route は credential から導いた actor をそのまま記録する',
    file: TASK_ROUTES,
    from: '      actorClass: actor.actorClass,\n      evidence: actor.evidence,',
    to: "      actorClass: 'human',\n      evidence: actor.evidence,",
    tests: ROUTE_TESTS,
  },
  {
    id: 'G15-route-stops-recording-actor',
    guard: 'route が actor を記録しなければ human resume は成立しない',
    file: TASK_ROUTES,
    from: '    const actor = classifyResumeActorFromRequest(req)\n    recordResumeActor(storage, {',
    to: '    const actor = classifyResumeActorFromRequest(req)\n    if (false) recordResumeActor(storage, {',
    tests: ROUTE_TESTS,
  },
  {
    id: 'G16-pl-resume-declares-itself-human',
    guard: 'PL の in-process resume は ai として記録される',
    file: PL_LOOP,
    from: "      actorClass: 'ai',\n      evidence: 'in_process_pl',",
    to: "      actorClass: 'human',\n      evidence: 'in_process_pl',",
    tests: PL_TESTS,
  },
]

function runTests(testPaths) {
  const result = spawnSync(process.execPath, [vitestBin, 'run', ...testPaths], {
    cwd: apiDir,
    encoding: 'utf-8',
    env: { ...process.env, CI: 'true' },
  })
  return result.status === 0
}

function main() {
  // anchor は LF で書いてある。checkout が CRLF の環境（Windows の autocrlf）でも
  // 同じ結果になるよう、**照合と書き戻しは LF 正規化した内容で行い、後始末では元の bytes に戻す**。
  const baselineFiles = new Map()
  for (const file of new Set(MUTATIONS.map((m) => m.file))) {
    const raw = readFileSync(path.join(repoRoot, file), 'utf-8')
    baselineFiles.set(file, { raw, normalized: raw.replace(/\r\n/g, '\n') })
  }

  process.stdout.write('baseline: ')
  const baselineGreen = runTests([...new Set(MUTATIONS.flatMap((m) => m.tests))])
  if (!baselineGreen) {
    process.stdout.write('FAILED\n')
    process.stdout.write('変異を当てる前からテストが落ちている。mutation の結果は読めない。\n')
    process.exit(1)
  }
  process.stdout.write('green\n\n')

  const results = []
  for (const mutation of MUTATIONS) {
    const absolute = path.join(repoRoot, mutation.file)
    const { raw, normalized } = baselineFiles.get(mutation.file)

    const occurrences = normalized.split(mutation.from).length - 1
    if (occurrences !== 1) {
      results.push({ ...mutation, outcome: 'SKIPPED', note: `anchor occurs ${occurrences} times` })
      process.stdout.write(`${mutation.id}: SKIPPED (anchor occurs ${occurrences} times)\n`)
      continue
    }

    writeFileSync(absolute, normalized.replace(mutation.from, mutation.to))
    let green
    try {
      green = runTests(mutation.tests)
    } finally {
      writeFileSync(absolute, raw)
    }

    const outcome = green ? 'SURVIVED' : 'KILLED'
    results.push({ ...mutation, outcome })
    process.stdout.write(`${mutation.id}: ${outcome}  — ${mutation.guard}\n`)
  }

  const survived = results.filter((r) => r.outcome === 'SURVIVED')
  const skipped = results.filter((r) => r.outcome === 'SKIPPED')

  process.stdout.write(
    `\nkilled=${results.length - survived.length - skipped.length} survived=${survived.length} skipped=${skipped.length}\n`,
  )

  if (survived.length > 0 || skipped.length > 0) {
    for (const r of [...survived, ...skipped]) {
      process.stdout.write(`  ${r.outcome}: ${r.id} — ${r.guard}${r.note ? ` (${r.note})` : ''}\n`)
    }
    process.exit(1)
  }
  process.stdout.write('すべての mutation が落ちた。ガードはテストで固定されている。\n')
}

main()
