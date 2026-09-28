import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import os from 'node:os'
import path from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { contextPackRoutes } from './contextPack.js'

/**
 * `POST /api/context-pack` の任意ファイル読み取り（security fix）の regression test。
 *
 * 修正前は targetProjectRoot が拒否リスト方式（/etc 等だけを拒否）で、/srv・/home・/tmp 等を
 * root にでき、symlink も辿り、`.env` もそのまま返していた。ここで固定すること:
 * - root は設定済みの target root（`TARGET_ROOT ?? /workspace/target`）そのものだけ
 * - 読むファイルはすべて realpath が root の内側（symlink で外へ出られない）
 * - 秘密ファイル（`.env` 等）と dotfile は返さない
 * - 正当な workspace 内のファイルは従来どおり読める
 */

const TASK = {
  id: 'task-001',
  title: 't',
  description: 'd',
  phase: 1,
  assignee: 'developer_ai',
  dependencies: [],
  acceptanceCriteria: [],
  allowedPaths: ['src'],
  estimatedComplexity: 'small',
}

const OUTSIDE_SECRET = 'OUTSIDE-SECRET-VALUE-9d2f'
const ENV_SECRET = 'WORKSPACE-ENV-SECRET-51ab'

describe('POST /api/context-pack — 読み取り範囲の制限', () => {
  let sandbox: string
  let workspace: string
  let outside: string
  let app: FastifyInstance
  const savedTargetRoot = process.env.TARGET_ROOT

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'ctx-sec-'))
    workspace = path.join(sandbox, 'ws')
    outside = path.join(sandbox, 'outside')
    mkdirSync(path.join(workspace, 'src'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(workspace, 'src', 'ok.ts'), 'export const ok = 1')
    writeFileSync(path.join(outside, 'secret.env'), `TOKEN=${OUTSIDE_SECRET}`)
    writeFileSync(path.join(outside, 'notes.md'), OUTSIDE_SECRET)
    process.env.TARGET_ROOT = workspace

    app = Fastify()
    app.register(contextPackRoutes, { prefix: '/api/context-pack' })
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    if (savedTargetRoot === undefined) delete process.env.TARGET_ROOT
    else process.env.TARGET_ROOT = savedTargetRoot
    rmSync(sandbox, { recursive: true, force: true })
  })

  async function post(targetProjectRoot: string, allowedPaths: string[]) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/context-pack',
      payload: { task: { ...TASK, allowedPaths }, targetProjectRoot },
    })
    return { status: res.statusCode, body: res.body }
  }

  it('正常: 設定済み root の中のファイルは従来どおり読める', async () => {
    const res = await post(workspace, ['src'])
    expect(res.status).toBe(201)
    const pack = JSON.parse(res.body).pack
    expect(pack.relevantFiles).toEqual([
      expect.objectContaining({ relativePath: 'src/ok.ts', content: 'export const ok = 1', isNew: false }),
    ])
  })

  it('/srv/ai-team/env を root にした要求は拒否する', async () => {
    const res = await post('/srv/ai-team/env', ['.'])
    expect(res.status).toBe(400)
    const res2 = await post('/srv/ai-team/env', ['api.env'])
    expect(res2.status).toBe(400)
  })

  it('repository（設定済み root）外の absolute path を root にできない', async () => {
    const res = await post(outside, ['.'])
    expect(res.status).toBe(400)
    expect(res.body).not.toContain(OUTSIDE_SECRET)
  })

  it('root と同じ接頭辞の隣接ディレクトリ（ws-evil）を root にも allowedPaths にもできない', async () => {
    const sibling = `${workspace}-evil`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(path.join(sibling, 'x.md'), OUTSIDE_SECRET)

    const asRoot = await post(sibling, ['.'])
    expect(asRoot.status).toBe(400)
    const asAllowedPath = await post(workspace, [path.join(sibling, 'x.md')])
    expect(asAllowedPath.body).not.toContain(OUTSIDE_SECRET)
  })

  it('"../" traversal は root / allowedPaths のどちらでも拒否する', async () => {
    expect((await post(`${workspace}/../outside`, ['.'])).status).toBe(400)
    const res = await post(workspace, ['src/../../outside'])
    expect(res.status).toBe(400)
    expect(res.body).not.toContain(OUTSIDE_SECRET)
  })

  it('allowedPaths の absolute path で root 外を指せない', async () => {
    const res = await post(workspace, [path.join(outside, 'notes.md')])
    expect(res.body).not.toContain(OUTSIDE_SECRET)
  })

  it('symlink（ファイル・ディレクトリ）経由で root の外へ出られない', async () => {
    symlinkSync(path.join(outside, 'notes.md'), path.join(workspace, 'src', 'link-file.md'))
    symlinkSync(outside, path.join(workspace, 'src', 'link-dir'))
    symlinkSync(outside, path.join(workspace, 'escape'))

    for (const allowedPaths of [['src'], ['src/link-file.md'], ['src/link-dir'], ['escape'], ['.']]) {
      const res = await post(workspace, allowedPaths)
      expect({ allowedPaths, leaked: res.body.includes(OUTSIDE_SECRET) }).toEqual({ allowedPaths, leaked: false })
    }
  })

  it('root 外を指す symlink を root として渡しても拒否する（設定済み root とだけ一致させる）', async () => {
    const alias = path.join(sandbox, 'alias')
    symlinkSync(outside, alias)
    const res = await post(alias, ['.'])
    expect(res.status).toBe(400)
    expect(res.body).not.toContain(OUTSIDE_SECRET)
  })

  it('workspace 内の .env・鍵・dotfile は返さない', async () => {
    writeFileSync(path.join(workspace, '.env'), `TOKEN=${ENV_SECRET}`)
    writeFileSync(path.join(workspace, 'src', '.env.local'), `TOKEN=${ENV_SECRET}`)
    writeFileSync(path.join(workspace, 'src', 'deploy.pem'), ENV_SECRET)
    mkdirSync(path.join(workspace, '.secrets'), { recursive: true })
    writeFileSync(path.join(workspace, '.secrets', 'k.txt'), ENV_SECRET)

    for (const allowedPaths of [['.'], ['src'], ['.env'], ['src/.env.local'], ['.secrets']]) {
      const res = await post(workspace, allowedPaths)
      expect({ allowedPaths, leaked: res.body.includes(ENV_SECRET) }).toEqual({ allowedPaths, leaked: false })
    }
    // 正当なファイルは引き続き返る
    expect((await post(workspace, ['.'])).body).toContain('export const ok = 1')
  })

  it('Project Memory の読み込みも symlink で root 外へ出られない', async () => {
    mkdirSync(path.join(workspace, 'docs'), { recursive: true })
    mkdirSync(path.join(outside, 'pm'), { recursive: true })
    writeFileSync(path.join(outside, 'pm', 'goal.md'), `# Goal\n\n${OUTSIDE_SECRET}`)
    symlinkSync(path.join(outside, 'pm'), path.join(workspace, 'docs', 'project_memory'))

    const res = await post(workspace, ['src'])
    expect(res.body).not.toContain(OUTSIDE_SECRET)
  })

  it('不正入力（NUL・空白だけ・相対 root）は fail closed', async () => {
    expect((await post(`${workspace}\0`, ['src'])).status).toBe(400)
    expect((await post('   ', ['src'])).status).toBe(400)
    expect((await post('ws', ['src'])).status).toBe(400)
    expect((await post(workspace, ['src\0/../..'])).status).toBe(400)
  })
})
