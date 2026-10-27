// Types for codeowners.mjs. They live next to it, not in packages/shared, on purpose: the Code Owner
// Approval workflow runs codeowners.mjs dependency-free from the default branch (sparse checkout of
// .github/scripts only), and this directory is CODEOWNERS-protected so the checker cannot be weakened
// through a non-owned dependency.
export interface CodeownersRule {
  pattern: string
  owners: string[]
}
export interface ChangedFile {
  filename: string
  previous_filename?: string
}
export interface Review {
  id: number
  user: { login: string } | null
  state: string
  commit_id: string | null
}
export function parseCodeownersRules(codeowners: string): CodeownersRule[]
export function parseCodeownersPatterns(codeowners: string): string[]
export function matchesCodeownersPattern(file: string, pattern: string): boolean
export function ownersFor(file: string, rules: readonly CodeownersRule[]): string[]
export function evaluateCodeOwnerApproval(input: {
  files: readonly ChangedFile[]
  rules: readonly CodeownersRule[]
  reviews: readonly Review[]
  headSha: string
}): { state: 'success' | 'pending' | 'failure'; description: string; waiting: string[]; unverifiable: string[] }
