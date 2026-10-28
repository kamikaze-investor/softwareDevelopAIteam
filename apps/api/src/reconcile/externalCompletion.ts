/**
 * External completion reconcile — Candidate 以外で完了した正式成果を Task completion へ戻す。
 *
 * ## これは何をしないか
 *
 * - **実装しない。** protected file を書く権限も、Safety Boundary を動かす権限も与えない
 * - **新しい Task status を作らない。** 終端は既存の `done` である
 * - **新しい completion 経路を作らない。** `reconcileExternalCompletion()` は
 *   Candidate commit と**同じ** completion transition を共有する
 * - **汎用の Acceptance Criteria 実行エンジンを作らない**（CEO 指示・2026-09-15）
 *
 * ## 呼び出し側の自己申告では通らない
 *
 * 機械的に確かめられるものは、ここで **repository と DB から確かめる**:
 *
 * | 主張 | 確かめ方 |
 * |---|---|
 * | 対象 Task が実在し、まだ done でない | DB |
 * | Roadmap item が Task のものと一致する | DB（`task.roadmapTaskKey`） |
 * | commit が canonical master に入っている | `git merge-base --is-ancestor <sha> HEAD` |
 * | Stable へ deploy 済みである | **同じ検査**（Stable の HEAD の祖先＝deploy 済み） |
 * | 変更ファイルが申告どおりである | `git show --name-only <sha>` |
 *
 * 機械で確かめられない項目（PR URL / Independent Review の結論 / CI 結果 / 受入根拠 /
 * CEO が許可した Tier B scope）は**必須入力**とし、`audit_log` へそのまま残す。
 * 空なら通さない。「書かなくても通る」にすると記録が形骸化する。
 *
 * commit が Stable の HEAD の祖先であることを見るのは、**merge 済みと deploy 済みを1回で
 * 確かめられる**からである。ネットワークにも触れない。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { getBaseRoadmapId, isFollowUpTaskKey } from '@ai-team/shared'
import type { Job } from '@ai-team/shared'
import type { IStorage } from '../storage/interface'
import { findBlockedRowsHoldingWorkspace } from '../state/blockedRowOwnership'

/** `reconcileExternalCompletion` が blocked Job の残る Task を断るときの code。 */
export const TASK_HAS_BLOCKED_JOBS = 'TASK_HAS_BLOCKED_JOBS' as const

/**
 * 外部完了の取り込みを塞ぐ blocked Job — **workspace を所有する** blocked 行
 * （claim guard と同じ `findBlockedRowsHoldingWorkspace`: quarantine 行、または stale 候補でも
 * Human Resume に superseded されてもいない行）。park された Task の非 quarantine 行は stale 候補で、
 * 解放は Worker の観測が担うので取り込みを塞がない（lifecycle repair C2 / Codex review）。
 *
 * 取り込みは Task を done にするだけで Job に触れない。blocked 行を残したまま done にすると
 * 「done な Task の blocked 行」になり、workspace の解放は Worker の観測頼みで、
 * done Task は resume も abort もできないので人が解く出口が無い。取り込みには
 * clean worktree の証拠も無いので終端化もしない。**先に resume か abort_task で
 * blocked 行を片付けてから**取り込む（abort は workspace を観測して blocked 行を解放し park する。
 * park された Task も取り込める）。route の Gate 前チェックと storage の transaction 内チェックが
 * 同じこの関数を使う。
 */
export function findBlockedJobsPreventingReconcile(storage: IStorage, taskId: string): Job[] {
  const task = storage.tasks.findById(taskId)
  if (!task) return []
  return findBlockedRowsHoldingWorkspace(storage, task, storage.jobs.findByTaskId(taskId))
}

/** 409 応答の本文。route の Gate 前チェックと storage の拒否で同じ文面を使う。 */
export function blockedJobsReconcileRefusalReason(blocked: readonly Job[]): string {
  return `Task still has blocked job(s) ${blocked.map((job) => job.id).join(', ')}; `
    + 'resume the task or abort it (abort_task) first, then reconcile the external completion'
}

