/**
 * Mobile 共通 API クライアント。
 *
 * 全ての本体API呼び出しはこのファイル経由で行う。API_BASEの決定・
 * 保存済みトークンからのAuthorizationヘッダー付与を一箇所にまとめ、
 * 各画面で同じ処理を重複実装しないようにする。
 *
 * token は端末のSecure Storage（iOS Keychain / Android Keystore）へ保存し、
 * ソースコード・ビルド設定（EXPO_PUBLIC_*はバンドルへ埋め込まれるため不可）へは含めない。
 */

import * as SecureStore from 'expo-secure-store'

declare const process: {
  env: {
    EXPO_PUBLIC_API_URL?: string
  }
}

export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'

const TOKEN_KEY = 'api_token'

/** 保存済みの API トークンを取得する。未保存の場合は null */
export async function getApiToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY)
}

/** API トークンを保存する（新規保存・変更のいずれも同じ操作） */
export async function setApiToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}

/** 保存済みの API トークンを削除する */
export async function clearApiToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}

/**
 * 本体APIへの共通fetchヘルパー。
 *
 * 保存済みトークンがあれば `Authorization: Bearer <token>` を付与する
 * （API側 `apiTokenAuth` の契約と同じく、未保存時は付与しない＝ローカル開発モード）。
 * 呼び出し側が指定した `init.headers` は維持したまま Authorization だけ追加する。
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getApiToken()
  const authHeaders: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}

  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders,
      ...(init.headers as Record<string, string> | undefined),
    },
  })
}
