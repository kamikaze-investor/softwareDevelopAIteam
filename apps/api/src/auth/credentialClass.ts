/**
 * 認証した credential の**種別**を request へ載せるための最小の受け皿。
 *
 * **新しい credential class も新しい auth subsystem も作っていない。**
 * `apiTokenAuth()` が許可/拒否を決めるときに既に判っている事実を、
 * route から読めるようにするだけである。
 *
 * ## なぜ要るのか
 *
 * resume は human も AI も行う正当な操作で、両方とも同じ
 * `storage.jobs.resumeBlockedTask()` に着地する。Job 行にも `workflowStepKey` にも
 * 「誰が再開したか」は残らないため、後から repair budget の generation 境界を
 * 判定する材料が無かった。route 側で credential 種別が判れば、
 * **caller の自己申告に頼らずに** human / AI を分けられる。
 *
 * ## legacy mode では `legacy` にしかならない
 *
 * `ADMIN_TOKEN_SHA256` / `WORKER_TOKEN_SHA256` が未設定の構成では、人も Worker も
 * **同じ `API_TOKEN`** を使う。区別する材料が無いので `legacy` とだけ記録し、
 * human とは扱わない（`resumeActorClassFor()`）。
 */

import type { FastifyRequest } from 'fastify'

/** 認証を通った credential の種別。`apiTokenAuth()` だけが設定する。 */
export type CredentialClass = 'admin' | 'worker' | 'actions_readonly' | 'legacy'

/** `req` へ載せるときのキー。`declare module` を足さずに済ませるための最小定義。 */
const CREDENTIAL_CLASS_KEY = '__aiTeamCredentialClass'

interface RequestWithCredentialClass {
  [CREDENTIAL_CLASS_KEY]?: CredentialClass
}

/**
 * 認証結果として credential 種別を記録する。**`apiTokenAuth()` 以外から呼ばない。**
 * body / header / query からは決して作らない（それは caller の自己申告になる）。
 */
export function setCredentialClass(req: FastifyRequest, credentialClass: CredentialClass): void {
  ;(req as unknown as RequestWithCredentialClass)[CREDENTIAL_CLASS_KEY] = credentialClass
}

/**
 * 記録された credential 種別を読む。
 *
 * **未設定なら `undefined`。** 「認証 hook を通っていない」ことを
 * 特定の種別へ倒さない（倒すとテスト経路や将来の hook 変更が権限を生む）。
 */
export function getCredentialClass(req: FastifyRequest): CredentialClass | undefined {
  return (req as unknown as RequestWithCredentialClass)[CREDENTIAL_CLASS_KEY]
}
