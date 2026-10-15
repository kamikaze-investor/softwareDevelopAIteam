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
//
// `kind` は **caller が明示する**（AIteamOS 内で LLM に再判定させない）:
// - question … 調べて答えるだけ。operational action は実行しない
// - request … 「可能なら PL として必要な行動まで」という意思表示。**それ自体は権限ではない。**
//   対象を1つ特定し、**自律ループと同じ判断経路**（Triage → 診断 → `authorizePlAction()` →
//   既存 executor → Verify）をその対象に1回走らせる。action の種類は caller も LLM 分類も決めない
//
// 本文は対象特定と文脈の理解にだけ使い、Gate の根拠・条件・prompt には入らない。

/** caller が明示する依頼の種類。 */
export type OperatorRequestKind = 'question' | 'request'

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
  kind: OperatorRequestKind
  /** 依頼本文（untrusted）。 */
  message: string
  /**
   * caller が名指しした対象 attention（`<kind>:<subject>`。任意）。**信用しない**:
   * 処理時に現在の attention と照合し、一致しなければ fail closed（別の対象を推測しない）。
   */
  targetKey?: string
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

/** targetKey の上限（形式検査用）。 */
export const OPERATOR_REQUEST_TARGET_KEY_MAX_LENGTH = 200

/** 依頼本文の上限。長大な入力で PL の診断枠を焼かせない。 */
export const OPERATOR_REQUEST_MESSAGE_MAX_LENGTH = 2000

/**
 * 同時に pending でいられる依頼の上限（**依頼元 credential ごと**）。超えたら新規作成を拒否する。
 * PL は 1 tick に 1 件しか処理しないため、無制限に積ませない（コストと通知の flood 防止）。
 * 依頼元ごとにするのは、外部 Operator が枠を埋めて Mobile（CEO）の依頼を締め出せないようにするため。
 */
export const OPERATOR_REQUEST_MAX_PENDING = 5
