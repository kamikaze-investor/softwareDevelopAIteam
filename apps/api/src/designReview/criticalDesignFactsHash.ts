import { createHash } from 'node:crypto'
import { canonicalizeCriticalDesignFacts } from '@ai-team/shared'
import type { CriticalDesignFact } from '@ai-team/shared'

export function computeCriticalDesignFactsHash(
  facts: readonly CriticalDesignFact[],
): string {
  const canonical = canonicalizeCriticalDesignFacts(facts)
  return createHash('sha256').update(canonical, 'utf-8').digest('hex')
}