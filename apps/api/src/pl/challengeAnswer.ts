/**
 * **PL Challenge が「どの CONFLICT に、どの run で答えたか」の durable な結び付き**（lifecycle repair C2 / C-05）。
 *
 * Challenge（CEO 指示 2026-09-18）は、CONFLICT を受けた同一の frozen spec に対する **1回きりの**
 * fresh formal re-evaluation である。その run の判定は元の CONFLICT への明示的な回答として扱う
 * （Human Resume と同じ位置づけ）。それ以外の同じ設計の再 review（回収・再 adoption・rekick の
 * 繰り返し等）は回答ではなく、未解消の不一致のまま残る（spec 22 DA trigger 7）。
 *
 * 結び付きは既存の Remediation audit 行（`stage=challenge ... outcome=starting`）に
 * `orig_run=<CONFLICT run>` と `run=<Challenge run>` を載せるだけで表す。新しい table / column は作らない。
 *
 * このモジュールは storage（evidence policy の読み手）からも読まれるので、**実行時依存を持たない**。
 */

/** audit_log の語彙（`remediationStep.ts` はここから読む。値を複製しない）。 */
export const REMEDIATION_AUDIT_ENTITY_TYPE = 'pl_remediation'
export const REMEDIATION_AUDIT_OPERATION = 'pl_independent_remediation'

export function remediationAuditKey(taskId: string): string {
  return `remediate:${taskId}`
}

/** Challenge 開始行に載せる結び付きのトークン。 */
export function challengeRunBindingTokens(conflictRunId: string, challengeRunId: string): string {
  return `orig_run=${conflictRunId} run=${challengeRunId}`
}

/**
 * この audit 行が「`conflictRunId` の CONFLICT に `challengeRunId` の run で答えた Challenge の開始」か。
 * トークンは空白区切りで完全一致させる（`run=` が `orig_run=` の部分に当たらないように）。
 */
export function isChallengeAnswerDetail(
  detail: string | undefined,
  conflictRunId: string,
  challengeRunId: string,
): boolean {
  const tokens = (detail ?? '').split(' ')
  return tokens.includes('stage=challenge')
    && tokens.includes('outcome=starting')
    && tokens.includes(`orig_run=${conflictRunId}`)
    && tokens.includes(`run=${challengeRunId}`)
}
