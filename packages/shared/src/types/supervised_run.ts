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

/**
 * 「進捗が無い」と判定してよいまでの無出力許容時間（C-4）。**kind ごとに異なる。**
 *
 * 一律の短いtimeoutで判定しない（C-4）: 正常な無出力時間はtaskごとに違う。
 * 実障害ケース2では、idle な Metro はログを出さないのに「ログが古い＝停止」と判定して
 * 健全なサービスを停止扱いにした。
 *
 * **この値は policy であって呼び出し側の引数ではない**（独立レビュー指摘 2026-09-08 第3ラウンド）。
 * cutoff を呼び出し側から渡せると、未来時刻を渡すだけで健全に進行中の run を stalled にでき、
 * そのまま所有権を奪えてしまう。cutoff は storage 内部で
 * 「現在時刻 − この閾値」として算出する。
 */
export const SUPERVISED_RUN_STALE_THRESHOLD_MS: Record<SupervisedRunKind, number> = {
  // AI委任は思考中に無出力の時間が長い。delegate-watchdog.sh の inactivity 既定(120s)より
  // 保守的に取り、監視側が先走って所有権を奪わないようにする。
  ai_delegation: 600_000,   // 10min
  // Expo restart は ready 到達まで通常数秒〜数分。ただし ready 後の Metro は
  // client activity が無い限りログを出さないため、log ではなく external probe が
  // 進捗signalになる（C-2a）。ここは probe が一切記録されない場合の上限として使う。
  expo_restart: 300_000,    // 5min
}
