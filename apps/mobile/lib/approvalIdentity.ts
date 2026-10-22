/**
 * Approval request を CEO が正確に識別するための表示文言。
 *
 * 表示する ID は、承認・却下の操作が実際に送る `ApprovalRequest.id` そのものである。
 * 別名・短縮形を作らないのは、画面で見た ID と API が受け取る ID を一致させるため。
 */

/** カードに常時表示する Approval ID の行。 */
export function approvalIdLabel(approvalId: string): string {
  return `承認ID: ${approvalId}`
}

/** 承認・却下の確認時に、どの Approval request を操作するかを示す行。 */
export function approvalTargetDescription(item: { id: string; taskId: string }): string {
  return `${approvalIdLabel(item.id)}\nTask ID: ${item.taskId}`
}

/**
 * Approval ID をそのまま書き込み、利用者へ返す完了メッセージを作る。
 * 書き込み先（Clipboard）は呼び出し側が渡す。
 */
export function copyApprovalId(approvalId: string, writeText: (text: string) => void): string {
  writeText(approvalId)
  return `${approvalIdLabel(approvalId)} をコピーしました`
}
