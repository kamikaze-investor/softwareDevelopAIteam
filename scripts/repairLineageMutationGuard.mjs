#!/usr/bin/env node
/**
 * repair lineage / repair budget / resume boundary の**保証が本当にテストで固定されているか**を、
 * ガードを壊してみて確かめる harness。
 *
 * 各 mutation は「その 1 行を無効化したら、どのテストも落ちなくなるか」を測る。
 *   - KILLED       : mutation が当たり、テストが**走り切って**落ちた（= 保証は固定されている）
 *   - SURVIVED     : mutation が当たったのにテストが green（= 保証が固定されていない）
 *   - SKIPPED      : anchor 不一致などで mutation が**当たらなかった**（= 測れていない）
 *   - TIMEOUT      : テストが時間内に終わらなかった（= 測れていない）
 *   - INCONCLUSIVE : 終了はしたが vitest の集計が取れない（= 測れていない）
 *
 * **KILLED 以外はすべて失敗である。** 測れなかったことを「問題なし」と読み替えない。
 *
 * ## 実行時の約束（2026-09-22 の事故を受けて明文化）
 *
 * **この harness は単独で実行すること。** 実行中は対象 source を書き換えて元に戻すので、
 * その間に別の vitest / typecheck / 解析を走らせてはならない。**mutated な source を
 * 読んでしまい、無関係なはずの実行が壊れる。**
 *
 * 実際に起きたこと: cycle guard を潰す mutation（`G7`）を当てた状態のまま、別枠で
 * `vitest run src` を起動した。その 2 本目も同じ無限ループを踏み、2 本まとめて
 * 82 分 hang した（当時 walk には停止保証が無かった）。
 *
 * 推奨する順番:
 *   1. source が clean であることを確認
 *   2. 通常の targeted / full test
 *   3. 通常 test の完了を確認
 *   4. **この harness を単独実行**
 *   5. 終了後、source が元に戻っていることを diff で確認
 *   6. 必要なら最後にもう一度 clean な通常 test
 *
 * 使い方: node scripts/repairLineageMutationGuard.mjs
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
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

/** stored-review recovery（`human_recovery` generation root）側。 */
const EPOCH = 'apps/api/src/designReview/repairRecoveryEpoch.ts'
const RECOVERY = 'apps/api/src/designReview/repairFromStoredReview.ts'
const RECOVERY_TESTS = ['src/designReview/repairFromStoredReview.test.ts']
const GENERATION_TESTS = ['src/designReview/repairHumanRecoveryGeneration.test.ts']
const ADMISSION_TESTS = ['src/designReview/repairAfterResumeReview.test.ts']

