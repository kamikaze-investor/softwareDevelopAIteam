/**
 * ai_delegation の production continuation（Step 3）
 *
 * 独立レビュー指摘（Step 3 第2ラウンド #1）: `setDelegationContinuation()` に production の
 * 呼び出し元が無く、hook 未登録だと `runContinuation()` が即 return していた。
 * つまり本番では **terminal にはなるが continuation は一度も走らない**状態だった。
 *
 * 独立レビュー指摘（第3ラウンド）: ここから `@ai-team/worker/src/notifier/notifier.js` を
 * 直接 import すると、既知の packaging gap（`node dist/index.js` では resolve できない。
 * `tasks/roadmap.md` の「正式Production起動方式の確定」参照）への cross-package 依存が
 * **新規コードで1つ増える**。現行 production は `tsx src/index.ts` なので今すぐ壊れはしないが、
 * gap への依存は増やさない方針とした（CEO判断 2026-09-09）。
 *
 * そのため通知の実体は **呼び出し元から注入**する。このファイルは worker package を import しない。
 * 既存3箇所の同種 import は本 PR の対象外（別件の packaging gap 側で扱う）。
 */

import { setDelegationContinuation } from './delegationSupervisor'

/**
 * 通知の最小契約。worker 側 `sendAlert` の構造的部分集合であり、型としても依存しない。
 * 返り値は使わないので `unknown` で受ける。
 */
export type AlertSender = (payload: {
  severity: 'info' | 'warning' | 'critical'
  title: string
  body: string
  sourceType?: string
  sourceId?: string
}) => Promise<unknown>

/**
 * API 起動時に一度だけ呼ぶ。
 *
 * continuation は **終端が durable に確定した後にだけ**呼ばれる（fencing 通過後）。
 * したがってここで通知しても、stale owner の書き込みや二重終端から発火することはない。
 */
export function registerDelegationContinuation(sendAlert: AlertSender): void {
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
