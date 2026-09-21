/**
 * **人（CEO）だけが呼んでよい route**（legacy mode では fail-closed）。
 *
 * `workerAllowlist.ts` / `actionsReadonlyAllowlist.ts` と同じ形の表であり、
 * **新しい credential class も新しい auth subsystem も作っていない。**
 *
 * ## なぜ必要か
 *
 * split credential mode では、ADMIN は全 route、WORKER は allowlist（Default Deny）なので、
 * 「WORKER allowlist に載せない」だけで Human-only 境界が成立する。
 *
 * **裏を返すと、境界が成立するのは split credential mode だけである。** そこで規則は1本になる:
 * ここに載る route は **split credential mode の ADMIN でのみ通る**。他のどの mode でも 403。
 *
 * **legacy mode では成立しない。** `ADMIN_TOKEN_SHA256` / `WORKER_TOKEN_SHA256` の両方が
 * 未設定のとき、認証は単一の `API_TOKEN` だけで行われ、**Worker も同じ値を持つ**
 * （`.env.example`: WORKER runtime の `API_TOKEN` に WORKER token 平文を入れるのは split mode の話で、
 * legacy mode では文字どおり同じ1個である）。したがって HTTP caller が人か Worker かを
 * 区別する材料が無く、allowlist も評価されない。
 *
 * CEO 決定（2026-09-18）は Human Recovery を「認証済み CEO の明示操作」に限り、
 * **AI/PL の自律呼び出しには適用しない**と定めている。区別できない以上、
 * legacy mode では**通さない**のが唯一 fail-closed な扱いである。
 *
 * ## 何を変えていないか
 *
 * - **legacy auth 全体は変えていない。** ここに載せた route だけが拒否される
 * - **認証が無効なローカル開発（`API_TOKEN` 未設定）でも拒否する。** 一度は
 *   「production の構成ではないから」と素通しにしたが、それは上の論拠と逆だった ——
 *   区別できないから塞ぐのなら、**主体がそもそも分からない構成はより強く塞がる側**である。
 *   しかもローカルは AI agent が localhost の API へ到達できる場所そのもので、
 *   CEO 決定が除外した相手が実際に居る（独立レビュー round 4・blocking 指摘）
 * - split credential mode の挙動は1ビットも変わらない（ADMIN は通り、WORKER は allowlist で 403）
 *
 * ## 増やすときの注意
 *
 * ここへ足すのは「**人の判断そのものが操作の authorization である**」route だけにすること。
 * 「危険だから」ではない —— 危険な操作は Gate と Approval が担当する。
 */

export interface HumanOnlyRouteEntry {
  method: string
  url: string
}

export const HUMAN_ONLY_ROUTES: readonly HumanOnlyRouteEntry[] = [
  // Human Recovery。Job 0 件の blocked Task を既存ループへ再投入する。
  // up-front の Approval Gate を課さない代わりに、**呼び出し主体が人であること**が
  // authorization の実体なので、主体を区別できない構成では実行させない。
  { method: 'POST', url: '/api/tasks/:id/recover' },
]

/**
 * その route が「人だけが呼んでよい」ものか。
 *
 * 照合は Fastify の route pattern（`req.routeOptions.url`）と完全一致で行う
 * （`workerAllowlist.ts` と同じ規約。実 URL とは照合しない）。
 */
export function isHumanOnlyRoute(method: string | undefined, url: string | undefined): boolean {
  if (!method || !url) return false
  return HUMAN_ONLY_ROUTES.some((entry) => entry.method === method && entry.url === url)
}
