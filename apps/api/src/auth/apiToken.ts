import type { FastifyReply, FastifyRequest } from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isWorkerRouteAllowed } from './workerAllowlist'
import { setCredentialClass } from './credentialClass.js'
import { isActionsReadonlyRouteAllowed } from './actionsReadonlyAllowlist'
import { isHumanOnlyRoute } from './humanOnlyRoutes'

const BEARER_PREFIX = 'Bearer '

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex')
}

/** 長さが異なる場合はtimingSafeEqualが例外を投げるため、事前に長さを揃えてから比較する。 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Authorization: Bearer <token> を検証する。
 *
 * auth modeは`ADMIN_TOKEN_SHA256`/`WORKER_TOKEN_SHA256`の設定状態だけで決まる
 * （both-or-neither invariant）:
 *
 * - **両方とも未設定** → legacy mode。既存の`API_TOKEN`単一credential方式（全route許可）。
 *   `API_TOKEN`自体も未設定なら認証を行わない（ローカル開発）
 * - **両方とも設定** → split credential mode。ADMINは全route許可、WORKERはmethod +
 *   route pattern（`req.routeOptions.url`）のallowlist（`./workerAllowlist`）のみ許可し
 *   allowlist外はDefault Deny（403）。平文tokenはVPS上に保存しない設計を前提とし、API側は
 *   SHA-256ハッシュのみを保持する
 * - **片方だけ設定** → invalid configuration。設定ミスとして全requestを503で拒否する
 *   （fail closed。片側credentialだけ有効な中途半端な状態でProductionを動かさない）
 *
 * split credential modeでは、任意で第3のcredential class `ACTIONS_READONLY`を
 * （`ACTIONS_READONLY_TOKEN_SHA256`）追加できる。GitHub Actionsがtrusted resulting_commitを
 * 機械検証するためだけのread-only credentialで、`./actionsReadonlyAllowlist`のGET routeのみ
 * 許可しそれ以外はDefault Deny（403）。未設定ならこのcredential classは存在しない扱いで、
 * ADMIN/WORKERの挙動は一切変わらない。ADMIN/WORKERへのfallbackも行わない。
 *
 * split credential modeでは旧`API_TOKEN`は（値がenvに残っていても）認証に使えない。
 * legacyとsplitの共存・段階的移行は成立しないため、Production cutoverは計画停止を伴う。
 */
export async function apiTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // 空文字は「未設定」として扱う（`ADMIN_TOKEN_SHA256=`のような設定漏れで、
  // どのtokenとも一致しないcredentialが有効扱いになるのを防ぐ）。
  const adminTokenHash = process.env.ADMIN_TOKEN_SHA256 || undefined
  const workerTokenHash = process.env.WORKER_TOKEN_SHA256 || undefined
  const actionsTokenHash = process.env.ACTIONS_READONLY_TOKEN_SHA256 || undefined

  if (adminTokenHash === undefined && workerTokenHash === undefined) {
    await legacySingleTokenAuth(req, reply)
    return
  }

  // both-or-neither invariant: 片方だけ設定された状態は設定ミスとして扱い、
  // 全requestをfail closedで拒否する（片側credentialだけ有効な中途半端な状態で
  // Productionを動かさない）。
  if (adminTokenHash === undefined || workerTokenHash === undefined) {
    reply.status(503).send({
      error: 'Server auth configuration is invalid: ADMIN_TOKEN_SHA256 and WORKER_TOKEN_SHA256 must both be set, or both be unset',
    })
    return
  }

  // 同一hashが設定された場合、WORKER tokenがADMIN判定にも一致してしまいauthority
  // separationが無効化される。設定ミスとしてfail closedで拒否する。
  if (timingSafeStringEqual(adminTokenHash, workerTokenHash)) {
    reply.status(503).send({
      error: 'Server auth configuration is invalid: ADMIN_TOKEN_SHA256 and WORKER_TOKEN_SHA256 must not be the same value',
    })
    return
  }

  // ACTIONS_READONLYが設定されている場合、ADMIN/WORKERのいずれとも異なる値でなければ
  // authority separationが無効化される。設定ミスとしてfail closedで拒否する。
  if (
    actionsTokenHash !== undefined &&
    (timingSafeStringEqual(actionsTokenHash, adminTokenHash) ||
      timingSafeStringEqual(actionsTokenHash, workerTokenHash))
  ) {
    reply.status(503).send({
      error: 'Server auth configuration is invalid: ACTIONS_READONLY_TOKEN_SHA256 must differ from ADMIN_TOKEN_SHA256 and WORKER_TOKEN_SHA256',
    })
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: 'Authorization header required' })
    return
  }

  const tokenHash = sha256Hex(authHeader.slice(BEARER_PREFIX.length).trim())

  if (timingSafeStringEqual(tokenHash, adminTokenHash)) {
    setCredentialClass(req, 'admin')
    return
  }

  if (timingSafeStringEqual(tokenHash, workerTokenHash)) {
    if (isWorkerRouteAllowed(req.routeOptions.method, req.routeOptions.url)) {
      setCredentialClass(req, 'worker')
      return
    }
    reply.status(403).send({ error: 'Forbidden: route not allowed for WORKER credential' })
    return
  }

  // ACTIONS_READONLY: GETのexact verification routeのみ。ADMIN/WORKERへはfallbackしない。
  if (actionsTokenHash !== undefined && timingSafeStringEqual(tokenHash, actionsTokenHash)) {
    if (isActionsReadonlyRouteAllowed(req.routeOptions.method, req.routeOptions.url)) {
      setCredentialClass(req, 'actions_readonly')
      return
    }
    reply.status(403).send({ error: 'Forbidden: route not allowed for ACTIONS_READONLY credential' })
    return
  }

  reply.status(401).send({ error: 'Invalid token' })
}

