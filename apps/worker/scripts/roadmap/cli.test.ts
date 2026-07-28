import { describe, expect, it } from 'vitest'
import { collectCheckIssues, parseCommandArgs } from './cli.js'
import {
  ROADMAP_CURRENT_STATE_END,
  ROADMAP_CURRENT_STATE_START,
  generateRoadmapCurrentStateBlock,
  replaceGeneratedCurrentStateBlock,
} from './currentStateSync.js'
import { getValidRoadmapItems, updateRoadmapState } from './roadmapParser.js'

const ROADMAP_FIXTURE = [
  '<!-- roadmap:id=done-a state=done -->',
  '1. [x] Done A — details',
  '<!-- roadmap:id=open-a state=planned -->',
  '2. [ ] Open A — details',
].join('\n')

const CURRENT_STATE_FIXTURE = [
  'before',
  ROADMAP_CURRENT_STATE_START,
  'stale',
  ROADMAP_CURRENT_STATE_END,
  'after',
].join('\n')

describe('cli argument parsing', () => {
  it('parses update arguments passed after pnpm script name', () => {
    expect(parseCommandArgs(['update', '--id', 'open-a', '--state', 'in_progress'])).toEqual({
      kind: 'update',
      id: 'open-a',
      state: 'in_progress',
    })
  })

  it('rejects invalid update states', () => {
    expect(() => parseCommandArgs(['update', '--id', 'open-a', '--state', 'invalid'])).toThrow('Invalid state')
  })
})

describe('collectCheckIssues', () => {
  it('returns no issues when roadmap and generated current state block are synced', () => {
    const currentState = syncedCurrentStateFor(ROADMAP_FIXTURE)

    expect(collectCheckIssues(ROADMAP_FIXTURE, currentState)).toEqual([])
  })

  it('detects a roadmap update that has not been synced into current state', () => {
    const syncedCurrentState = syncedCurrentStateFor(ROADMAP_FIXTURE)
    const updatedRoadmap = updateRoadmapState(ROADMAP_FIXTURE, 'open-a', 'in_progress').markdown

    expect(collectCheckIssues(updatedRoadmap, syncedCurrentState)).toContainEqual({
      source: 'currentState',
      code: 'generated_block_mismatch',
      message: 'docs/PROJECT_CURRENT_STATE.md generated block is not synced with tasks/roadmap.md',
    })
  })

  it('detects partial generated block markers during check', () => {
    expect(collectCheckIssues(ROADMAP_FIXTURE, `${ROADMAP_CURRENT_STATE_START}\ncontent`)).toContainEqual({
      source: 'currentState',
      code: 'missing_end_marker',
      message: 'Current state generated block END marker was not found',
    })
  })
})

function syncedCurrentStateFor(roadmapMarkdown: string): string {
  const generatedBlock = generateRoadmapCurrentStateBlock(getValidRoadmapItems(roadmapMarkdown))
  return replaceGeneratedCurrentStateBlock(CURRENT_STATE_FIXTURE, generatedBlock).markdown
}
