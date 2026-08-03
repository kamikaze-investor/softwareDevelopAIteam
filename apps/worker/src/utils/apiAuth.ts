/**
 * API Auth Headers — Worker → 本体API 認証ヘッダーの単一生成点
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * Worker から本体API へ行う全ての呼び出しは、このファイルの
 * `buildApiAuthHeaders()` だけで Authorization ヘッダーを生成する。
 * 生成処理を各所へ複製すると、片方だけ認証が漏れた経路（実測: 権限グラント取得・
 * Gate check・Gate consume の3経路が無認証だった。2026-08-01）が再発するため。
 *
 * API 側の契約（`apps/api/src/auth/apiToken.ts`）:
 *   - `API_TOKEN` 未設定  → 認証スキップ（既存のローカル開発モード）
 *   - `API_TOKEN` 設定済み → `Authorization: Bearer <token>` 必須。不一致・欠落は 401
 * この関数はその契約とそのまま対応させる（未設定なら空 object を返す）。
 *
 * 【重要】token をログ・エラーメッセージ・例外へ含めてはならない。
 * この関数は値を返すだけで、一切ログ出力しない。呼び出し側も、
 * fetch の options や headers をまとめてログしないこと。
 */

/**
 * 本体API 呼び出し用の Authorization ヘッダーを構築する。
 *
 * `API_TOKEN` はモジュール読み込み時ではなく呼び出しごとに読む
 * （テストでの差し替えを可能にし、起動順序への依存を作らないため）。
 */
export function buildApiAuthHeaders(): Record<string, string> {
  const token = process.env.API_TOKEN
  if (!token) return {}
  return { authorization: `Bearer ${token}` }
}
