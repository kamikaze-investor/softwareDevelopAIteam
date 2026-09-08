/**
 * ai_delegation の production continuation（Step 3）
 *
 * 独立レビュー指摘（Step 3 第2ラウンド #1）: `setDelegationContinuation()` に production の
 * 呼び出し元が無く、hook 未登録だと `runContinuation()` が即 return していた。
 * つまり本番では **terminal にはなるが continuation は一度も走らない**状態だった。
 * 「部品はあるが配線されていない」という、この Step でまさに指摘された欠陥の再発である。
 *
 * ここで新しい通知機構は作らない。既存 notifier（`sendAlert`）へ委ねるだけである。
 */

import { sendAlert } from '@ai-team/worker/src/notifier/notifier.js'
import { setDelegationContinuation } from './delegationSupervisor'

/**
 * API 起動時に一度だけ呼ぶ。
 *
 * continuation は **終端が durable に確定した後にだけ**呼ばれる（fencing 通過後）。
 * したがってここで通知しても、stale owner の書き込みや二重終端から発火することはない。
 */
export function registerDelegationContinuation(): void {
  setDelegationContinuation(async ({ run, terminal, terminalVerdict }) => {
    await sendAlert({
      severity: terminal === 'succeeded' ? 'info' : 'warning',
      title: `AI delegation ${terminal}: ${run.subjectId}`,
      body:
        `verdict=${terminalVerdict}\n` +
        `run=${run.id}\n` +
        `started=${run.startedAt}\n` +
        `completed=${run.completedAt ?? 'unknown'}`,
      sourceType: 'supervised_run',
      sourceId: run.id,
    })
  })
}