/** 呼び出し側が主張する根拠。**機械照合できるものは下で照合する。** */
export interface ExternalCompletionEvidence {
  /**
   * **その Task の identity**（`task.roadmapTaskKey`）。完全一致でなければ通さない。
   *
   * **名前は `roadmapItemId` だが、要求しているのは ledger item の id ではなく Task identity である。**
   * 通常 Task では両者が同じなので差が出ないが、follow-up Task では
   * `<ledger id>#<sequence>`（例 `roadmap-adoption-followups#2`）でなければならない。
   * ledger id だけを渡すと、**別 Task の成果で follow-up を閉じられてしまう**ため拒否する。
   *
   * wire 互換のためフィールド名は変えていない（`.strict()` の外部 API 契約）。
   * 意味の曖昧さは、ここと照合エラーの文面で解消する。
   */
  roadmapItemId: string
  /** 外部実装の commit（canonical master 上）。 */
  commitSha: string
  /** 外部実装の PR。機械照合はしないが必須。 */
  pullRequestUrl: string
  /** Independent Review の最終結論。`approved` 以外は通さない。 */
  independentReviewVerdict: string
  /** CI / 関連テストの結果。 */
  ciResult: string
  /** 受入条件を満たした根拠。 */
  acceptanceEvidence: string
  /** CEO が Tier B として許可した範囲。 */
  approvedScope: string
}

export type ExternalCompletionCheck =
  | { ok: true; verified: { commit: string; changedFiles: readonly string[]; stableHead: string } }
  | { ok: false; reason: string }

/** Stable（API が動いているリポジトリ）のルート。Design Review と同じ解決方法を使う。 */
function resolveRepoRoot(): string {
  return process.env.DESIGN_REVIEW_REPO_ROOT ?? path.resolve(process.cwd(), '../..')
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** 空白だけの申告を通さない。記録が形骸化するため。 */
function missingFields(evidence: ExternalCompletionEvidence): string[] {
  const required: Array<[keyof ExternalCompletionEvidence, string]> = [
    ['roadmapItemId', 'roadmapItemId'],
    ['commitSha', 'commitSha'],
    ['pullRequestUrl', 'pullRequestUrl'],
    ['independentReviewVerdict', 'independentReviewVerdict'],
    ['ciResult', 'ciResult'],
    ['acceptanceEvidence', 'acceptanceEvidence'],
    ['approvedScope', 'approvedScope'],
  ]
  return required.filter(([key]) => String(evidence[key] ?? '').trim() === '').map(([, label]) => label)
}

/**
 * 根拠を検証する。**fail-closed** — 確かめられない主張があれば通さない。
 */
export function verifyExternalCompletion(
  storage: IStorage,
  taskId: string,
  evidence: ExternalCompletionEvidence,
  repoRoot: string = resolveRepoRoot(),
): ExternalCompletionCheck {
  const absent = missingFields(evidence)
  if (absent.length > 0) {
    return { ok: false, reason: `missing required evidence: ${absent.join(', ')}` }
  }

  const task = storage.tasks.findById(taskId)
  if (!task) return { ok: false, reason: 'Task not found' }
  if (task.status === 'done') return { ok: false, reason: 'Task is already done' }

  // 採用元との一致。別 Task の成果で別 Task を閉じられないようにする。
  // **Task identity の完全一致**を要求する（base id への緩和はしない）。
  if (task.roadmapTaskKey !== evidence.roadmapItemId) {
    // follow-up Task に base id だけを渡した場合は、間違いの内容が分かる文面にする。
    // 判定そのものは緩めない。
    const taskKey = task.roadmapTaskKey
    const looksLikeBaseOfFollowUp = taskKey !== undefined
      && isFollowUpTaskKey(taskKey)
      && getBaseRoadmapId(taskKey) === evidence.roadmapItemId
    return {
      ok: false,
      reason: looksLikeBaseOfFollowUp
        ? `roadmapItemId "${evidence.roadmapItemId}" is the base roadmap item; `
          + `this Task is a follow-up and requires its full task identity "${taskKey}"`
        : `roadmapItemId "${evidence.roadmapItemId}" does not match this Task's roadmapTaskKey`,
    }
  }

  // Independent Review は `approved` でなければ通さない。
  if (evidence.independentReviewVerdict.trim().toLowerCase() !== 'approved') {
    return {
      ok: false,
      reason: `independent review verdict must be "approved", got "${evidence.independentReviewVerdict}"`,
    }
  }

  // commit の綴りを先に固定する。任意文字列を git へ渡さない。
  if (!/^[0-9a-f]{7,40}$/i.test(evidence.commitSha)) {
    return { ok: false, reason: 'commitSha must be a hex git object name' }
  }

  let stableHead: string
  let commit: string
  let changedFiles: readonly string[]
  try {
    stableHead = git(repoRoot, ['rev-parse', 'HEAD'])
    // 承認との束縛（`checkApprovalEvidenceBinding`）で短縮 SHA と完全 SHA を同じ commit として比べるため、解決しておく。
    commit = git(repoRoot, ['rev-parse', '--verify', `${evidence.commitSha}^{commit}`])
    // **merge 済みかつ deploy 済み**を1回で確かめる。
    // Stable の HEAD の祖先である ⇒ master に入っていて、かつ稼働中のコードに含まれる。
    git(repoRoot, ['merge-base', '--is-ancestor', evidence.commitSha, 'HEAD'])
    changedFiles = git(repoRoot, ['show', '--name-only', '--pretty=format:', evidence.commitSha])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason:
        `commit ${evidence.commitSha} is not an ancestor of the deployed Stable HEAD `
        + `(not merged to canonical master, or not deployed yet): ${message}`,
    }
  }

  if (changedFiles.length === 0) {
    return { ok: false, reason: `commit ${evidence.commitSha} changed no files` }
  }

  return { ok: true, verified: { commit, changedFiles, stableHead } }
}

