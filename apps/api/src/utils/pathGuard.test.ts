import { describe, it, expect } from 'vitest'
import { validateTargetRoot, validateAllowedPaths } from './pathGuard.js'
import os from 'node:os'
import path from 'node:path'

describe('validateTargetRoot', () => {
  it('正常な絶対パスは ok=true', () => {
    const result = validateTargetRoot(path.join(os.tmpdir(), 'my-project'))
    expect(result.ok).toBe(true)
  })

  it('空文字は ok=false', () => {
    expect(validateTargetRoot('').ok).toBe(false)
    expect(validateTargetRoot('  ').ok).toBe(false)
  })

  it('".." を含むパスは ok=false', () => {
    const result = validateTargetRoot('C:/Users/honka/../softwareDevelopAIteam')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('..')
  })

  it('相対パスは ok=false', () => {
    const result = validateTargetRoot('some/relative/path')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('絶対パス')
  })

  it('C:\\Windows は ok=false', () => {
    const result = validateTargetRoot('C:\\Windows\\System32')
    expect(result.ok).toBe(false)
  })

  it('/etc は ok=false（Linux/Mac 環境のみ）', () => {
    // Windows では /etc は絶対パスとして解釈されないため Linux/Mac のみ検証
    if (process.platform === 'win32') return
    const result = validateTargetRoot('/etc/passwd')
    expect(result.ok).toBe(false)
  })
})

describe('validateAllowedPaths', () => {
  const tmpRoot = path.join(os.tmpdir(), 'test-project')

  it('相対パスは ok=true', () => {
    const result = validateAllowedPaths(['src/', 'packages/shared/src/'], tmpRoot)
    expect(result.ok).toBe(true)
  })

  it('".." を含むパスは ok=false', () => {
    const result = validateAllowedPaths(['../other-project/src/'], tmpRoot)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('..')
  })

  it('targetRoot 配下の絶対パスは ok=true', () => {
    const absPath = path.join(tmpRoot, 'src', 'index.ts')
    const result = validateAllowedPaths([absPath], tmpRoot)
    expect(result.ok).toBe(true)
  })

  it('targetRoot 外の絶対パスは ok=false', () => {
    const result = validateAllowedPaths(['/etc/hosts'], tmpRoot)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('targetProjectRoot 配下のみ')
  })

  it('空配列は ok=true', () => {
    expect(validateAllowedPaths([], tmpRoot).ok).toBe(true)
  })
})
