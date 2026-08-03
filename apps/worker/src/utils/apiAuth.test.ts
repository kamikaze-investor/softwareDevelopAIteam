import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { buildApiAuthHeaders } from './apiAuth.js'

/**
 * buildApiAuthHeaders() のユニットテスト。
 *
 * P0-3 で新設した Worker→API 認証ヘッダーの単一生成点。
 * API 側（apps/api/src/auth/apiToken.ts）の契約と対応させる:
 *   API_TOKEN 未設定 → 認証スキップ（空 object）
 *   API_TOKEN 設定済 → Authorization: Bearer <token>
 */

const TOKEN_BACKUP: { value?: string } = {}

beforeEach(() => {
  TOKEN_BACKUP.value = process.env.API_TOKEN
  delete process.env.API_TOKEN
})

afterEach(() => {
  if (TOKEN_BACKUP.value === undefined) delete process.env.API_TOKEN
  else process.env.API_TOKEN = TOKEN_BACKUP.value
})

describe('buildApiAuthHeaders', () => {
  it('API_TOKEN 設定時は Bearer header を返す', () => {
    process.env.API_TOKEN = 'test-secret-token'
    expect(buildApiAuthHeaders()).toEqual({ authorization: 'Bearer test-secret-token' })
  })

  it('API_TOKEN 未設定時は空 object を返す（既存ローカル開発モード）', () => {
    expect(buildApiAuthHeaders()).toEqual({})
  })

  it('API_TOKEN が空文字列のときも空 object を返す（API 側も認証スキップになるため）', () => {
    process.env.API_TOKEN = ''
    expect(buildApiAuthHeaders()).toEqual({})
  })

  it('呼び出しごとに process.env を読む（起動順序に依存しない）', () => {
    expect(buildApiAuthHeaders()).toEqual({})
    process.env.API_TOKEN = 'later-token'
    expect(buildApiAuthHeaders()).toEqual({ authorization: 'Bearer later-token' })
  })

  it('返り値以外へ token を出さない（この関数はログ出力を持たない）', () => {
    // 実装がログ関数を一切呼ばないことをソースで確認する。
    // token が console へ渡る経路をこのファイル内に作らないための回帰防止。
    const src = readFileSync(path.resolve(__dirname, 'apiAuth.ts'), 'utf-8')
    expect(src).not.toMatch(/console\./)
  })
})

// ────────────────────────────────────────────────────────────
// 認証ヘッダー生成が重複していないこと
// ────────────────────────────────────────────────────────────

describe('Authorization header 生成の一元化', () => {
  const WORKER_SRC = path.resolve(__dirname, '..')

  const CALLERS = [
    'index.ts',
    'guards/permissionGuard.ts',
    'guards/gateClient.ts',
  ]

  it.each(CALLERS)('%s は buildApiAuthHeaders() を使い、Bearer を自前で組み立てない', (relPath) => {
    const src = readFileSync(path.join(WORKER_SRC, relPath), 'utf-8')

    expect(src).toContain('buildApiAuthHeaders')
    // 本体API 向けの Bearer 文字列を自前で構築していないこと
    // （notifier/lineAdapter.ts は外部サービス向けなので対象外）
    expect(src).not.toMatch(/Bearer \$\{[^}]*API_TOKEN[^}]*\}/)
  })
})