const MUTATIONS = [
  // ── stored-review recovery / human_recovery generation root ──────────────
  //
  // ここは #270 の予算アルゴリズムを増やしたのではなく、**generation の根を 1 つ
  // 加算した**部分である。守るのは「現在の authority が根になる」「根が決まっても
  // lineage 検査を弱めない」「同じ epoch で予算を繰り返し再発行しない」の 3 点。
  {
    id: 'N12-repair-successor-rejected-again',
    guard: 'blocked Task では resume successor と repair successor の両方を受ける',
    file: REPAIR_FLOW,
    from: '  if (!isResumeSuccessor && !isRepairSuccessor) {',
    to: '  if (!isResumeSuccessor) {',
    tests: [...RECOVERY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N13-arbitrary-repair-successor-allowed',
    guard: 'repair successor は lineage が再構築できるものだけ（prefix 一致では許さない）',
    file: REPAIR_FLOW,
    from: '  if (!lineage.ok) {',
    to: '  if (false) {',
    tests: ADMISSION_TESTS,
  },
  {
    id: 'N14-descendant-human-recovery-not-recognised',
    guard: 'descendant が既に human_recovery generation 内なら新しい承認を要求しない',
    file: RECOVERY,
    from: "  if (dryRun.generation?.rootKind === 'human_recovery') {",
    to: '  if (false) {',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N15-attempt-ignores-generation-depth',
    guard: 'attempt は generation の深さ + 1（descendant でも 1 へ戻さない）',
    file: POLICY,
    from: '  const attempt = walk.depth + 1',
    to: '  const attempt = 1',
    tests: [...RECOVERY_TESTS, ...POLICY_TESTS],
  },
  // ── blocked 例外の authority と、除外してよい live Job ────────────────────
  //
  // どちらも 2026-09-23 の独立レビューが再現させた欠陥である。守るのは 2 つ:
  //   - repair successor を通すのは **human authority の generation の中だけ**
  //   - live 判定から外すのは **実装のすぐ上に連続して並ぶ blocked な ancestor だけ**（件数は固定しない）
  // 両方向に振って測る。緩める側だけ測ると、締めすぎ（正規経路を止める）を見逃す。
  {
    id: 'N16-origin-rooted-repair-admitted',
    guard: 'repair successor は human authority の generation の中だけ通す',
    file: REPAIR_FLOW,
    from: "  if (isRepairSuccessor && lineage.rootKind === 'origin') {",
    to: '  if (false) {',
    tests: ADMISSION_TESTS,
  },
  {
    id: 'N17-human-rooted-repair-rejected',
    guard: 'human_resume / human_recovery generation の descendant は通す（締めすぎない）',
    file: REPAIR_FLOW,
    from: "  if (isRepairSuccessor && lineage.rootKind === 'origin') {",
    to: '  if (isRepairSuccessor) {',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N18-superseded-blocked-ancestors-not-excluded',
    guard: '実装が抜け出してきた blocked ancestor は live 判定から外す',
    file: REPAIR_FLOW,
    from: '    .filter((job) => !supersededBlockedAncestors.has(job.id))',
    to: '    .filter(() => true)',
    tests: [...RECOVERY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N19-any-blocked-job-excluded',
    guard: '外すのは導いた ancestor だけ（blocked Job を一括で無視しない）',
    file: REPAIR_FLOW,
    from: '    .filter((job) => !supersededBlockedAncestors.has(job.id))',
    to: "    .filter((job) => job.status !== 'blocked')",
    tests: [...RECOVERY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N20-nearest-ancestor-only-excluded',
    guard: '外す ancestor の件数を固定しない（REJECT が続いた lineage を admission で止めない）',
    file: REPAIR_FLOW,
    from: '    .filter((job) => !supersededBlockedAncestors.has(job.id))',
    to: '    .filter((job) => job.id !== lineage.lineageAncestorJobIds[0])',
    tests: ADMISSION_TESTS,
  },
  {
    id: 'N21-ancestor-excluded-regardless-of-status',
    guard: '除外の根拠は blocked という状態そのもの（queued / running へ戻った ancestor は外さない）',
    file: REPAIR_FLOW,
    from: "    if (jobsById.get(ancestorId)?.status === 'blocked') {",
    to: '    if (true) {',
    tests: [...RECOVERY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N24-blocked-run-never-breaks',
    guard: '連続が切れたら打ち切る（AI resume を挟んで前 generation の blocked まで外さない）',
    file: REPAIR_FLOW,
    from: '    if (blockedRunStarted) break',
    to: '    if (false) break',
    tests: [...RECOVERY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N26-authority-boundary-ignored',
    guard: 'AI resume は human authority の根を跨がない（根より上の ancestor は見ない）',
    file: REPAIR_FLOW,
    from: "  const crossesHumanAuthority = lineage.rootKind === 'human_resume' && lineage.crossedAiResume",
    to: '  const crossesHumanAuthority = false',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N27-authority-boundary-excludes-the-root',
    guard: '根そのものは外してよい（締めすぎて正規経路を止めない）',
    file: REPAIR_FLOW,
    from: '  const consideredAncestors = authorityBoundary >= 0 ? ancestors.slice(0, authorityBoundary + 1) : ancestors',
    to: '  const consideredAncestors = authorityBoundary >= 0 ? ancestors.slice(0, authorityBoundary) : ancestors',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N28-authority-boundary-without-ai-resume',
    guard: '境界を張るのは AI resume を跨いだときだけ（人が直接進めた chain を止めない）',
    file: REPAIR_FLOW,
    from: "  const crossesHumanAuthority = lineage.rootKind === 'human_resume' && lineage.crossedAiResume",
    to: "  const crossesHumanAuthority = lineage.rootKind === 'human_resume'",
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N25-blocked-run-breaks-only-on-success',
    guard: '打ち切る条件は「blocked でない」こと（success だけを区切りにしない）',
    file: REPAIR_FLOW,
    from: '    if (blockedRunStarted) break',
    to: "    if (blockedRunStarted && jobsById.get(ancestorId)?.status === 'success') break",
    tests: ADMISSION_TESTS,
  },
  {
    id: 'N22-lineage-ancestors-not-recorded',
    guard: 'walk が実際に辿った ancestor を記録する（記録しなければ何も外せない）',
    file: POLICY,
    from: '    const lineageAncestorJobIds = [...seen].filter((id) => id !== sourceJobId)',
    to: '    const lineageAncestorJobIds: string[] = []',
    tests: [...POLICY_TESTS, ...RECOVERY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N23-all-task-jobs-treated-as-ancestors',
    guard: 'ancestor は walk が辿った経路だけ（この Task の Job を丸ごと ancestor にしない）',
    file: POLICY,
    from: '    const lineageAncestorJobIds = [...seen].filter((id) => id !== sourceJobId)',
    to: '    const lineageAncestorJobIds = [...byId.keys()].filter((id) => id !== sourceJobId)',
    tests: [...POLICY_TESTS, ...ADMISSION_TESTS],
  },
  {
    id: 'N11-recovery-reset-not-recorded',
    guard: 'human_recovery の reset を判定にも監査にも同じ導出で残す',
    file: POLICY,
    from: "    return { budgetReset: true, resetReason: 'human_recovery_epoch_started_new_generation' }",
    to: "    return { budgetReset: false, resetReason: 'same_generation' }",
    tests: [...GENERATION_TESTS, ...FLOW_TESTS],
  },
  {
    id: 'N1-recovery-epoch-ignored',
    guard: 'consume 済み recovery epoch をその実装の generation 根として扱う',
    file: POLICY,
    from: '    if (countedRoot === undefined && job.humanRecoveryEpoch === true) {',
    to: '    if (false) {',
    tests: GENERATION_TESTS,
  },
  {
    id: 'N2-recovery-epoch-overrides-nearer-authority',
    guard: '最も近い authority が根（手前で決まった根を上書きしない）',
    file: POLICY,
    from: '    if (countedRoot === undefined && job.humanRecoveryEpoch === true) {',
    to: '    if (job.humanRecoveryEpoch === true) {',
    tests: GENERATION_TESTS,
  },
  {
    id: 'N3-recovery-epoch-stops-the-walk',
    guard: 'epoch が根でも walk は止めない（上流の健全性を確かめる）',
    file: POLICY,
    from: [
      '    if (countedRoot === undefined && job.humanRecoveryEpoch === true) {',
      '      countedRoot = {',
    ].join('\n'),
    to: [
      '    if (countedRoot === undefined && job.humanRecoveryEpoch === true) {',
      '      return finish(cursor); countedRoot = {',
    ].join('\n'),
    tests: GENERATION_TESTS,
  },
  {
    id: 'N5-recovery-epoch-not-wired-into-policy-input',
    guard: 'flow 層が epoch 集合を policy へ渡す（渡さなければ根は生まれない）',
    file: REPAIR_FLOW,
    from: '    humanRecoveryEpoch: humanRecoveryEpochJobIds.has(job.id),',
    to: '    humanRecoveryEpoch: false,',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N6-approved-alone-opens-the-epoch',
    guard: 'epoch は CONSUMED でのみ開く（APPROVED だけでは開かない）',
    file: EPOCH,
    from: "    if (request.status !== 'CONSUMED') continue",
    to: "    if (request.status !== 'CONSUMED' && request.status !== 'APPROVED') continue",
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N7-consumed-epoch-expires-later',
    guard: 'consume 済み epoch は expiresAt を過ぎても有効（expiry は consume 時に見る）',
    file: EPOCH,
    from: '    covered.add(chain.implementJob.id)',
    to: '    if (new Date(request.expiresAt).getTime() > Date.now()) covered.add(chain.implementJob.id)',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N8-recovery-route-runs-outside-blocked',
    guard: 'recovery route は admission が走る blocked Task でのみ動く',
    file: RECOVERY,
    from: "  if (task.status !== 'blocked') {",
    to: '  if (false) {',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'N9-recovery-accepts-any-verdict',
    guard: 'changes_requested の verdict だけを再駆動する',
    file: EPOCH,
    from: "  if (review.status !== 'changes_requested') {",
    to: '  if (false) {',
    tests: RECOVERY_TESTS,
  },
  {
    id: 'G1-ai-resume-resets-budget',
    guard: 'AI / unknown の resume は generation を跨がない',
    file: POLICY,
    from: "if (countedRoot === undefined && job.resumeActorClass === 'human') {",
    to: "if (countedRoot === undefined && job.resumeActorClass !== undefined) {",
    tests: POLICY_TESTS,
  },
  {
    id: 'G2-every-resume-resets-budget',
    guard: 'resume なら誰でも新しい generation、にはしない',
    file: POLICY,
    from: "if (countedRoot === undefined && job.resumeActorClass === 'human') {",
    to: 'if (countedRoot === undefined) {',
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
    // **この 1 件は停止保証も一緒に見ている。** 意味側（seen）を潰しても、データ由来の
    // bound があるので walk は終わり、テストは「cycle と報告しない」ことで落ちる。
    // ここが TIMEOUT になったら停止保証が消えている合図である（2026-09-22 に実際そうなった）。
    guard: '環を検出して止める（かつ、潰しても hang せず通常の test failure になる）',
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
    id: 'G13-fixed-step-threshold-reintroduced',
    guard: '停止保証はデータ由来（Job 件数）であって、恣意的な固定閾値ではない',
    file: POLICY,
    from: '  for (let step = 0; step <= byId.size; step += 1) {',
    to: '  for (let step = 0; step <= 64; step += 1) {',
    tests: POLICY_TESTS,
  },
  {
    id: 'G27-actor-read-failure-breaks-repair',
    guard: '監査の読み取り失敗は unknown へ倒す（判定ごと落とさない）',
    file: ACTOR,
    from: [
      "    return resumeActorClassFromAudit(storage.auditLog.findByEntity('job', jobId))",
      '  } catch (error: unknown) {',
    ].join('\n'),
    to: [
      "    return resumeActorClassFromAudit(storage.auditLog.findByEntity('job', jobId))",
      '  } catch (error: unknown) {',
      '    throw error',
    ].join('\n'),
    tests: FLOW_TESTS,
  },
  {
    id: 'G28-generation-record-breaks-repair',
    guard: 'generation 記録の失敗が repair 生成を落とさない',
    file: REPAIR_FLOW,
    from: [
      '    deriveAndRecordRepairGeneration(storage, repairJob)',
      '  } catch (error: unknown) {',
    ].join('\n'),
    to: [
      '    deriveAndRecordRepairGeneration(storage, repairJob)',
      '  } catch (error: unknown) {',
      '    throw error',
    ].join('\n'),
    tests: FLOW_TESTS,
  },
  {
    id: 'G23-human-row-without-admin-evidence',
    guard: 'human 行は admin credential の根拠と揃っていなければ認めない',
    file: ACTOR,
    from: "  return rows.every((row) => ADMIN_EVIDENCE_PATTERN.test(row.detail ?? '')) ? 'human' : 'unknown'",
    to: "  return 'human'",
    tests: ACTOR_TESTS,
  },
  {
    id: 'G24-cross-task-stepkey-conflict-silently-ok',
    guard: '別 Task に取られた stepKey は already_started にしない',
    file: REPAIR_FLOW,
    from: '      if (ownedByThisTask) {',
    to: '      if (true) {',
    tests: FLOW_TESTS,
  },
  {
    id: 'G25-audit-failure-breaks-the-caller',
    guard: '監査記録の失敗が呼び出し側の操作を失敗させない',
    file: ACTOR,
    from: '  try {\n    write()\n  } catch (error: unknown) {',
    to: '  try {\n    write()\n  } catch (error: unknown) {\n    throw error\n    // eslint-disable-next-line no-unreachable',
    tests: [...ACTOR_TESTS, ...FLOW_TESTS],
  },
  {
    id: 'G22-same-failure-counted-task-wide',
    guard: '「同じ失敗の繰り返し」も generation の中だけで数える',
    file: POLICY,
    from: '      generationRepairJobIds.has(job.id) &&\n',
    to: '      job.workflowStepKey?.startsWith(REPAIR_STEP_PREFIX) === true &&\n',
    tests: POLICY_TESTS,
  },
  {
    id: 'G19-human-root-stops-the-walk',
    guard: 'human が数え終わりでも walk は止めない（上流の健全性を確かめる）',
    file: POLICY,
    from: [
      "      if (countedRoot === undefined && job.resumeActorClass === 'human') {",
      `        countedRoot = { rootJobId: cursor, previousGenerationRoot: parent, kind: 'human_resume' }`,
    ].join('\n'),
    to: [
      "      if (countedRoot === undefined && job.resumeActorClass === 'human') {",
      "        return { ok: true, depth, rootJobId: cursor, rootKind: 'human_resume', previousGenerationRoot: parent, crossedAiResume, generationRepairJobIds }",
    ].join('\n'),
    tests: POLICY_TESTS,
  },
  {
    id: 'G26-human-root-keeps-counting-upstream',
    guard: 'human より上の repair は深さに数えない',
    file: POLICY,
    from: ['      if (countedRoot === undefined) {', '        depth += 1'].join('\n'),
    to: ['      if (true) {', '        depth += 1'].join('\n'),
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

/**
 * 1 回の test 実行あたりの上限（ms）。**production の policy ではなく harness の暴走防止**である。
 *
 * 実測: 単体の test file は 2〜5 秒、baseline（5 file 同時）でも 10 秒台で終わる。
 * 180 秒はその 15 倍以上あり、負荷が高い環境でも正常実行を誤って kill しない。
 * これを短くしすぎると「遅い」を「壊れている」と誤判定するので、余裕側に倒している。
 */
const TEST_TIMEOUT_MS = 180_000

/**
 * test を 1 回走らせて**結果の種別**を返す。
 *
 * 種別を分けるのは、`exit code !== 0` に「mutation を検出した」と
 * 「そもそも走り切っていない」が混ざるからである。後者を KILLED と呼ぶと、
 * **harness が壊れているのに緑に見える**。
 *
 *   - `passed`      : 走り切って green
 *   - `failed`      : 走り切って red（mutation が検出された）
 *   - `timeout`     : 時間内に終わらなかった（= 測れていない）
 *   - `no_summary`  : 終了はしたが vitest の集計行が取れない（= 測れていない）
 */
function runTests(testPaths) {
  const result = spawnSync(process.execPath, [vitestBin, 'run', ...testPaths], {
    cwd: apiDir,
    encoding: 'utf-8',
    env: { ...process.env, CI: 'true' },
    timeout: TEST_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })

  const timedOut =
    result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal !== null)
  if (timedOut) {
    return { kind: 'timeout', detail: `no result within ${TEST_TIMEOUT_MS} ms` }
  }
  if (result.error) {
    return { kind: 'no_summary', detail: `runner failed to start: ${result.error.message}` }
  }

  // **集計行が無い実行は信用しない。** crash や収集エラーでも exit code が付くことがあり、
  // そのとき「テストが落ちたから mutation を検出できた」とは言えない。
  //
  // vitest は集計行に色を付けるので、**ANSI を落としてから**照合する
  // （落とさないと `Test Files <ESC>[2m…99 passed` に一致せず、正常な実行を
  // `no_summary` と誤判定する。最初の実装がまさにそれで baseline を止めた）。
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\[[0-9;]*m/g, '')
  if (!/Test Files\s+\d/.test(output) && !/Tests\s+\d/.test(output)) {
    return { kind: 'no_summary', detail: `exit=${result.status} without a vitest summary` }
  }

  return { kind: result.status === 0 ? 'passed' : 'failed' }
}

function main() {
  // anchor は LF で書いてある。checkout が CRLF の環境（Windows の autocrlf）でも
  // 同じ結果になるよう、**照合と書き戻しは LF 正規化した内容で行い、後始末では元の bytes に戻す**。
  const baselineFiles = new Map()
  for (const file of new Set(MUTATIONS.map((m) => m.file))) {
    const raw = readFileSync(path.join(repoRoot, file), 'utf-8')
    baselineFiles.set(file, { raw, normalized: raw.replace(/\r\n/g, '\n') })
  }

  // stdout を file へ redirect すると Node はバッファするので、途中経過が一切見えない。
  // 2026-09-22 の hang では「出力 0 バイト」を「baseline で止まっている」と読み違えた。
  // `MUTATION_GUARD_LOG` が指定されていれば、同じ行を**都度 flush して**書き足す。
  const logPath = process.env.MUTATION_GUARD_LOG
  const say = (line) => {
    process.stdout.write(`${line}\n`)
    if (logPath) {
      try {
        appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
      } catch {
        // 進捗ログが書けないことで mutation の測定を止めない。
      }
    }
  }

  say('baseline: running')
  const baseline = runTests([...new Set(MUTATIONS.flatMap((m) => m.tests))])
  if (baseline.kind !== 'passed') {
    say(`baseline: FAILED (${baseline.kind}${baseline.detail ? `: ${baseline.detail}` : ''})`)
    say('変異を当てる前からテストが走り切って green になっていない。mutation の結果は読めない。')
    process.exit(1)
  }
  say('baseline: green')
  say('')

  const results = []
  for (const mutation of MUTATIONS) {
    const absolute = path.join(repoRoot, mutation.file)
    const { raw, normalized } = baselineFiles.get(mutation.file)

    const occurrences = normalized.split(mutation.from).length - 1
    if (occurrences !== 1) {
      results.push({ ...mutation, outcome: 'SKIPPED', note: `anchor occurs ${occurrences} times` })
      say(`${mutation.id}: SKIPPED (anchor occurs ${occurrences} times)`)
      continue
    }

    const mutated = normalized.replace(mutation.from, mutation.to)
    if (mutated === normalized) {
      results.push({ ...mutation, outcome: 'SKIPPED', note: 'replacement did not change the file' })
      say(`${mutation.id}: SKIPPED (replacement did not change the file)`)
      continue
    }

    let run
    try {
      writeFileSync(absolute, mutated)
      // **当たったことを読み戻して確かめる。** 書けたつもりで当たっていないと、
      // 「元のコードで green」を「mutation が生き残った」と読み違える。
      if (readFileSync(absolute, 'utf-8') !== mutated) {
        results.push({ ...mutation, outcome: 'SKIPPED', note: 'mutation was not applied on disk' })
        say(`${mutation.id}: SKIPPED (mutation was not applied on disk)`)
        continue
      }
      run = runTests(mutation.tests)
    } finally {
      writeFileSync(absolute, raw)
      // **戻せたことも読み戻して確かめる。** ここが崩れると以降の mutation も
      // その後の通常実行も、全部意味が変わる。戻せないなら即止める。
      if (readFileSync(absolute, 'utf-8') !== raw) {
        say(`${mutation.id}: FATAL — could not restore ${mutation.file}`)
        process.exit(2)
      }
    }

    const outcome =
      run.kind === 'failed' ? 'KILLED'
        : run.kind === 'passed' ? 'SURVIVED'
          : run.kind === 'timeout' ? 'TIMEOUT'
            : 'INCONCLUSIVE'
    results.push({ ...mutation, outcome, note: run.detail })
    say(`${mutation.id}: ${outcome}  — ${mutation.guard}${run.detail ? ` (${run.detail})` : ''}`)
  }

  const killed = results.filter((r) => r.outcome === 'KILLED')
  // **KILLED 以外はすべて失敗である。** 「生き残った」も「当てられなかった」も
  // 「時間内に終わらなかった」も「集計が取れなかった」も、**保証を測れていない**点で同じ。
  const notKilled = results.filter((r) => r.outcome !== 'KILLED')
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length

  say('')
  say(
    `killed=${killed.length} survived=${count('SURVIVED')} skipped=${count('SKIPPED')} ` +
    `timeout=${count('TIMEOUT')} inconclusive=${count('INCONCLUSIVE')}`,
  )

  if (notKilled.length > 0) {
    for (const r of notKilled) {
      say(`  ${r.outcome}: ${r.id} — ${r.guard}${r.note ? ` (${r.note})` : ''}`)
    }
    process.exit(1)
  }
  say('すべての mutation が落ちた。ガードはテストで固定されている。')
}

main()
