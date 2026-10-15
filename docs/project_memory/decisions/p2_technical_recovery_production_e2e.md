# P2 Technical Recovery — Production E2E record (Task b6d4097a)

Production record of Priority 2 (specs/22 §14-3) technical recovery on real data. Task `b6d4097a`
(`task-codex-review-cannot-read-repo#2`), Candidate base `9f42df1`. Times are UTC.

## Timeline

| When | Event | Result |
|---|---|---|
| 2026-10-02 12:57 | PL adopted the item; implement `a84144a4` succeeded | — |
| 10-02 13:02 | Review `398294a6` refused by the prompt secret scan (test fixture shaped like a password assignment) | blocked; CEO escalation; **~4.5 days ADMIN wait** |
| 10-07 02:04 | Human Resume (after #324) → review refused | `repairEligible=false`: the match sat in the implementer's own stdout report, outside the diff |
| 10-08 04:32 | Human Resume (after #326) → review `e92bce06` refused | `repairEligible=false`: the stored stdout preview was cut at 4000 chars inside the AI CLI section |
| 10-08 11:56 | Human Resume (after #334) → review `10130366` refused | **`repairEligible=true` (`implementation_report_generic_assignment`) → existing repair flow admitted `9c5d22e9` (`repair:a84144a4:1`)** — first Production pass of the gap ② path |
| 10-08 11:59 | Repair succeeded; its review `517d0af7` | `changes_requested` (real defect: the secret-file basename check is not applied to the realpath, so a symlink to `.env` would be read) |
| 10-08 12:00 | Follow-on repair skipped: "repair successor is not inside a human-authorized generation" | PL escalated to the CEO (unknown). Fixed by #336 (refusal-recovery generation provenance) |
| 10-09 02:16 | Human Resume (after #336) → review `9dfffc41` of the **same diff** | **`approved`** — the symlink finding was downgraded to a non-blocker |
| 10-09 02:17 | git_commit `70b32fc9` → approval `approval-20261009-3e51fae9` | WAITING_FOR_USER. The defect is verified still present (`reviewerAdapter.ts:199` checks only `path.basename(file)`) |

## What the run proved

- gap ② (#324/#326/#334): an implementation-owned secret-scan refusal of a review now reaches the existing repair
  flow, with value-free metadata and the secret scan unchanged.
- Task Contract (#320): the implementer stayed inside `apps/worker/src/approvalLevel` in both attempts.
- Repair budget: depth 1 of `MAX_REPAIR_ATTEMPTS=3` used; no reset.

## What the run exposed

1. **Technical Admin wait**: each of the four resumes needed a CEO ADMIN operation. The case also motivated
   P2-1 (#329/#330, PL technical resume) and P2-2 (#333, technical abort/park). Jobs created before #333 have no
   end fingerprint, so P2-2 cannot clean up this Task.
2. **Review verdict instability defeats a negative verdict**: re-running a review whose previous run returned a
   blocking `changes_requested` (with no repair in between) produced `approved` for the identical diff. A Human
   Resume of a failed review therefore acts as a re-roll. Owner: `independent-review-verdict-instability`
   (planned). Under the Decision Authority Principle, a later re-review of the same diff that contradicts an
   earlier blocking finding is an unresolved review conflict (DA trigger 7) and should fail closed instead of
   passing.
3. Each gap found here was fixed in the existing mechanism with an independent review: #324, #326, #334, #336.

## Status at the time of writing

The git_commit approval is waiting for the CEO. Recommendation recorded: do not approve (the defect is present).

## Releasing the Project after a CEO REJECT (manual abort, restorable backup)

A REJECTED git_commit leaves its Job `blocked`. The PL never auto-resumes a CEO rejection, and before this
change the ADMIN abort refused a Task with a non-terminal Job, so the Task held the only running Project. The
manual abort now accepts exactly this shape (latest Job = blocked git_commit whose **own** linked approval is
REJECTED, same Task/Project, Candidate HEAD = the approval's target commit). Everything else is unchanged: the
`abort_task` approval must be APPROVED and is consumed, the Worker only observes, and the final transaction
re-checks every fact. REJECT alone never parks anything.

The Worker does not delete files on this path, so the operator backs up and cleans the Candidate. The backup
must be shown to **restore**, not only to exist, before anything is cleaned:

1. Read-only checks: no live Job; Candidate HEAD equals the rejected approval's target commit; the changed
   file list matches the approval's diff; no merge/rebase/lock state.
2. Snapshot: copy the whole Candidate (working tree and `.git`) to a backup directory outside every workspace.
   The original Candidate is not written to.
3. In the snapshot, record the full working state as a tree with a temporary index
   (`GIT_INDEX_FILE=<tmp> git read-tree HEAD; GIT_INDEX_FILE=<tmp> git add -A; GIT_INDEX_FILE=<tmp> git write-tree`)
   and write `git diff --binary HEAD <tree>` as the patch (it includes untracked files).
4. Restore proof: clone the snapshot at the same HEAD into a fresh directory, `git apply --binary` the patch,
   compute the tree the same way, and require it to equal the tree from step 3. Stop on any mismatch.
5. Only then clean the Candidate (`git checkout -- .` and `git clean -fd`, never `-x`), and confirm a clean
   status at the unchanged HEAD.
6. Run the existing ADMIN abort (create `abort_task` approval, approve, `POST /abort`). The Worker's clean
   observation and `knownGood` let the API fail the Job, park the Task and consume the approval atomically.

The snapshot, patch and tree hash are kept; the roadmap item stays `planned`.
