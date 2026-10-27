/**
 * Role / Provider / Model Registry — 共有 contract（roadmap: `role-model-registry`）。
 *
 * 役割（Role）ごとに「どの provider のどの model で実行するか」を1枚の対応表で持つための
 * **型と実行時検証だけ**をここに置く。Worker / API への配線・永続化・UI は持たない（後続 Task）。
 *
 * ## 実行経路は既存の AI CLI 経路だけ（CEO 指示 2026-09-14）
 *
 * entry の実行種別は `'ai_cli'`（既存 `AiCliProvider` を `aiCli/factory.ts` の adapter で動かす経路）
 * のみを受け付ける。省略時もこれに解決する。それ以外の値は**検証で拒否する**。
 * 防ぎたい失敗は「Registry の1行を書き換えただけで、従量課金 API など新しい実行経路が
 * 標準経路として使われ始める」こと。将来 API 経路が合理的になった場合は、
 * `ROLE_MODEL_EXECUTION_KINDS` へ値を足す変更として明示的に扱う（Role 側へ経路種別を埋め込まない）。
 *
 * ## fail-closed にしている点
 *
 * - **未知の key を拒否する。** `executionKind` の綴り間違い（例: `excutionKind: 'api'`）を黙って
 *   無視すると、その entry は既定の `'ai_cli'` として通ってしまう。
 * - **未知の role / provider を拒否する。** 名前の間違いで別 Role の設定として扱われるのを防ぐ。
 * - **model の省略・`auto` を拒否する。** harness 側の自動選択に任せると、Registry を見ても
 *   実際に何が動いたか分からなくなる（Copilot fallback の model 明示要求、2026-09-15）。
 *
 * ## ここが持たないもの
 *
 * 生成担当と独立 Review 担当の vendor 分離の判定は `reviewSeparation.ts` が正本であり、
 * ここでは再実装しない。この表に載ったことを Independent Reviewer への昇格根拠にしない。
 */

import type { AiCliProvider } from './types/ai_cli'

/** Registry が扱う役割。未知の値は検証で拒否する。 */
export const ROLE_MODEL_ROLES = [
  'pl',
  'implementer',
  'reviewer',
  'researcher',
  'meta_reviewer',
  'explainer',
  'independent_remediation',
] as const

export type RoleModelRole = (typeof ROLE_MODEL_ROLES)[number]

/**
 * entry が使ってよい実行種別。**既存 AI CLI 経路だけ。**
 * ここへ値を足すことは「新しい実行経路を標準として認める」判断であり、Registry の設定値では行わない。
 */
export const ROLE_MODEL_EXECUTION_KINDS = ['ai_cli'] as const

export type RoleModelExecutionKind = (typeof ROLE_MODEL_EXECUTION_KINDS)[number]

/** 省略時の実行種別。 */
export const DEFAULT_ROLE_MODEL_EXECUTION_KIND: RoleModelExecutionKind = 'ai_cli'

/** 実行時検証用の `AiCliProvider` 一覧。下の型検査で union との一致を保証する。 */
export const ROLE_MODEL_CLI_PROVIDERS = [
  'claude_code',
  'codex',
  'gemini',
  'copilot',
] as const satisfies readonly AiCliProvider[]

// `AiCliProvider` に値が増えて上の一覧が追従していなければ typecheck で落とす。
type MissingCliProvider = Exclude<AiCliProvider, (typeof ROLE_MODEL_CLI_PROVIDERS)[number]>
const _cliProvidersExhaustive: [MissingCliProvider] extends [never] ? true : MissingCliProvider = true
void _cliProvidersExhaustive

/** 対応表の1行（検証済み・正規化後）。 */
export interface RoleProviderModelEntry {
  role: RoleModelRole
  /** 常に既存 AI CLI 経路。 */
  executionKind: RoleModelExecutionKind
  provider: AiCliProvider
  /** 明示した model ID。空・`auto` は許さない。 */
  model: string
  /** 任意。`AiCliRequest.reasoningEffort` へ渡す値。 */
  reasoningEffort?: string
  /** `false` の entry は候補にしない（行を消さずに止めるため）。 */
  enabled: boolean
}

/**
 * 対応表全体。同じ role の entry が複数ある場合、**配列順が候補順**である
 * （例: Reviewer の provider 候補順）。
 */
export interface RoleModelRegistryConfig {
  entries: RoleProviderModelEntry[]
}

export type RoleModelRegistryValidation =
  | { ok: true; config: RoleModelRegistryConfig }
  | { ok: false; errors: string[] }

