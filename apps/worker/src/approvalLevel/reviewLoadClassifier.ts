import type { ReviewLoadClassification } from '@ai-team/shared'
import { ALWAYS_FORBIDDEN_PATTERNS } from '../guards/fileChangeGuard.js'

export interface ReviewLoadClassifierInput {
  changedFiles: string[]
}

interface RuleMatch {
  file: string
  rule: string
}

const CRITICAL_EXACT_PATHS = new Set([
  'specs/00_constitution.md',
  'docs/project_memory/goal.md',
  'docs/project_memory/design_philosophy.md',
  'claude.md',
  '.github/codeowners',
])

const HIGH_EXACT_PATHS = new Set([
  'apps/api/src/routes/approvalgate.ts',
  'docs/multi_ai_step_review_flow.md',
  'tasks/roadmap.md',
  'pnpm-workspace.yaml',
])

const HIGH_MARKDOWN_EXACT_PATHS = new Set([
  'docs/multi_ai_step_review_flow.md',
  'tasks/roadmap.md',
])

const CRITICAL_MARKDOWN_EXACT_PATHS = new Set([
  'specs/00_constitution.md',
  'docs/project_memory/goal.md',
  'docs/project_memory/design_philosophy.md',
  'claude.md',
])

export function classifyReviewLoad(input: ReviewLoadClassifierInput): ReviewLoadClassification {
  const changedFiles = normalizeChangedFiles(input.changedFiles)

  if (changedFiles.length === 0) {
    return {
      reviewLoad: 'medium',
      reasons: ['changedFiles is empty; defaulted to medium'],
    }
  }

  const criticalMatches = changedFiles.flatMap(matchCriticalRules)
  if (criticalMatches.length > 0) {
    return {
      reviewLoad: 'critical',
      reasons: formatMatches(criticalMatches),
    }
  }

  const highMatches = changedFiles.flatMap(matchHighRules)
  if (highMatches.length > 0) {
    return {
      reviewLoad: 'high',
      reasons: formatMatches(highMatches),
    }
  }

  if (changedFiles.every(isLowLoadFile)) {
    return {
      reviewLoad: 'low',
      reasons: changedFiles.map((file) => `${file}: low-load test or non-policy markdown`),
    }
  }

  return {
    reviewLoad: 'medium',
    reasons: changedFiles.map((file) => `${file}: default medium review load`),
  }
}

function normalizeChangedFiles(changedFiles: readonly string[]): string[] {
  return changedFiles
    .map(normalizePath)
    .filter((file) => file.length > 0)
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function matchCriticalRules(file: string): RuleMatch[] {
  const lower = file.toLowerCase()
  const matches: RuleMatch[] = []

  if (ALWAYS_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))) {
    matches.push({ file, rule: 'ALWAYS_FORBIDDEN_PATTERNS' })
  }

  if (CRITICAL_EXACT_PATHS.has(lower)) {
    matches.push({ file, rule: 'critical exact protected policy path' })
  }

  if (lower.startsWith('apps/worker/src/metareviewer/')) {
    matches.push({ file, rule: 'Meta Reviewer self-change' })
  }

  return matches
}

function matchHighRules(file: string): RuleMatch[] {
  const lower = file.toLowerCase()
  const matches: RuleMatch[] = []

  if (lower.startsWith('apps/api/src/storage/')) {
    matches.push({ file, rule: 'apps/api/src/storage DB/schema change' })
  }

  if (/^apps\/[^/]+\/scripts\/db/i.test(file)) {
    matches.push({ file, rule: 'apps/*/scripts/db* backup/restore change' })
  }

  if (/^apps\/[^/]+\/src\/auth\//i.test(file) || /(^|\/)(apitoken|apiauth)\.ts$/i.test(file)) {
    matches.push({ file, rule: 'auth/token file change' })
  }

  if (HIGH_EXACT_PATHS.has(lower)) {
    matches.push({ file, rule: 'high exact policy/workflow path' })
  }

  if (lower.includes('approvalrequests') || lower.includes('approval-requests') || lower.includes('approval_requests')) {
    matches.push({ file, rule: 'approvalRequests related file' })
  }

  if (/(^|\/)jobstatemanager\.ts$/i.test(file)) {
    matches.push({ file, rule: 'jobStateManager workflow/state transition change' })
  }

  if (/^specs\/.+\.md$/i.test(file)) {
    matches.push({ file, rule: 'specs markdown architecture decision' })
  }

  if (lower.startsWith('docs/project_memory/rules/')) {
    matches.push({ file, rule: 'project memory rule/policy document' })
  }

  if (/(^|\/)package\.json$/i.test(file)) {
    matches.push({ file, rule: 'package.json dependency/build setting' })
  }

  return matches
}

function isLowLoadFile(file: string): boolean {
  return /\.test\.ts$/i.test(file) || isLowLoadMarkdown(file)
}

function isLowLoadMarkdown(file: string): boolean {
  const lower = file.toLowerCase()
  if (!lower.endsWith('.md')) {
    return false
  }

  if (CRITICAL_MARKDOWN_EXACT_PATHS.has(lower) || HIGH_MARKDOWN_EXACT_PATHS.has(lower)) {
    return false
  }

  if (lower.startsWith('specs/') || lower.startsWith('docs/project_memory/rules/')) {
    return false
  }

  return true
}

function formatMatches(matches: readonly RuleMatch[]): string[] {
  return matches.map((match) => `${match.file}: ${match.rule}`)
}

/**
 * Whole-Roadmap review is always the highest-stakes review category that exists in this pipeline —
 * it can affect the entire task plan for the whole project — so it always uses the same load tier
 * as changedFiles-classified 'critical' Task reviews: independent (2nd-provider) review required.
 * This is a fixed constant, not a classifier, because reviewKind='roadmap' has no changedFiles to
 * classify.
 */
export const ROADMAP_REVIEW_LOAD_CLASSIFICATION: ReviewLoadClassification = {
  reviewLoad: 'critical',
  reasons: ["reviewKind='roadmap': whole-roadmap review is always critical load by design"],
}
