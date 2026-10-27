import { describe, expect, it } from 'vitest'
import {
  enabledEntriesForRole,
  parseRoleModelRegistry,
  RoleModelRegistryValidationError,
  validateRoleModelRegistry,
} from './roleModelRegistry'

const reviewerEntry = {
  role: 'reviewer',
  provider: 'copilot',
  model: 'mai-code-1.1-flash',
  enabled: true,
}

function errorsOf(input: unknown): string[] {
  const result = validateRoleModelRegistry(input)
  if (result.ok) throw new Error('expected validation to fail')
  return result.errors
}

describe('role / provider / model registry', () => {
  it('accepts a CLI entry and resolves an omitted execution kind to ai_cli', () => {
    const result = validateRoleModelRegistry({
      entries: [
        { role: 'implementer', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh', enabled: true },
        reviewerEntry,
      ],
    })

    expect(result).toEqual({
      ok: true,
      config: {
        entries: [
          {
            role: 'implementer',
            executionKind: 'ai_cli',
            provider: 'codex',
            model: 'gpt-5.6-sol',
            reasoningEffort: 'xhigh',
            enabled: true,
          },
          { ...reviewerEntry, executionKind: 'ai_cli' },
        ],
      },
    })
  })

  it('rejects any execution kind other than the existing CLI path', () => {
    expect(errorsOf({ entries: [{ ...reviewerEntry, executionKind: 'api' }] })).toEqual([
      expect.stringContaining('registry.entries[0].executionKind'),
    ])
  })

  it('rejects a misspelt key instead of silently defaulting the entry to the CLI path', () => {
    expect(errorsOf({ entries: [{ ...reviewerEntry, excutionKind: 'api' }] })).toEqual([
      'registry.entries[0].excutionKind: unknown key',
    ])
  })

  it('rejects providers that are not AiCliProvider values', () => {
    expect(errorsOf({ entries: [{ ...reviewerEntry, provider: 'opencode-go' }] })).toEqual([
      expect.stringContaining('registry.entries[0].provider'),
    ])
  })

  it('rejects unknown roles', () => {
    expect(errorsOf({ entries: [{ ...reviewerEntry, role: 'reveiwer' }] })).toEqual([
      expect.stringContaining('registry.entries[0].role'),
    ])
  })

  it.each([undefined, '', '  ', 'auto', 'AUTO'])('rejects an implicit model (%j)', (model) => {
    expect(errorsOf({ entries: [{ ...reviewerEntry, model }] })).toEqual([
      expect.stringContaining('registry.entries[0].model'),
    ])
  })

  it('requires an explicit enabled flag', () => {
    const { enabled: _enabled, ...withoutEnabled } = reviewerEntry
    expect(errorsOf({ entries: [withoutEnabled] })).toEqual([
      'registry.entries[0].enabled: must be a boolean',
    ])
  })

  it('rejects duplicate role/provider/model rows', () => {
    expect(errorsOf({ entries: [reviewerEntry, { ...reviewerEntry, enabled: false }] })).toEqual([
      expect.stringContaining('registry.entries[1]: duplicate entry'),
    ])
  })

  it('rejects the whole registry when any entry is invalid', () => {
    const result = validateRoleModelRegistry({
      entries: [reviewerEntry, { ...reviewerEntry, model: 'other', executionKind: 'api' }],
    })
    expect(result.ok).toBe(false)
  })

  it('rejects non-object input and unknown top-level keys', () => {
    expect(errorsOf(null)).toEqual(['registry: must be an object'])
    expect(errorsOf({ entries: [], extra: true })).toEqual(['registry.extra: unknown key'])
    expect(errorsOf({})).toEqual(['registry.entries: must be an array'])
  })

  it('parseRoleModelRegistry throws on invalid input', () => {
    expect(() => parseRoleModelRegistry({ entries: [{ ...reviewerEntry, executionKind: 'api' }] }))
      .toThrow(RoleModelRegistryValidationError)
  })

  it('returns enabled entries for a role in declared order', () => {
    const config = parseRoleModelRegistry({
      entries: [
        { role: 'reviewer', provider: 'gemini', model: 'gemini-model', enabled: true },
        { role: 'implementer', provider: 'codex', model: 'gpt-5.6-sol', enabled: true },
        { role: 'reviewer', provider: 'claude_code', model: 'claude-opus-5', enabled: false },
        reviewerEntry,
      ],
    })

    expect(enabledEntriesForRole(config, 'reviewer').map((entry) => entry.provider)).toEqual([
      'gemini',
      'copilot',
    ])
  })
})