const ENTRY_KEYS = new Set(['role', 'executionKind', 'provider', 'model', 'reasoningEffort', 'enabled'])
const CONFIG_KEYS = new Set(['entries'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function validateEntry(
  raw: unknown,
  path: string,
  errors: string[],
): RoleProviderModelEntry | undefined {
  if (!isRecord(raw)) {
    errors.push(`${path}: must be an object`)
    return undefined
  }

  const before = errors.length

  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) errors.push(`${path}.${key}: unknown key`)
  }

  if (!isOneOf(ROLE_MODEL_ROLES, raw.role)) {
    errors.push(`${path}.role: must be one of ${ROLE_MODEL_ROLES.join(', ')}`)
  }

  const executionKind = raw.executionKind === undefined
    ? DEFAULT_ROLE_MODEL_EXECUTION_KIND
    : raw.executionKind
  if (!isOneOf(ROLE_MODEL_EXECUTION_KINDS, executionKind)) {
    errors.push(
      `${path}.executionKind: only the existing AI CLI path is allowed (${ROLE_MODEL_EXECUTION_KINDS.join(', ')})`,
    )
  }

  if (!isOneOf(ROLE_MODEL_CLI_PROVIDERS, raw.provider)) {
    errors.push(`${path}.provider: must be an AiCliProvider (${ROLE_MODEL_CLI_PROVIDERS.join(', ')})`)
  }

  const model = nonEmptyTrimmed(raw.model)
  if (model === undefined) {
    errors.push(`${path}.model: must be a non-empty string`)
  } else if (model.toLowerCase() === 'auto') {
    errors.push(`${path}.model: 'auto' is not allowed; specify the model explicitly`)
  }

  let reasoningEffort: string | undefined
  if (raw.reasoningEffort !== undefined) {
    reasoningEffort = nonEmptyTrimmed(raw.reasoningEffort)
    if (reasoningEffort === undefined) {
      errors.push(`${path}.reasoningEffort: must be a non-empty string when present`)
    }
  }

  if (typeof raw.enabled !== 'boolean') {
    errors.push(`${path}.enabled: must be a boolean`)
  }

  if (errors.length !== before) return undefined

  return {
    role: raw.role as RoleModelRole,
    executionKind: executionKind as RoleModelExecutionKind,
    provider: raw.provider as AiCliProvider,
    model: model as string,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    enabled: raw.enabled as boolean,
  }
}

/**
 * 対応表を検証し、正規化した設定を返す。
 *
 * **1件でも不正があれば全体を拒否する**（部分的に通すと、消えた行のぶん候補順が黙って変わる）。
 */
export function validateRoleModelRegistry(input: unknown): RoleModelRegistryValidation {
  const errors: string[] = []

  if (!isRecord(input)) {
    return { ok: false, errors: ['registry: must be an object'] }
  }
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`registry.${key}: unknown key`)
  }
  if (!Array.isArray(input.entries)) {
    errors.push('registry.entries: must be an array')
    return { ok: false, errors }
  }

  const entries: RoleProviderModelEntry[] = []
  const seen = new Set<string>()
  input.entries.forEach((raw, index) => {
    const path = `registry.entries[${index}]`
    const entry = validateEntry(raw, path, errors)
    if (entry === undefined) return
    // 同じ (role, provider, model) が2行あると、どちらの enabled / reasoningEffort が効くか曖昧になる。
    const identity = `${entry.role}\u0000${entry.provider}\u0000${entry.model}`
    if (seen.has(identity)) {
      errors.push(`${path}: duplicate entry for role=${entry.role} provider=${entry.provider} model=${entry.model}`)
      return
    }
    seen.add(identity)
    entries.push(entry)
  })

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, config: { entries } }
}

export class RoleModelRegistryValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`[roleModelRegistry] invalid registry: ${errors.join('; ')}`)
    this.name = 'RoleModelRegistryValidationError'
  }
}

/** 検証に失敗したら throw する版（起動時の設定読み込み用）。 */
export function parseRoleModelRegistry(input: unknown): RoleModelRegistryConfig {
  const result = validateRoleModelRegistry(input)
  if (!result.ok) throw new RoleModelRegistryValidationError(result.errors)
  return result.config
}

/** 指定 role の有効な entry を候補順で返す。 */
export function enabledEntriesForRole(
  config: RoleModelRegistryConfig,
  role: RoleModelRole,
): RoleProviderModelEntry[] {
  return config.entries.filter((entry) => entry.role === role && entry.enabled)
}
