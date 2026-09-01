import type { StructuredConstraint } from '@ai-team/shared'

export interface RoadmapReviewMaterialInput {
  canonicalDefinitionText: string
  definitionHash: string
  structuredConstraints: StructuredConstraint[]
  constraintsHash: string
  roadmapMarkdown: string
}

/**
 * Composes the canonical review material for a Whole-Roadmap Design Review by concatenating the
 * three authoritative artifacts item 6 already established (Project Definition text + hash,
 * structured constraints + hash, generated Roadmap markdown). The composed text is then hashed with
 * the SAME computeDesignTextHash() used for Task Review evidence — this is deliberately not a new
 * hash scheme, just a new input to the existing one. Any change to any of the three inputs changes
 * this function's output, and therefore changes the resulting designTextHash, which is exactly what
 * invalidates stale ALIGNED evidence via the existing freshness-check-by-hash-comparison mechanism.
 */
export function composeRoadmapReviewMaterial(input: RoadmapReviewMaterialInput): string {
  return [
    '# Roadmap Design Review Material',
    '',
    `## Project Definition (hash: ${input.definitionHash})`,
    input.canonicalDefinitionText,
    '',
    `## Structured Constraints (hash: ${input.constraintsHash})`,
    JSON.stringify(input.structuredConstraints, null, 2),
    '',
    '## Generated Roadmap',
    input.roadmapMarkdown,
  ].join('\n')
}