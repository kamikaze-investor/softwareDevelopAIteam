/**
 * File Change Guard
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 役割: AIが変更したファイルがリポジトリ境界を超えていないか検証する
 */

// 変更禁止ファイルパターン
// ⚠️ レビュー指摘(2026-05-28): packages/shared/ と tasks/ の漏れを修正
// AIが型定義やガードレール定義を書き換える「脱獄」を防ぐため追加
const FORBIDDEN_FILE_PATTERNS = [
  // 秘密情報
  /^\.env$/,
  /^\.env\./,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
  /service-account\.json$/,

  // Control Repository（AI編集禁止領域）
  /^apps\/api\//,
  /^apps\/worker\//,
  /^sandbox\//,
  /^docker-compose\.prod\.yml$/,

  // ガードレール・型定義（脱獄防止）
  /^packages\/shared\//,     // 共有型定義 — AIが自身の型を書き換え不可
  /^tasks\/task_graph\.md$/, // タスク管理 — 直接書き換え不可（API経由のみ）

  // CI/CD・ビルド設定
  /^\.github\//,
  /^tsconfig.*\.json$/,
  /^pnpm-workspace\.yaml$/,

  // 憲法・ルール
  /^CLAUDE\.md$/,
  /^specs\//,
  /^docs\/project_memory\/rules\//,
]

export interface FileGuardResult {
  allowed: boolean
  violations: string[]
}

export function fileChangeGuard(changedFiles: string[]): FileGuardResult {
  const violations: string[] = []

  for (const file of changedFiles) {
    for (const pattern of FORBIDDEN_FILE_PATTERNS) {
      if (pattern.test(file)) {
        violations.push(file)
        break
      }
    }
  }

  return {
    allowed: violations.length === 0,
    violations,
  }
}
