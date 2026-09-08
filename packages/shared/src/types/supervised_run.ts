/**
 * Supervised Run — background task supervision の共通run state（Contract C-10）
 *
 * 対象は「workflow progressionをblockし得るすべての asynchronous / background /
 * external-wait operation」であり、個別task種別の列挙ではない。`kind` はその
 * operationがどのcompletion predicateを使うかを引くキーにすぎない。
 *
 * この型が支えるcontract要求（`tasks/roadmap.md` roadmap:id=pl-review-process-supervision）:
 *   - durable run/state          … process再起動をまたいで残る
 *   - observable progress        … lastProgressAt / currentStage / progressEvidence
 *   - completion predicate       … predicateKey + predicateVersion（判定ロジックはDBに置かない）
 *   - terminal verdict           … 無期限RUNNING禁止
 *   - bounded recovery           … recoveryAttemptCount
 *   - session/Mobile非依存       … supervisor が誰かをrowが持つ
 */

/**
 * supervised runの種別。**新しい値の追加がschema変更を要求しない**よう、DB上はTEXTで持つ。
 *
 * Step 2（基盤）で受理するのは下記2種のみ（rollout順序であって、contractのscopeではない）。
 * `deploy` / `build` / `external_ci` はcontract上すでに対象だが、
 * supervised_runsへの配線が済むまでlegacy exceptionとして扱う。
 */
export const SUPERVISED_RUN_KINDS = ['ai_delegation', 'expo_restart'] as const

export type SupervisedRunKind = (typeof SUPERVISED_RUN_KINDS)[number]

export function isSupervisedRunKind(value: string): value is SupervisedRunKind {
  return (SUPERVISED_RUN_KINDS as readonly string[]).includes(value)
}

/**
 * run status。
 *
 * `stalled` は**終端ではない**。進捗停止を検知した状態であり、診断（C-5）と
 * bounded recovery（C-6）を経て、`succeeded` へ回収されるか終端失敗へ倒れる。
 * 「completion predicateは満たしているがwrapperだけ終わらない」ケース（C-12）は、
 * `stalled` から `succeeded` へ回収される経路で扱う。
 */
export const SUPERVISED_RUN_STATUSES = ['running', 'stalled', 'succeeded', 'failed', 'timed_out'] as const

export type SupervisedRunStatus = (typeof SUPERVISED_RUN_STATUSES)[number]

/** 終端status。ここへ到達したrunは二度と動かない（C-1）。 */
export const SUPERVISED_RUN_TERMINAL_STATUSES = ['succeeded', 'failed', 'timed_out'] as const

export type SupervisedRunTerminalStatus = (typeof SUPERVISED_RUN_TERMINAL_STATUSES)[number]

export function isTerminalSupervisedRunStatus(status: SupervisedRunStatus): status is SupervisedRunTerminalStatus {
  return (SUPERVISED_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** まだ終端していない = 監視主体が見続けなければならないstatus。 */
export function isActiveSupervisedRunStatus(status: SupervisedRunStatus): boolean {
  return !isTerminalSupervisedRunStatus(status)
}
