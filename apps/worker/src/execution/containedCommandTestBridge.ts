/**
 * テスト用ブリッジ（本番経路からは import されない）。
 *
 * P1 Phase 2 以前、jobRunner / AI CLI adapter の単体テストは `execFileSync` を mock して
 * コマンド結果を注入していた。containment 導入後もその注入方式をそのまま活かすため、
 * `runContainedOrThrow` の呼び出しを既存の execFileSync mock へ転送する。
 *
 * こうする理由: これらのテストの対象は「封じ込め」ではなく Job オーケストレーションであり、
 * cgroup を作れない Windows 開発機でも決定的に回せる必要がある。
 * 封じ込めプロトコル自体の検証は `runContainedCommand.test.ts` の Linux gate 付きテストで行う。
 *
 * containment の失敗は再現しない（常に成功したものとして扱う）。containment 失敗経路は
 * `ContainmentInfrastructureError` を直接投げるテストで検証すること。
 */

import type { ContainedResult, RunContainedCommandOptions } from './runContainedCommand.js'

/**
 * `vi.mock('.../execution/runContainedCommand.js', () => createContainedCommandMock())` で使う。
 *
 * `node:child_process` を動的 import するため、その suite が execFileSync を mock していれば
 * mock 版が、していなければ実物が使われる（後者は実 git を使う suite 向け）。
 * 実モジュールを importOriginal しないのは、実モジュールが `spawn` を import しており、
 * `node:child_process` を execFileSync だけに mock している suite では解決できないため。
 */
export async function createContainedCommandMock(): Promise<Record<string, unknown>> {
  const { execFileSync } = await import('node:child_process')
  return {
    ContainmentInfrastructureError: TestContainmentInfrastructureError,
    isContainmentInfrastructureError: (err: unknown) => err instanceof TestContainmentInfrastructureError,
    isContainmentAvailable: () => true,
    runContainedOrThrow: (options: RunContainedCommandOptions) =>
      containedOverride !== undefined
        ? containedOverride(options)
        : forwardToExecFileSync(execFileSync as unknown as ExecFileSyncLike, options),
  }
}

/**
 * mock 側の containment 失敗クラス。
 * `isContainmentInfrastructureError` の判定と一致させるため、テストが失敗を注入するときは
 * このクラスを投げること（実モジュールのクラスでは mock 側の判定に一致しない）。
 */
export class TestContainmentInfrastructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContainmentInfrastructureError'
  }
}

type ContainedOverride = (options: RunContainedCommandOptions) => Promise<unknown>
let containedOverride: ContainedOverride | undefined

/** 1テストの間だけ containment の挙動（失敗注入など）を差し替える */
export function setContainedCommandOverride(fn: ContainedOverride): void {
  containedOverride = fn
}

/** 差し替えを解除する。テストの afterEach で必ず呼ぶこと */
export function clearContainedCommandOverride(): void {
  containedOverride = undefined
}

/** `execFileSync` と同じ形で呼べる関数（テストの mock） */
export type ExecFileSyncLike = (
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => unknown

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8')
  return ''
}

/**
 * `runContainedOrThrow` 互換の呼び出しを execFileSync mock へ転送する。
 *
 * execFileSync は非ゼロ終了で throw していたので、その例外を
 * `ContainedResult`（exitCode / stdout / stderr / timedOut）へ翻訳し直す。
 */
export async function forwardToExecFileSync(
  execFileSyncLike: ExecFileSyncLike,
  options: RunContainedCommandOptions,
): Promise<ContainedResult> {
  const [command, ...args] = options.argv
  const base: Omit<ContainedResult, 'exitCode' | 'stdout' | 'stderr' | 'timedOut'> = {
    outcome: 'clean',
    signal: null,
    killedDescendants: false,
    drainMs: 0,
  }

  try {
    const stdout = execFileSyncLike(command, args, {
      cwd: options.cwd,
      shell: false,
      encoding: 'utf-8',
      env: options.env,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
    })
    return { ...base, exitCode: 0, stdout: toText(stdout), stderr: '', timedOut: false }
  } catch (err: any) {
    // 本番では `timedOut` は containment のタイマーが発火したときだけ true になる。
    // execFileSync 時代にその状態を表していたのは「構造化タイムアウト」の三点一致
    // （code=ETIMEDOUT かつ status=null かつ signal=SIGTERM）だけなので、それに揃える。
    // stderr に ETIMEDOUT という文字列が含まれるだけ、あるいは ENOBUFS が SIGTERM を
    // 伴っただけのケースを timeout と見なしてはならない。
    const timedOut = err?.code === 'ETIMEDOUT' && err?.status === null && err?.signal === 'SIGTERM'
    return {
      ...base,
      exitCode: typeof err?.status === 'number' ? err.status : 1,
      stdout: toText(err?.stdout),
      stderr: toText(err?.stderr) || String(err?.message ?? err),
      timedOut,
    }
  }
}
