import { describe, expect, it } from 'vitest'
import {
  ROADMAP_CURRENT_STATE_END,
  ROADMAP_CURRENT_STATE_START,
  generateRoadmapCurrentStateBlock,
  replaceGeneratedCurrentStateBlock,
  validateCurrentStateMarkers,
} from './currentStateSync.js'
import { getValidRoadmapItems, updateRoadmapState } from './roadmapParser.js'

const ROADMAP_FIXTURE = [
  '<!-- roadmap:id=done-a state=done -->',
  '1. [x] Done A — details',
  '<!-- roadmap:id=open-a state=planned -->',
  '2. [ ] Open A — details',
].join('\n')

const CURRENT_STATE_FIXTURE = [
  'handwritten before',
  ROADMAP_CURRENT_STATE_START,
  'stale generated content',
  ROADMAP_CURRENT_STATE_END,
  'handwritten after',
].join('\n')

describe('currentStateSync', () => {
  it('is idempotent when sync runs twice with the same roadmap input', () => {
    const generatedBlock = generateRoadmapCurrentStateBlock(getValidRoadmapItems(ROADMAP_FIXTURE))
    const firstSync = replaceGeneratedCurrentStateBlock(CURRENT_STATE_FIXTURE, generatedBlock)
    const secondSync = replaceGeneratedCurrentStateBlock(firstSync.markdown, generatedBlock)

    expect(firstSync.changed).toBe(true)
    expect(secondSync.changed).toBe(false)
    expect(secondSync.markdown).toBe(firstSync.markdown)
  })

  it('detects missing or partial generated block markers', () => {
    expect(validateCurrentStateMarkers('no markers')).toEqual([
      {
        code: 'missing_markers',
        message: 'Current state generated block markers were not found',
      },
    ])

    expect(validateCurrentStateMarkers(`${ROADMAP_CURRENT_STATE_START}\ncontent`)[0]?.code).toBe('missing_end_marker')
  })

  it('leaves marker-external handwritten text unchanged when syncing', () => {
    const generatedBlock = generateRoadmapCurrentStateBlock(getValidRoadmapItems(ROADMAP_FIXTURE))
    const syncResult = replaceGeneratedCurrentStateBlock(CURRENT_STATE_FIXTURE, generatedBlock)
    const lines = syncResult.markdown.split('\n')

    expect(lines[0]).toBe('handwritten before')
    expect(lines.at(-1)).toBe('handwritten after')
  })

  it('generates done titles and non-done titles with states from roadmap metadata', () => {
    const updatedRoadmap = updateRoadmapState(ROADMAP_FIXTURE, 'open-a', 'blocked').markdown
    const generatedBlock = generateRoadmapCurrentStateBlock(getValidRoadmapItems(updatedRoadmap))

    expect(generatedBlock).toContain('- Done A')
    expect(generatedBlock).toContain('- Open A（state: blocked）')
    expect(generatedBlock).toContain('`tasks/roadmap.md`「スマホ操作MVP残タスク」')
  })
})
