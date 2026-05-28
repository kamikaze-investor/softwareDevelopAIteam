/**
 * File Change Guard
 *
 * ⚠️ CONTROL REPOSITORY — AI編集禁止
 *
 * 役割: AIが変更したファイルがリポジトリ境界を超えていないか検証する
 */

// 変更禁止ファイルパターン
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env$/,
  /^\.env\./,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
  /service-account\.json$/,
  /docker-compose\.prod\.yml$/,
  /^apps\/api\//,      // Control Repository
  /^apps\/worker\//,   // Control Repository
  /^sandbox\//,        // Control Repository
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
