/**
 * Independent Remediation 専用の one-shot runner。
 *
 * 責務は「指定された flagship CLI で Remediation Proposal を生成して stdout へ返すこと」だけ。
 * **判定・evidence 登録・Task 更新・Job 作成は一切行わない。** それらは API（Control Plane）の
 * 権限であり、このプロセスは実行者であって authority ではない
 * （`designReviewRunner.ts` / `roadmapGeneratorRunner.ts` と同じ役割分担）。
 *
 * `roadmapGeneratorRunner.ts` との違いは **provider が入力で決まる**ことだけである。
 * Remediation は「元の提案者と別 vendor の flagship」を要求するので、
 * provider を固定できない（選択は API 側 `independentRemediationPolicy` が行う）。
 * **新しい provider stack は作らず、既存 `createAiCliAdapter()` をそのまま使う。**
 *
 * 入出力:
 *   stdin  … RemediationRunnerInput の JSON
 *   stdout … Remediation Proposal の JSON（モデル本文そのまま）
 *   exit   … 0=生成成功 / 1=実行失敗
 *
 * repo-aware / read-only:
 *   `mode: 'review'` にすることで `codexAdapter` が `--sandbox read-only` を選ぶ。
 *   `postLint: false` で、生成後に formatter がファイルを書き換える経路も塞ぐ。
 *   したがって Remediation AI は既存のコード・仕様・テストを自力で読めるが、
 *   **対象リポジトリを書き換えられない**。修正版は提案（JSON）としてしか出てこない。
 */

import { readFileSync } from 'node:fs'
import { createAiCliAdapter } from '../src/aiCli/factory.js'
import { extractClaudeCliResultText } from '../src/approvalLevel/reviewerAdapter.js'

export interface RemediationRunnerInput {
  /** ログラベル用途の Task ID。 */
  taskId: string
  /** 使用 provider。API 側の vendor 分離判定が決めた値をそのまま受ける。 */
  provider: 'codex' | 'claude_code'
  /** 使用 model。**未指定を許さない**（CLI 既定へ落ちると flagship 保証が消える）。 */
  model: string
  /** 推論強度（Codex のみ有効）。 */
  reasoningEffort?: string
  /** Remediation prompt（API 側が組み立てた canonical 文字列）。 */
  prompt: string
  /** 対象リポジトリのルート。ここを読みながら提案する。 */
  workingDir: string
  /** legacy Landlock sandbox を使うか（この VPS で repo を読むために必要。deprecated な暫定経路）。 */
  useLegacyLandlockSandbox?: boolean
}

function readStdin(): string {
  return readFileSync(0, 'utf-8')
}

export async function runRemediation(input: RemediationRunnerInput): Promise<string> {
  // **model 未指定では走らせない。** CLI 既定モデルへ落ちると「flagship 必須」が
  // 黙って破れる（品質未満のモデルが解決案を書いたことに気付けない）。
  if (input.model.trim() === '') {
    throw new Error('[remediationRunner] model は必須です（CLI 既定モデルへのフォールバックは許可しない）')
  }

  const adapter = createAiCliAdapter({ provider: input.provider })

  const result = await adapter.run({
    taskId: `remediation:${input.taskId}`,
    provider: input.provider,
    workingDir: input.workingDir,
    prompt: input.prompt,
    contextFiles: [],
    // implement 以外 ＝ `--sandbox read-only`。提案生成中にリポジトリを書き換えさせない。
    mode: 'review',
    expectJson: true,
    postLint: false,
    model: input.model,
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.useLegacyLandlockSandbox ? { useLegacyLandlockSandbox: true } : {}),
  })

  if (result.blocked) {
    throw new Error(`[remediationRunner] guard に block されました: ${result.stderr || result.stdout}`)
  }

  if (result.exitCode !== 0) {
    // 提案が得られないことを「修正不要」として下流へ流さない（fail-closed）。
    // 別 flagship vendor への切り替えは API 側が判断する（ここでは弱い model へ落ちない）。
    throw new Error(
      `[remediationRunner] ${input.provider} CLI が失敗しました: exitCode=${result.exitCode}`
      + `${result.stderr ? ` ${result.stderr.slice(-300)}` : ''}`,
    )
  }

  // **Claude の envelope 展開を `parsedOutput` より先に行う。順序が逆だと機能しない。**
  //
  // `claudeCodeAdapter` は `--output-format json` を**常に**付けるので stdout は CLI envelope
  // （`{type:'result', result:'<モデル本文>', ...}`）である。`expectJson` 経路の
  // `tryParseJson(stdout)` はその envelope を正常な JSON として parse してしまうため、
  // `parsedOutput` には**envelope そのもの**が入る。先に `parsedOutput` を返すと
  // `parseRemediationProposal()` が envelope を見て必ず失敗し、**Anthropic 側の
  // Remediation が構造的に一度も成立しない**（critical load では judge 除外により
  // Anthropic が選ばれるので、最も危険なケースで必ず失敗することになる）。
  // `ClaudeReviewerAdapter` も同じ理由で `parsedOutput` を使わず stdout から二段階 parse する。
  if (input.provider === 'claude_code') {
    const innerText = extractClaudeCliResultText(result.stdout)
    if (innerText === undefined) {
      throw new Error('[remediationRunner] Claude CLI の envelope から本文を取り出せませんでした')
    }
    return innerText
  }

  // `expectJson` により codexAdapter は `--output-last-message` で最終回答を素の JSON として
  // 取得する。取得できた場合はそれが権威（stdout の narration を再 parse しない）。
  if (result.parsedOutput !== undefined) {
    return JSON.stringify(result.parsedOutput)
  }

  return result.stdout
}

async function main(): Promise<void> {
  let input: RemediationRunnerInput
  try {
    input = JSON.parse(readStdin()) as RemediationRunnerInput
  } catch (err) {
    console.error(
      `[remediationRunner] 入力JSONの解析に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }

  try {
    process.stdout.write(await runRemediation(input))
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

// テストからの import では実行しない
if (process.argv[1]?.includes('remediationRunner')) {
  void main()
}
