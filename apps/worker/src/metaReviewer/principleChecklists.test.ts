import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PrincipleSelection } from '@ai-team/shared/src/engineeringPrinciples.js'
import { principleChecklistFiles } from './principleChecklists.js'

const CHECKLISTS_DIR = path.resolve(__dirname, '../../../../docs/meta_reviewer/checklists')

function selected(...slugs: PrincipleSelection['slug'][]): PrincipleSelection[] {
  return slugs.map((slug) => ({ slug, versionHash: 'h', oneLiner: 'o', source: 'contextual', reason: 'r' }))
}

describe('principleChecklistFiles', () => {
  it('maps a selected principle to the checklist it owns, once', () => {
    expect(principleChecklistFiles(selected('stable-contract-first', 'canonical-domain-meaning', 'canonical-domain-meaning')))
      .toEqual(['semantic_integrity.md'])
  })

  it('returns nothing when no selected principle owns a checklist', () => {
    expect(principleChecklistFiles(selected('stable-contract-first', 'scale-to-risk'))).toEqual([])
    expect(principleChecklistFiles([])).toEqual([])
  })

  it('points only at checklist files that exist in the repository', () => {
    for (const file of principleChecklistFiles(selected('canonical-domain-meaning'))) {
      expect(existsSync(path.join(CHECKLISTS_DIR, file))).toBe(true)
    }
  })
})
