/**
 * Roadmap生成専用の one-shot runner（Codex経路）。
 *
 * 責務は「Codex CLIでRoadmap JSONを生成してstdoutへ返すこと」だけ。
 * Task同期・Design Review・evidence登録・decisionの確定は行わない。
 * それらはAPI（Control Plane）の権限であり、このプロセスは実行者であってauthorityではない。
 *
 * designReviewRunner.ts と同じ形にしてある（API側が既存の`executeRunner()`パターンで
 * spawnできるようにするため）。**新しいQueue/Daemon/Gateは追加していない。**
 *
 * 入出力:
 *   stdin  … RoadmapGeneratorRunnerInput の JSON
 *   stdout … Roadmap の JSON
 *   exit   … 0=生成成功 / 1=実行失敗
 *
 * repo-aware:
 *   Codex CLIは `-C <workingDir>` で対象リポジトリを見ながら動く。**sandboxはread-only**
 *   （`mode`をimplement以外にすることで`codexAdapter`が`--sandbox read-only`を選ぶ）。
 *   さらに`postLint: false`で、生成後にformatterがファイルを書き換える経路も塞いでいる。
 *   したがって既存のコード・仕様・テストを必要に応じて自力で調査できる。
 *   Context Packは新設していない。
 *
 *   **保証範囲**（2026-09-07更新）: 対象リポジトリへは書かない。`--sandbox read-only`により
 *   モデルが生成した内容でリポジトリを書き換えることはできず、`--output-last-message`用の
 *   一時ファイルも`adapter.ts`がOS temp配下へ置くようになったため、対象リポジトリには
 *   一瞬もファイルを作らない（以前は`workingDir`直下に作っていた）。
 *
 *   ただし`bwrap`が動かないこのVPSでは、Codexがrepoを読むために
 *   call-localな`-c use_legacy_landlock=true`が必要である。これは**deprecatedな暫定経路**で
 *   あって恒久解決ではない（roadmap: codex-sandbox-off-deprecated-landlock）。
 *
 *   対象リポジトリが空でも同じ経路で動く。「ディレクトリが存在するか」で
 *   greenfield / existing を判定するような人工的な分岐は持たない
 *   （関連する成果物があればAIが読む、無ければ読まない、というだけ）。
 *
 * ⚠️ このrunnerはPR C（topology cutover）まで本番経路から呼ばれない。
 *    PR Bの時点では canary / test からのみ到達する。
 */

import { readFileSync } from 'node:fs'
import { createAiCliAdapter } from '../src/aiCli/factory.js'

export interface RoadmapGeneratorRunnerInput {
  /** ログラベル用途。Roadmap生成時点では実Taskが無いため、実IDを偽装しない。 */
  subjectId: string
  /** Roadmap生成プロンプト（API側が既存の`buildRoadmapProjectSummary()`等から組み立てる）。 */
  prompt: string
  /** 対象リポジトリのルート。Codexはここを読みながら生成する。 */
  workingDir: string
  /** 使用モデル。未指定ならCLI既定。 */
  model?: string
  /** 推論強度。未指定ならCLI設定に委ねる。 */
  reasoningEffort?: string
}

function readStdin(): string {
  return readFileSync(0, 'utf-8')
}

export async function runRoadmapGeneration(input: RoadmapGeneratorRunnerInput): Promise<string> {
  const adapter = createAiCliAdapter({ provider: 'codex' })

  const result = await adapter.run({
    // 実taskIdが無いので偽装せず、正直に接頭辞を付けたラベルを使う
    // （CodexReviewerAdapterと同じ方針）。
    taskId: `roadmap-generation:${input.subjectId}`,
    provider: 'codex',
    workingDir: input.workingDir,
    prompt: input.prompt,
    contextFiles: [],
    // implement以外＝`--sandbox read-only`。生成中に対象リポジトリを書き換えさせない。
    mode: 'review',
    expectJson: true,
    // 生成後にlintを走らせない（ファイルを書き換える副作用を持ちうるため）。
    postLint: false,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
  })

  if (result.blocked) {
    throw new Error(`[roadmapGeneratorRunner] guardにblockされました: ${result.stderr || result.stdout}`)
  }

  if (result.exitCode !== 0) {
    throw new Error(`[roadmapGeneratorRunner] Codex CLIが失敗しました: exitCode=${result.exitCode}`)
  }

  // `expectJson`により、codexAdapterは`--output-last-message`で最終回答を素のJSONとして
  // 取得する。取得できた場合はそれが権威（stdoutのnarrationを再parseしない）。
  if (result.parsedOutput !== undefined) {
    return JSON.stringify(result.parsedOutput)
  }

  return result.stdout
}

async function main(): Promise<void> {
  let input: RoadmapGeneratorRunnerInput
  try {
    input = JSON.parse(readStdin()) as RoadmapGeneratorRunnerInput
  } catch (err) {
    console.error(`[roadmapGeneratorRunner] 入力JSONの解析に失敗しました: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  try {
    process.stdout.write(await runRoadmapGeneration(input))
    process.exit(0)
  } catch (err) {
    // Roadmapが得られないことを「空のRoadmap」として下流へ流さない（fail-closed）。
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

// テストからのimportでは実行しない
if (process.argv[1]?.includes('roadmapGeneratorRunner')) {
  void main()
}
