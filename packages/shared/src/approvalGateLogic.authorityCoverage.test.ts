/**
 * RC6-LIST: the HIGH classification of authority / admission / recovery code is an explicit list
 * (`GATE_CHANGE_EXACT_FILES`). A file that is **added** to an authority directory later is not on it,
 * would be LOW, and a Task whose allowedPaths cover that directory could then auto-commit it through
 * the git_commit Safety Evidence (Candidate only, but without a human seeing it there).
 *
 * This test makes the list fail closed for new files: every production `.ts` file under an authority
 * directory must already be HIGH / CRITICAL under `RISK_RULES`, or be named below with the reason it is
 * not authority code. CI runs it (`pnpm -r test`), so a Promotion PR that adds an unclassified authority
 * file fails until someone classifies it (`GATE_CHANGE_EXACT_FILES`) or exempts it here. This file's own
 * name matches the `approvalGate` rule, so editing the exemption list is itself a HIGH change.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runRiskReview } from './approvalGateLogic'

const repoRoot = path.resolve(__dirname, '../../..')

/** Directories whose code defines authority, admission, recovery or the state those decisions read. */
const AUTHORITY_DIRECTORIES = [
  'apps/api/src/pl',
  'apps/api/src/designReview',
  'apps/api/src/humanRecovery',
  'apps/api/src/auth',
  'apps/api/src/storage',
  'apps/api/src/state',
] as const

/** Shared-package files that define admission / occupancy / liveness / reviewer separation. */
const SHARED_AUTHORITY_FILE = /^(?:[A-Za-z0-9]*(?:Admission|Occupancy|Liveness|Separation))\.ts$/

/**
 * Production files in the directories above that are reviewed as **not** authority code (LOW is intended).
 * Adding a line here is a classification decision; give the reason.
 */
const REVIEWED_NON_AUTHORITY_FILES: Readonly<Record<string, string>> = {
  'apps/api/src/designReview/queuedRunDispatch.ts':
    'routes an already-queued run to its executor; both executors run the Design Review (liveness, not admission)',
  'apps/api/src/designReview/repairPromptBuilder.ts':
    'builds repair design text; that text is still Design-Reviewed and bound by its hash before any Job exists',
  'apps/api/src/designReview/retryCooldownTestClock.ts':
    'test-only vitest clock helper; not imported by production code',
  'apps/api/src/pl/adoptionFailure.ts':
    'summarises adoption failures from audit rows for notification and display; decides nothing',
  'apps/api/src/pl/implementTimeoutSensor.ts':
    'read-only sensor that asks for a timeout budget re-evaluation; changes no state',
  'apps/api/src/storage/backup.ts': 'database backup / verification utility',
  'apps/api/src/storage/index.ts': 'storage singleton wiring',
  'apps/api/src/storage/roadmapTaskValidation.ts':
    'structural validation of generated roadmap tasks; runtime path enforcement is the File Change Guard '
    + 'and the Safety Evidence file_policy_violation check',
}

function isProductionTs(file: string): boolean {
  return file.endsWith('.ts')
    && !file.endsWith('.test.ts')
    && !file.endsWith('.spec.ts')
    && !file.endsWith('.d.ts')
    && !file.split('/').includes('__tests__')
}

function listAuthorityFiles(): string[] {
  const files: string[] = []
  for (const dir of AUTHORITY_DIRECTORIES) {
    for (const entry of readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const relative = path.relative(repoRoot, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')
      if (isProductionTs(relative)) files.push(relative)
    }
  }
  for (const entry of readdirSync(path.join(repoRoot, 'packages/shared/src'), { withFileTypes: true })) {
    if (entry.isFile() && SHARED_AUTHORITY_FILE.test(entry.name)) files.push(`packages/shared/src/${entry.name}`)
  }
  return files.sort()
}

const isHighOrCritical = (file: string): boolean => {
  const level = runRiskReview([file]).riskLevel
  return level === 'HIGH' || level === 'CRITICAL'
}

describe('RC6-LIST: authority files are classified HIGH or explicitly reviewed', () => {
  const files = listAuthorityFiles()

  it('finds the authority files (the walk itself works)', () => {
    expect(files).toContain('apps/api/src/pl/executionLoop.ts')
    expect(files).toContain('apps/api/src/auth/apiToken.ts')
    expect(files).toContain('packages/shared/src/resumeAdmission.ts')
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false)
  })

  it('every production file under an authority directory is HIGH / CRITICAL or reviewed as non-authority', () => {
    const unclassified = files.filter((file) => !isHighOrCritical(file) && !(file in REVIEWED_NON_AUTHORITY_FILES))
    // Fix: add the file to GATE_CHANGE_EXACT_FILES (approvalGateLogic.ts), or, if it decides nothing,
    // add it to REVIEWED_NON_AUTHORITY_FILES above with the reason.
    expect(unclassified).toEqual([])
  })

  it('the reviewed list has no stale entries (each exists and is still not HIGH)', () => {
    for (const file of Object.keys(REVIEWED_NON_AUTHORITY_FILES)) {
      expect(files, `${file} no longer exists`).toContain(file)
      expect(isHighOrCritical(file), `${file} is HIGH now; remove it from the reviewed list`).toBe(false)
    }
  })

  it('a newly added file in an authority directory would be caught', () => {
    const newFile = 'apps/api/src/pl/newAdmissionStep.ts'
    expect(isHighOrCritical(newFile)).toBe(false)
    expect(newFile in REVIEWED_NON_AUTHORITY_FILES).toBe(false)
    expect(SHARED_AUTHORITY_FILE.test('humanAdmission.ts')).toBe(true)
    expect(SHARED_AUTHORITY_FILE.test('humanAdmission.test.ts')).toBe(false)
  })

  it('this test file is itself HIGH (editing the reviewed list is a HIGH change)', () => {
    expect(isHighOrCritical('packages/shared/src/approvalGateLogic.authorityCoverage.test.ts')).toBe(true)
  })
})
