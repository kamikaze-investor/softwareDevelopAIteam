import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

/**
 * Gate Evidence Check workflow の secret trust boundary。
 *
 * `pull_request` では同一repository内のPRでもworkflow定義がPR head側から読まれるため、
 * PRがこのworkflow自体を書き換えてACTIONS_READONLY secretを持ち出せる。
 * `pull_request_target` はworkflow定義をbase branchへ固定するのでその経路が塞がる。
 *
 * ただし `pull_request_target` はPR codeをcheckout/実行すると危険なので、
 * checkout・download・script実行を一切行わないことも同時に固定する。
 */

const WORKFLOW_PATH = join(__dirname, '../../../../.github/workflows/gate-evidence-check.yml')
const workflowText = readFileSync(WORKFLOW_PATH, 'utf-8')
const workflow = YAML.parse(workflowText) as {
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, { steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }> }>
}

const steps = workflow.jobs['gate-evidence'].steps

describe('gate evidence workflow: secret trust boundary', () => {
  it('workflow定義をbase branchへ固定する（pull_request_targetのみ）', () => {
    expect(Object.keys(workflow.on)).toEqual(['pull_request_target'])
    expect(workflow.on).not.toHaveProperty('pull_request')
  })

  it('PR head / merge commit をcheckoutしない', () => {
    for (const step of steps) {
      expect(step.uses ?? '').not.toMatch(/actions\/checkout/)
    }
    expect(workflowText).not.toMatch(/actions\/checkout/)
  })

  it('PR codeのdownload・script実行を行わない', () => {
    for (const step of steps) {
      const run = step.run ?? ''
      // PR head/merge refをfetchしたりcloneしたりしない
      expect(run).not.toMatch(/git\s+(clone|fetch|checkout)/)
      // PR側のscriptやbuildを走らせない
      expect(run).not.toMatch(/\b(npm|pnpm|yarn|node|bash)\s+(install|run|ci|test)\b/)
    }
  })

  it('secretはAPIへのAuthorizationヘッダとしてのみ使い、PR codeへ渡さない', () => {
    const envKeys = steps.flatMap((step) => Object.keys(step.env ?? {}))
    expect(envKeys).toContain('AI_TEAM_ACTIONS_READONLY_TOKEN')

    // secretを使うのはcurlのAuthorizationヘッダだけ
    expect(workflowText).toMatch(/Authorization: Bearer \$\{AI_TEAM_ACTIONS_READONLY_TOKEN\}/)
    // echo等で出力しない
    expect(workflowText).not.toMatch(/echo\s+.*AI_TEAM_ACTIONS_READONLY_TOKEN/)
  })

  it('GITHUB_TOKENの権限は contents: read のみ', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  it('PRで追加されたcommitだけを列挙する（base branchの既存commitを含めない）', () => {
    const run = steps.map((step) => step.run ?? '').join('\n')
    expect(run).toMatch(/pulls\/\$\{PR_NUMBER\}\/commits/)
    // 全history列挙やcompare APIでbase側まで含めない
    expect(run).not.toMatch(/rev-list/)
    expect(run).not.toMatch(/\/commits\?sha=/)
  })

  it('error・未設定・commit 0件はFAIL CLOSED', () => {
    const run = steps.map((step) => step.run ?? '').join('\n')
    expect(run).toMatch(/set -euo pipefail/)
    // credential未設定
    expect(run).toMatch(/exit 1/)
    expect(run).toMatch(/fail closed/i)
    // HTTP非200
    expect(run).toMatch(/"\$status" != "200"/)
    // trustedが取れなければfalse扱い
    expect(run).toMatch(/\.trusted \/\/ false/)
  })
})
