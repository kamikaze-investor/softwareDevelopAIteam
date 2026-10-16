import { describe, expect, it } from 'vitest'
import {
  buildDesignContract,
  loadEngineeringPrinciples,
  selectPrincipleSlugs,
} from '@ai-team/shared/src/engineeringPrinciples.js'
import { mapFileToFocuses } from '@ai-team/worker/src/approvalLevel/focusSelector.js'
import { buildInitialImplementAiCliPrompt } from './ctoAi/initialImplementWorkflow'
import { buildRepairPrompt } from './designReview/repairPromptBuilder'
import { appendImplementContracts, buildResumeAiCliPrompt, buildTaskDesignContract } from './implementPrompt'

const CANONICAL_DOMAIN_MEANING = 'Decide domain facts through their canonical owner'

function task(allowedPaths: string[]) {
  return {
    title: 't',
    description: 'd',
    acceptanceCriteria: ['a'],
    expectedOutputs: [],
    allowedPaths,
    forbiddenPaths: [],
  }
}

function designContractOf(prompt: string): string {
  return prompt.slice(prompt.indexOf('## Design Contract')).split('\n').filter((line) => line.startsWith('- ')).join('\n')
}

describe('buildTaskDesignContract', () => {
  // 同じ Task なら、どの producer を通っても同じ原則が載る（以前は POST /jobs と repair だけが core のみだった）。
  it('gives every implement producer the same principles for the same Task', () => {
    const t = task(['apps/api/src/storage/sqlite.ts'])
    const expected = buildTaskDesignContract(t)
    const producers = [
      buildInitialImplementAiCliPrompt(t),
      appendImplementContracts('implement it', t),
      buildResumeAiCliPrompt(t, 'continue', 'pl'),
      buildRepairPrompt({ ...t, taskTitle: t.title, taskDescription: t.description }),
    ]
    for (const prompt of producers) {
      expect(designContractOf(prompt)).toBe(designContractOf(expected))
    }
    expect(expected).toContain(CANONICAL_DOMAIN_MEANING)
  })

  // owner へ寄せる前の初回実装の式と byte 一致すること。ずれると、既に ALIGNED の evidence を持つ Task が
  // Job 作成時に DESIGN_REVIEW_HASH_MISMATCH になり、Design Review をやり直すことになる。
  it('keeps the initial implement Design Contract byte-identical to the previous formula', () => {
    for (const paths of [['apps/api/src/storage/sqlite.ts'], ['apps/api/src/pl/abortTask.ts'], ['src/x.ts'], []]) {
      const principles = loadEngineeringPrinciples()
      const previous = buildDesignContract({
        slugs: selectPrincipleSlugs({ predictedFocuses: paths.flatMap(mapFileToFocuses) }, principles),
        principles,
      })
      expect(buildTaskDesignContract(task(paths))).toBe(previous)
      expect(buildInitialImplementAiCliPrompt(task(paths)).endsWith(previous)).toBe(true)
    }
  })

  // POST /jobs が core のみへ戻らないこと（以前の欠落）。
  it('gives POST /jobs implement prompts the focus-selected principles', () => {
    expect(appendImplementContracts('x', task(['apps/api/src/storage/sqlite.ts']))).toContain(CANONICAL_DOMAIN_MEANING)
  })

  // contextual のまま: focus が選ばない Task には載せない（全 prompt への常時注入にしない）。
  it('keeps canonical-domain-meaning contextual', () => {
    expect(buildTaskDesignContract(task(['apps/mobile/src/screens/Home.tsx']))).not.toContain(CANONICAL_DOMAIN_MEANING)
    expect(appendImplementContracts('x', task(['apps/mobile/src/screens/Home.tsx']))).not.toContain(CANONICAL_DOMAIN_MEANING)
  })
})
