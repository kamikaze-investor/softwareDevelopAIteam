// OperatorRequest型定義
//
// 外部（ChatGPT MCP / Mobile Operator Chat）から PL への自然言語の依頼 1 件を表す。
// **共通 Operator Interface の唯一の記録**であり、MCP 用・Mobile 用に別の型を作らない。
//
// ## これは「命令」ではない
//
// `message` は **untrusted input** である。保存するだけで、Task description / resume instruction /
// implementation prompt / aiCliPrompt へは決して流さない。作成しても AIteamOS の operational state
// （Task / Job / Approval / Design Review 等）は一切変わらない。
// PL はこれを「依頼の目的・調査対象」を知るための untrusted intent として読み、状態を調べて
// `response` を返す。依頼が操作を求めていて、対象が自律ループの選択条件を満たすときだけ、
// **自律ループと同じ判断経路**（Triage → 診断 → `authorizePlAction()` → 既存 executor）を
// その対象に対して1回走らせる。依頼本文はその判断経路にも Gate の根拠にも入らない。

/**
 * 依頼の処理状態。
 * - pending … PL がまだ処理していない
 * - answered … PL が response を保存した（`disposition` を参照）
 * - failed … PL の処理が失敗した（provider 障害等。`error` を参照）
 */
export type OperatorRequestStatus = 'pending' | 'answered' | 'failed'

/**
 * PL の回答の種類。
 * - answered … 状態を調べて答えた（操作はしていない）
 * - acted … 既存の PL action を既存 Gate の許可の下で実行した（`plAction` を参照）
 * - escalated … CEO 判断が要るため既存の escalation 経路（通知）へ回した
 * - declined … 現在の PL 権限・既存 Gate では実行できない要求なので、実行せず理由を返した
 */
export type OperatorRequestDisposition = 'answered' | 'acted' | 'escalated' | 'declined'

/**
 * 依頼を受けて PL が自律ループの判断経路を走らせた結果。**システムが記録した事実**であり、
 * PL の回答文とは別物（回答文が「実行した」と書いても、ここが正）。
 */
export interface OperatorRequestPlAction {
  /** 対象にした attention（`<kind>:<subject>`）。 */
  targetKey: string
  /** 判断経路を実際に走らせたか。false なら対象が選択条件を満たさず、何もしていない。 */
  attempted: boolean
  /** 走らせた場合は PL tick の status（acted / blocked / escalated / diagnosis_* / idle）。 */
  status: string
  proposedKind?: string
  reason?: string
  verification?: string
  executionSummary?: string
}

/**
 * 依頼を作った credential の種別。**caller の自己申告ではなく**認証結果から決める。
 * `apps/api/src/auth/credentialClass.ts` の `CredentialClass` のうち、この route に到達できるもの。
 * 認証を行わない構成（ローカル開発）では `unauthenticated`。
 */
export type OperatorRequestRequesterClass = 'operator_gateway' | 'admin' | 'legacy' | 'unauthenticated'

export interface OperatorRequest {
  id: string
  requesterClass: OperatorRequestRequesterClass
  /** 依頼本文（untrusted）。 */
  message: string
  /** 対象の絞り込み（任意）。存在確認だけ行い、それ以上の意味は持たせない。 */
  projectId?: string
  taskId?: string
  status: OperatorRequestStatus
  disposition?: OperatorRequestDisposition
  /** PL の回答。 */
  response?: string
  /** PL が判断経路を走らせた結果（走らせていなければ無い）。 */
  plAction?: OperatorRequestPlAction
  error?: string
  createdAt: string
  answeredAt?: string
}

/** 依頼本文の上限。長大な入力で PL の診断枠を焼かせない。 */
export const OPERATOR_REQUEST_MESSAGE_MAX_LENGTH = 2000

/**
 * 同時に pending でいられる依頼の上限（全体）。超えたら新規作成を拒否する。
 * PL は 1 tick に 1 件しか処理しないため、無制限に積ませない（コストと通知の flood 防止）。
 */
export const OPERATOR_REQUEST_MAX_PENDING = 5