/**
 * 根拠の digest。**承認依頼の `targetDiffHash` に載せ、承認と根拠を同じ記録へ束縛する**ために使う
 * （Mobile の 1 画面取り込み。CEO が画面で確認した根拠そのものに承認を結び付ける）。
 *
 * key の順序を固定した JSON の sha256。前後空白は schema と同じく落としてから数える。
 */
export function externalCompletionEvidenceDigest(
  taskId: string,
  sourceJobId: string,
  evidence: ExternalCompletionEvidence,
): string {
  const canonical = JSON.stringify([
    taskId,
    sourceJobId,
    evidence.roadmapItemId.trim(),
    evidence.commitSha.trim().toLowerCase(),
    evidence.pullRequestUrl.trim(),
    evidence.independentReviewVerdict.trim(),
    evidence.ciResult.trim(),
    evidence.acceptanceEvidence.trim(),
    evidence.approvedScope.trim(),
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/** 承認依頼の `targetDiffHash` に載せる値（requestedAction を前置して他の action の値と混ざらないようにする）。 */
export function externalCompletionApprovalDiffHash(digest: string): string {
  return `reconcile_external_completion:sha256:${digest}`
}

/**
 * `.github/CODEOWNERS`（Stable HEAD）で Code Owner の付く変更ファイル。**表示専用**で、authorization にも
 * eligible にも使わない。照合は Code Owner Approval check と同じ正本（`.github/scripts/codeowners.mjs`）を使う。
 * 読めなければ `undefined`（画面は「確認できない」と出す）。
 *
 * 正本は ESM（`.mjs`）なので **dynamic import** で読む。API の build（NodeNext / CommonJS 出力）で静的 import にすると
 * `require()` になり、require(esm) の無い Node では起動時に落ちる。dynamic import はそのまま残る。
 */
async function codeOwnedFiles(repoRoot: string, files: readonly string[]): Promise<string[] | undefined> {
  try {
    const { ownersFor, parseCodeownersRules } = await import('../../../../.github/scripts/codeowners.mjs')
    const rules = parseCodeownersRules(git(repoRoot, ['show', 'HEAD:.github/CODEOWNERS']))
    return files.filter((file) => ownersFor(file, rules).length > 0)
  } catch {
    return undefined
  }
}

/** 承認と根拠の束縛が崩れているときの code（取り込み route が 409 で返す）。 */
export const APPROVAL_EVIDENCE_MISMATCH = 'APPROVAL_EVIDENCE_MISMATCH' as const

/**
 * **承認が、いま取り込もうとしている commit と根拠そのものに対して下されたか**を確かめる。
 *
 * Gate（`checkApprovalGate`）は Task・action・APPROVED・期限・人の記録を見るが、承認依頼の
 * `targetCommit` / `targetDiffHash` は見ない。そのままだと、ある commit・根拠で下りた承認で
 * 別の commit・別の PR / CI / 受入根拠 / scope を取り込めてしまう。ここで
 *
 * - `targetCommit` が根拠の commit と**同じ commit object** に解決される
 * - `targetDiffHash` が実行 body から server が計算し直した digest と一致する
 *
 * の両方を要求する。古い形（`targetDiffHash` に digest を持たない）承認は通さない —— 改めて
 * この根拠に対する人の承認を取る（Codex design review）。承認依頼が無ければここでは判定せず、
 * Gate に「存在しない」と断らせる。
 */
export function checkApprovalEvidenceBinding(
  storage: IStorage,
  input: { approvalRequestId: string; taskId: string; sourceJobId: string; evidence: ExternalCompletionEvidence; commit: string },
  repoRoot: string = resolveRepoRoot(),
): { ok: true } | { ok: false; reason: string } {
  const request = storage.approvalRequests.findById(input.approvalRequestId)
  if (!request) return { ok: true }

  const expected = externalCompletionApprovalDiffHash(
    externalCompletionEvidenceDigest(input.taskId, input.sourceJobId, input.evidence),
  )
  if (request.targetDiffHash !== expected) {
    return {
      ok: false,
      reason:
        `approval request ${input.approvalRequestId} was not issued for this evidence `
        + '(targetDiffHash does not match the digest of the submitted evidence); '
        + 'issue a new approval request with the digest returned by the preview',
    }
  }
  const approvedCommit = /^[0-9a-f]{7,40}$/i.test(request.targetCommit) ? resolveCommit(repoRoot, request.targetCommit) : undefined
  if (approvedCommit !== input.commit) {
    return {
      ok: false,
      reason: `approval request ${input.approvalRequestId} was issued for commit "${request.targetCommit}", not ${input.commit}`,
    }
  }
  return { ok: true }
}

function resolveCommit(repoRoot: string, sha: string): string | undefined {
  try {
    return git(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])
  } catch {
    return undefined
  }
}

/** 取り込み前の確認結果（読むだけ。状態は何も変えない）。 */
export interface ExternalCompletionPreview {
  task: { id: string; title: string; status: string; parked: boolean; roadmapTaskKey: string | null }
  /** 取り込みの入口条件をすべて満たすか（実行時に API がもう一度すべて確かめる）。 */
  eligible: boolean
  /** 満たさない条件（CEO に見せる。空なら eligible）。 */
  problems: string[]
  verification:
    | { ok: true; commit: string; changedFiles: readonly string[]; codeOwnedFiles: readonly string[] | null; stableHead: string }
    | { ok: false; reason: string }
  sourceJobValid: boolean
  blockingJobIds: string[]
  evidenceDigest: string
  approvalTargetDiffHash: string
}

/**
 * 取り込み（`POST /api/tasks/:id/reconcile-external-completion`）と**同じ検査を、状態を変えずに**行う。
 * 根拠の検証は `verifyExternalCompletion()`、blocked Job は `findBlockedJobsPreventingReconcile()` をそのまま使い、
 * 判定を複製しない。Gate（承認）はここでは評価しない —— 承認はこの確認の後に CEO が下す。
 */
export async function previewExternalCompletion(
  storage: IStorage,
  taskId: string,
  sourceJobId: string,
  evidence: ExternalCompletionEvidence,
  repoRoot: string = resolveRepoRoot(),
): Promise<ExternalCompletionPreview | undefined> {
  const task = storage.tasks.findById(taskId)
  if (!task) return undefined

  const problems: string[] = []
  const checked = verifyExternalCompletion(storage, taskId, evidence, repoRoot)
  if (!checked.ok) problems.push(checked.reason)

  const source = storage.jobs.findById(sourceJobId)
  const sourceJobValid = source !== undefined && source.taskId === taskId
  if (!sourceJobValid) problems.push('Source Job not found for this Task')

  const blockingJobIds = findBlockedJobsPreventingReconcile(storage, taskId).map((job) => job.id)
  if (blockingJobIds.length > 0) problems.push(`Task still has blocked job(s) ${blockingJobIds.join(', ')}`)

  const evidenceDigest = externalCompletionEvidenceDigest(taskId, sourceJobId, evidence)
  return {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      parked: storage.tasks.isParked(task.id),
      roadmapTaskKey: task.roadmapTaskKey ?? null,
    },
    eligible: problems.length === 0,
    problems,
    verification: checked.ok
      ? {
        ok: true,
        commit: checked.verified.commit,
        changedFiles: checked.verified.changedFiles,
        codeOwnedFiles: (await codeOwnedFiles(repoRoot, checked.verified.changedFiles)) ?? null,
        stableHead: checked.verified.stableHead,
      }
      : { ok: false, reason: checked.reason },
    sourceJobValid,
    blockingJobIds,
    evidenceDigest,
    approvalTargetDiffHash: externalCompletionApprovalDiffHash(evidenceDigest),
  }
}
