function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item))
  }

  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key])
    }
    return sorted
  }

  return value
}

export function canonicalizeJobUpdate(payload: Record<string, unknown>): string {
  return JSON.stringify(sortValue(payload))
}
