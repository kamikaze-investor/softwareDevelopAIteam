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
import path from 'node:path'
import type { IStorage } from '../storage/interface'

/** 呼び出し側が主張する根拠。**機械照合できるものは下で照合する。** */
export interface ExternalCompletionEvidence {
  /** 採用元 Roadmap item。Task の `roadmapTaskKey` と一致しなければ通さない。 */
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
  | { ok: true; verified: { changedFiles: readonly string[]; stableHead: string } }
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
  if (task.roadmapTaskKey !== evidence.roadmapItemId) {
    return {
      ok: false,
      reason: `roadmapItemId "${evidence.roadmapItemId}" does not match this Task's roadmapTaskKey`,
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
  let changedFiles: readonly string[]
  try {
    stableHead = git(repoRoot, ['rev-parse', 'HEAD'])
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

  return { ok: true, verified: { changedFiles, stableHead } }
}
