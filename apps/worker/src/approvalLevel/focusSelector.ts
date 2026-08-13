import type { MetaReviewFocus, ReviewLoad } from '@ai-team/shared'

const FOCUS_PRIORITY: readonly MetaReviewFocus[] = [
  'safety_recovery',
  'architecture_responsibility',
  'data_state_integrity',
  'auth_permission',
  'operations',
  'product_ceo_experience',
  'scope_simplicity',
]

export function selectFocuses(reviewLoad: ReviewLoad, changedFiles: string[]): MetaReviewFocus[] {
  const normalizedFiles = changedFiles.map(normalizePath).filter(Boolean)

  if (reviewLoad === 'low') {
    return []
  }

  const mappedFocuses = sortFocusesByPriority(unique(normalizedFiles.flatMap(mapFileToFocuses)))
  const relatedFocuses: MetaReviewFocus[] = mappedFocuses.length > 0
    ? mappedFocuses
    : ['scope_simplicity']

  if (reviewLoad === 'medium') {
    if (hasDesignSignal(normalizedFiles)) {
      return ['strategic_alignment']
    }
    return [relatedFocuses[0]]
  }

  if (reviewLoad === 'high') {
    return withStrategicAlignment(relatedFocuses.slice(0, 2))
  }

  return withStrategicAlignment(relatedFocuses)
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function mapFileToFocuses(file: string): MetaReviewFocus[] {
  const lower = file.toLowerCase()

  if (lower.includes('/guards/') || lower.includes('guards/')) {
    return ['safety_recovery', 'auth_permission']
  }

  if (lower.startsWith('sandbox/')) {
    return ['safety_recovery', 'operations']
  }

  if (lower.startsWith('apps/api/src/routes/')) {
    return ['architecture_responsibility', 'auth_permission']
  }

  if (lower.startsWith('apps/api/src/storage/')) {
    return ['data_state_integrity']
  }

  if (lower.startsWith('apps/worker/src/')) {
    return ['architecture_responsibility']
  }

  if (lower.startsWith('packages/shared/src/types/')) {
    return ['architecture_responsibility']
  }

  if (lower.startsWith('.github/workflows/')) {
    return ['operations']
  }

  if (lower.startsWith('apps/mobile/')) {
    return ['product_ceo_experience']
  }

  return ['scope_simplicity']
}

function hasDesignSignal(files: readonly string[]): boolean {
  return files.some((file) => {
    const lower = file.toLowerCase()
    return lower.startsWith('specs/') || lower.startsWith('docs/project_memory/decisions/')
  })
}

function withStrategicAlignment(focuses: readonly MetaReviewFocus[]): MetaReviewFocus[] {
  return unique(['strategic_alignment', ...focuses])
}

function unique(focuses: readonly MetaReviewFocus[]): MetaReviewFocus[] {
  return [...new Set(focuses)]
}

function sortFocusesByPriority(focuses: readonly MetaReviewFocus[]): MetaReviewFocus[] {
  const priority = new Map<MetaReviewFocus, number>(
    FOCUS_PRIORITY.map((focus, index) => [focus, index]),
  )

  return [...focuses].sort((left, right) => {
    return (priority.get(left) ?? Number.MAX_SAFE_INTEGER) - (priority.get(right) ?? Number.MAX_SAFE_INTEGER)
  })
}