/**
 * ADMIN/WORKERいずれも未設定のときの挙動。
 *
 * **既存の legacy 認証そのものは変えていない。** 足したのは最後の1点だけで、
 * `HUMAN_ONLY_ROUTES` に載る route を **legacy mode では fail-closed にする**。
 * この mode は単一 `API_TOKEN` を全 route へ許すため、caller が人か Worker かを
 * 区別する材料が無い（`./humanOnlyRoutes` の解説を参照）。
 *
 * **`API_TOKEN` 未設定（= 認証を一切行わない構成）でも human-only route は通さない。**
 * 一度はここを素通しにしたが、それは自分の論拠と逆だった —— legacy mode を塞ぐ理由が
 * 「人か自動かを区別できない」ことなら、**認証が無い構成では主体がそもそも分からない**ので、
 * より強く塞がる側である。弱い方を拒否して強い方を通すのは筋が通らない
 * （独立レビュー round 4・blocking 指摘）。
 *
 * これは机上の話ではない。ローカル開発環境は **AI agent（OpenCode / Codex）が
 * localhost の API へ HTTP で到達できる場所そのもの**であり、CEO 決定（2026-09-18）が
 * 「AI/PL の自律呼び出しには適用しない」と定めた相手が実際に居る。
 *
 * 結果として規則は1本になる: **human-only route は split credential mode の ADMIN でのみ通る。**
 */
async function legacySingleTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expectedToken = process.env.API_TOKEN
  if (!expectedToken) {
    // 認証を行わない構成。route の存在を隠す相手も居ない（API 全体が開いている）ので、
    // ここは token 検証を待たずに即 403 でよい。
    if (isHumanOnlyRoute(req.routeOptions.method, req.routeOptions.url)) {
      rejectHumanOnlyRoute(reply)
    }
    return
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: 'Authorization header required' })
    return
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim()
  if (token !== expectedToken) {
    reply.status(401).send({ error: 'Invalid token' })
    return
  }

  // token は正しい。ただし legacy mode では人も Worker も**同じ token** を使うため、
  // ここで判るのは「legacy 構成で認証された」ことだけである。human とは扱わない
  // （`./credentialClass` と `resumeActorClassFor()` を参照）。
  setCredentialClass(req, 'legacy')

  // **token は正しい。それでも human-only route は legacy mode では通さない。**
  // 判定を token 検証の**後**に置くのは、無効な token に 403 を返して
  // 「route は在るが権限が無い」と誤って教えないためである。
  if (isHumanOnlyRoute(req.routeOptions.method, req.routeOptions.url)) {
    rejectHumanOnlyRoute(reply)
  }
}

/**
 * human-only route を「この構成では実行できない」として断る。
 *
 * 401（token が違う）ではなく 403 である。**構成の問題**であって credential の問題ではない、
 * と呼び出し側へ伝えるためで、文面もその直し方（split credential mode）を名指しする。
 */
function rejectHumanOnlyRoute(reply: FastifyReply): void {
  reply.status(403).send({
    error:
      'Forbidden: this operation is restricted to an authenticated human (CEO), and the current '
      + 'auth configuration cannot distinguish a human caller from automation. '
      + 'Configure ADMIN_TOKEN_SHA256 / WORKER_TOKEN_SHA256 (split credential mode) and retry '
      + 'with the ADMIN credential',
    code: 'HUMAN_ONLY_ROUTE_REQUIRES_SPLIT_CREDENTIALS',
  })
}
