import { describe, expect, it } from 'vitest'
import {
  composeRoadmapReviewMaterial,
  type RoadmapReviewMaterialInput,
} from './roadmapReviewMaterial'

const INPUT: RoadmapReviewMaterialInput = {
  canonicalDefinitionText: 'Goal: build the AI Development Team OS that ships trust.',
  definitionHash: 'def-hash-v3',
  structuredConstraints: [
    { kind: 'max_task_count', value: 8, description: 'cap outstanding tasks', sourceText: 'constraints' },
  ],
  constraintsHash: 'cons-hash-v3',
  roadmapMarkdown: '# Roadmap\n\n- Task A\n- Task B',
}

describe('composeRoadmapReviewMaterial', () => {
  it('concatenates the three canonical artifacts deterministically', () => {
    const material = composeRoadmapReviewMaterial(INPUT)

    expect(material).toBe(composeRoadmapReviewMaterial(INPUT))
    expect(material).toContain('# Roadmap Design Review Material')
    expect(material).toContain('## Project Definition (hash: def-hash-v3)')
    expect(material).toContain('Goal: build the AI Development Team OS that ships trust.')
    expect(material).toContain('## Structured Constraints (hash: cons-hash-v3)')
    expect(material).toContain('## Generated Roadmap')
    expect(material).toContain('- Task A')
    expect(material).toContain('- Task B')
  })

  it('changes output when any one of the three artifacts changes', () => {
    const base = composeRoadmapReviewMaterial(INPUT)

    expect(composeRoadmapReviewMaterial({ ...INPUT, canonicalDefinitionText: 'Goal changed' })).not.toBe(base)
    expect(composeRoadmapReviewMaterial({ ...INPUT, definitionHash: 'def-hash-v4' })).not.toBe(base)
    expect(composeRoadmapReviewMaterial({ ...INPUT, structuredConstraints: [] })).not.toBe(base)
    expect(composeRoadmapReviewMaterial({ ...INPUT, constraintsHash: 'cons-hash-v4' })).not.toBe(base)
    expect(composeRoadmapReviewMaterial({ ...INPUT, roadmapMarkdown: '# Roadmap changed' })).not.toBe(base)
  })

  it('hashes deterministically via the existing computeDesignTextHash (no new hash scheme)', async () => {
    const { computeDesignTextHash } = await import('../designReviewEvidencePolicy.js')
    const material = composeRoadmapReviewMaterial(INPUT)
    const sameMaterial = composeRoadmapReviewMaterial(JSON.parse(JSON.stringify(INPUT)) as RoadmapReviewMaterialInput)

    expect(computeDesignTextHash(material)).toBe(computeDesignTextHash(sameMaterial))
    expect(computeDesignTextHash(material)).toMatch(/^[0-9a-f]{64}$/)
  })
})