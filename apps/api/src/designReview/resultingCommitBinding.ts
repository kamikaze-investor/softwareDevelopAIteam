/**
 * Gate ALLOW evidence へ resulting commit を authoritative に bind する。
 *
 * Worker の `Job.commitHash` は trust source にしない。API/Control Plane 自身が
 * authoritative repository（Jobの`safeCommand.workingDir`）で次を独立検証する:
 *
 *   1. 現在の HEAD B を取得（APIが自分で `rev-parse HEAD`）
 *   2. parent(B) === gate_evaluations.targetCommit（A）
 *   3. A → B の canonical change manifest を再生成
 *   4. その hash === approved_content_hash
 *
 * 4条件すべて成立した場合だけ bind する。不一致・repo読取不能・曖昧（merge commit等）は
 * bind せず fail-closed（resulting_commit は NULL のまま）。
 *
 * MVPの原則: **1 Gate ALLOW = 1 git_commit Job = 1 resulting_commit**。
 * 1つのcommitへ複数の独立したALLOW対象を混ぜない。ALLOWした変更以外がcommitに
 * 混ざっていればmanifest不一致になり、trusted resulting_commitにはならない。
 * 複数ALLOWの統合やbinding graphは作らない。
 *
 * WorkerのcommitHashはtrust sourceにしない。candidate locatorとしても使っていない
 * （pending Outboxがある間Workerは新しいJobを取得しないため、結果到着時のHEADはBのままである）。
 *
 * 新しい framework は作らない。git primitive と既存 Gate evidence の再利用だけで構成する。
 */

import { computeChangeManifestHash } from '../approvalExplain/changeManifestIdentity'
import {
  buildCommitChangeManifest,
  readHeadCommit,
  readSingleParent,
} from '../approvalExplain/changeManifestReader'
import type { IStorage } from '../storage/interface'

export type ResultingCommitBindOutcome =
  | { bound: true; resultingCommit: string }
  | {
      bound: false
      reason:
        | 'no_eligible_evidence'
        | 'ambiguous_evidence'
        | 'repo_unreadable'
        | 'ambiguous_parent'
        | 'parent_mismatch'
        | 'content_mismatch'
        | 'already_bound'
    }

export interface BindResultingCommitInput {
  jobId: string
  workingDir: string
}

/**
 * git_commit Job の結果到着時に呼ぶ。
 *
 * bind対象は「そのJob自身のGate評価」で、`jobId`で一意に引く
 * （「同じTaskの最新ALLOW」のような曖昧な選択はしない）。
 */
export function bindResultingCommitForJob(
  storage: IStorage,
  input: BindResultingCommitInput,
  log?: { warn: (obj: unknown, msg: string) => void },
): ResultingCommitBindOutcome {
  const candidates = storage.gateEvaluations
    .findByJobId(input.jobId)
    .filter(
      (evidence) =>
        evidence.decision === 'ALLOW' &&
        evidence.bindingVerification === 'authoritative' &&
        evidence.approvedContentHash !== undefined,
    )

  if (candidates.length === 0) {
    return { bound: false, reason: 'no_eligible_evidence' }
  }
  // 1 Gate ALLOW = 1 git_commit Job = 1 resulting_commit。
  // 同一Jobに対して適格なALLOWが複数ある状態は「どのALLOWのcommitか」が決まらないため、
  // 黙って1件選ばずbindを拒否する。
  if (candidates.length > 1) {
    return { bound: false, reason: 'ambiguous_evidence' }
  }
  const evidence = candidates[0]
  if (evidence.resultingCommit !== undefined) {
    return { bound: false, reason: 'already_bound' }
  }

  let headCommit: string
  let parent: string
  let actualHash: string
  try {
    headCommit = readHeadCommit(input.workingDir)
  } catch (error: unknown) {
    log?.warn(
      { jobId: input.jobId, error: error instanceof Error ? error.message : String(error) },
      'resulting commit binding skipped: repository is not readable',
    )
    return { bound: false, reason: 'repo_unreadable' }
  }

  try {
    parent = readSingleParent(input.workingDir, headCommit)
  } catch {
    // merge commit等でparentが一意でない場合は曖昧なのでbindしない
    return { bound: false, reason: 'ambiguous_parent' }
  }

  if (parent !== evidence.targetCommit) {
    return { bound: false, reason: 'parent_mismatch' }
  }

  try {
    actualHash = computeChangeManifestHash(
      buildCommitChangeManifest(input.workingDir, evidence.targetCommit, headCommit),
    )
  } catch (error: unknown) {
    // symlink / submodule等の未対応entryもここへ来る。原因が追えるようlogへ残す
    // （bindしない点はrepo読取不能と同じだが、調査時に区別できるようにする）。
    log?.warn(
      { jobId: input.jobId, error: error instanceof Error ? error.message : String(error) },
      'commit manifest could not be built; resulting commit was not bound',
    )
    return { bound: false, reason: 'repo_unreadable' }
  }

  if (actualHash !== evidence.approvedContentHash) {
    return { bound: false, reason: 'content_mismatch' }
  }

  const bound = storage.gateEvaluations.bindResultingCommit({
    evidenceId: evidence.id,
    jobId: input.jobId,
    resultingCommit: headCommit,
  })

  return bound ? { bound: true, resultingCommit: headCommit } : { bound: false, reason: 'already_bound' }
}
