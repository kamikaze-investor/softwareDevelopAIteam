export type CriticalFactCategory =
  | 'authority'
  | 'durable_state'
  | 'gate_safety'
  | 'external_contract'
  | 'invariant'

export interface CriticalDesignFact {
  category: CriticalFactCategory
  key: string
  value: string
}

/**
 * Canonicalizes Critical Design Facts for stable hashing.
 *
 * Design decisions:
 * - Uses control characters as delimiters to prevent injection attacks:
 *   - '\x1f' (Unit Separator) separates category/key/value within a record
 *   - '\x1e' (Record Separator) separates records
 *   These characters are extremely unlikely to appear in legitimate fact data,
 *   and any attempt to inject them will be rejected with an Error.
 * - Duplicate handling: if the same category+key appears with different values,
 *   an Error is thrown (silent first-win/last-win is unsafe).
 *   Exact duplicates (same category+key+value) are collapsed to a single entry.
 * - Sorting by (category, key) ensures deterministic output regardless of input order.
 */
export function canonicalizeCriticalDesignFacts(
  facts: readonly CriticalDesignFact[],
): string {
  const RECORD_SEP = '\x1e'
  const FIELD_SEP = '\x1f'

  for (const fact of facts) {
    if (
      fact.category.includes(FIELD_SEP) ||
      fact.category.includes(RECORD_SEP) ||
      fact.key.includes(FIELD_SEP) ||
      fact.key.includes(RECORD_SEP) ||
      fact.value.includes(FIELD_SEP) ||
      fact.value.includes(RECORD_SEP)
    ) {
      throw new Error('CriticalDesignFact contains forbidden control character (U+001F or U+001E)')
    }
  }

  const seen = new Map<string, { fact: CriticalDesignFact; count: number }>()

  for (const fact of facts) {
    const compositeKey = `${fact.category}${FIELD_SEP}${fact.key}`
    const existing = seen.get(compositeKey)

    if (existing) {
      if (existing.fact.value !== fact.value) {
        throw new Error(
          `Duplicate CriticalDesignFact with same category+key but different value: category=${fact.category}, key=${fact.key}, values: "${existing.fact.value}" vs "${fact.value}"`,
        )
      }
      existing.count++
    } else {
      seen.set(compositeKey, { fact, count: 1 })
    }
  }

  const sorted = Array.from(seen.values())
    .map((entry) => entry.fact)
    .sort((a, b) => {
      if (a.category !== b.category) {
        return a.category.localeCompare(b.category)
      }
      return a.key.localeCompare(b.key)
    })

  return sorted.map((fact) => `${fact.category}${FIELD_SEP}${fact.key}${FIELD_SEP}${fact.value}`).join(RECORD_SEP)
}