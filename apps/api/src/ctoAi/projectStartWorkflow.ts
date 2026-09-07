/**
 * Project開始workflowのbackend所有化（2026-09-07）。
 *
 * 従来、Roadmap生成〜Review〜Task syncは`PATCH /api/projects/:id`のリクエスト内で
 * `await`されていた。Codexによる高reasoning生成とmulti-provider reviewで所要時間が
 * 数分規模になるため、この結合を切る。
 *
 * **durabilityの範囲（正確に）**:
 *   - client切断からの独立: 実処理はVPS側で走り続ける
 *   - stageの永続化: Mobileは`GET`でstageを読むだけ。**GETはProject-start stageを進めない**し、
 *     Mobileがpollしなくてもworkflowは完走する（livenessをclientに依存させない）。
 *     なお「GETが全面的にread-onlyである」とは主張しない — 既存のTask continuationは
 *     `GET /api/projects` / `GET /api/projects/:id` をretry driverとして使っており、その
 *     副作用は残っている（本変更が導入したものではない。roadmap項目
 *     `continuation-get-liveness-dependency`で別途対応する）
 *   - process再起動: 既存のAPI起動時recovery（`recoverAndRekickAtStartup`と同じ場所）で
 *     中断されたstartを再kickする
 *   - **前提: production APIは単一プロセス**。二重実行防止の`inFlight`はprocess-localであり、
 *     cross-processのdistributed lockではない。複数API instanceを走らせると、同じProjectの
 *     開始workflowが並行実行されうる（DB側の冪等性—`roadmapTaskKey`によるupsertと
 *     `workflowStepKey`によるJob dedupe—が最後の砦になるが、Roadmap生成は二重に走る）。
 *     multi-instance対応とdistributed lockは本変更の範囲外。
 *   - **保証しないこと**: プロセスが落ちたまま再起動しない間は進まない。定期再kickを
 *     持たないのは、新しいscheduler/cron/daemonを追加しないという既存の設計判断
 *     （`designReviewCoordinator.ts`に3箇所明記）に従うため。durabilityの等級は
 *     既存の`design_review_runs`と同じで、それ以上でも以下でもない。
 *
 * 新しいQueue / Daemon / Approval Gateは追加していない。
 */

import type { Project, ProjectStartStage } from '@ai-team/shared'
import type { IStorage } from '../storage/interface.js'
import {
  ensureInitialWorkflowsForActiveTasks,
  initializeApprovedProject,
  ProjectInitializationError,
  type ProjectInitializationOptions,
} from './projectInitialization.js'

/**
 * 同一プロセス内での二重kick防止。DBのstageだけでは、同じ瞬間に2つのkickが
 * 走り出すのを防げない（stage更新の前後に隙間がある）。
 *
 * これはprocess-localな重複防止であって永続的なlockではない。**正しさの最終的な担保は
 * DB側の冪等性**にある: `initializeApprovedProject()`はroadmapActiveなTaskが既にあれば
 * 呼ばれず、`syncRoadmapTasks()`は`roadmapTaskKey`でupsertするためTaskは重複しない。
 */
const inFlight = new Map<string, Promise<void>>()

export interface ProjectStartDeps {
  initialize?: typeof initializeApprovedProject
  ensureInitialWorkflows?: typeof ensureInitialWorkflowsForActiveTasks
}

function resolveTargetRoot(): string {
  return process.env.TARGET_ROOT ?? '/workspace/target'
}

/**
 * 既に現行Roadmapを持つProjectは開始workflowの対象外。
 * recovery経路とkick経路の両方から使う。
 */
function hasActiveRoadmap(storage: IStorage, projectId: string): boolean {
  return storage.tasks.findByProjectId(projectId).some((task) => task.roadmapActive)
}

/**
 * Project開始workflowを実行し、各段階でstageを永続化する。
 * リクエストからは`await`せずに呼ぶ（`kickProjectStart`経由）。
 */
async function runProjectStart(
  storage: IStorage,
  project: Project,
  options: ProjectInitializationOptions,
  deps: ProjectStartDeps,
): Promise<void> {
  const initialize = deps.initialize ?? initializeApprovedProject
  const setStage = (stage: ProjectStartStage, blockedReason?: string): void => {
    storage.projects.updateStartStage(project.id, stage, blockedReason)
  }

  try {
    await initialize(storage, project, resolveTargetRoot(), {
      ...options,
      onStage: (stage) => { setStage(stage) },
    })
    setStage('completed')
  } catch (error: unknown) {
    // fail-closed: 停止理由を残して`blocked`で止める。自動再開はしない。
    // Mobileを開き直したときに、この理由が「要CEO確認」として表示される。
    const reason = error instanceof ProjectInitializationError
      ? `${error.message}: ${JSON.stringify(error.details)}`
      : error instanceof Error
        ? error.message
        : String(error)
    setStage('blocked', reason)
  }
}

/**
 * 開始要求を受理し、workflowをHTTPリクエストから切り離して起動する。
 *
 * 呼び出し元はこれを`await`しない。戻り値は「受理したか」であり「完了したか」ではない。
 */
export function kickProjectStart(
  storage: IStorage,
  project: Project,
  options: ProjectInitializationOptions,
  deps: ProjectStartDeps = {},
): boolean {
  if (inFlight.has(project.id)) return false
  if (hasActiveRoadmap(storage, project.id)) return false

  // 受理した事実を、実処理が始まる前に永続化する。ここで落ちても
  // 「開始途中で中断された」ことがDBに残り、起動時recoveryの対象になる。
  storage.projects.updateStartStage(project.id, 'roadmap_generation')

  // 実行中のPromiseを保持するのは、テストが「切り離された処理」を決定的に待てるようにするため
  // （タイミング依存のテストでは非同期契約を検証できない）。本番経路はこれをawaitしない。
  const running = runProjectStart(storage, project, options, deps)
    .finally(() => { inFlight.delete(project.id) })
  inFlight.set(project.id, running)
  void running

  return true
}

/**
 * API起動時、前プロセスが残した中断中のProject開始workflowを再kickする。
 * 既存のDesign Review起動時recoveryと同じ場所・同じ方針で呼ぶ（新しいscheduler/cronは足さない）。
 *
 * `blocked`（CEO判断待ち）と`completed`は`findInterruptedStarts()`が返さないため、
 * 自動再開の対象にならない。
 */
export async function recoverInterruptedProjectStarts(
  storage: IStorage,
  deps: ProjectStartDeps = {},
): Promise<{ rekicked: string[]; resumed: string[] }> {
  const rekicked: string[] = []
  const resumed: string[] = []

  for (const project of storage.projects.findInterruptedStarts()) {
    // pause/archiveされたProjectは再開しない。
    if (project.status !== 'running') continue

    // 既にRoadmapがsync済みなら、**それを権威として扱い再生成しない**。
    // Roadmap GeneratorはLLMなので、再生成するとcrash前と別内容になりうる。そうなると
    // 旧Roadmap由来のTaskが非活性化され新Taskが作られる＝実質的な作り直しになってしまう。
    //
    // Task行の存在だけで完了扱いにもしない。`initializeApprovedProject()`はsync後に
    // docs書き込みと初回Job作成を行うため、そこでcrashするとTaskはあるがJobが無い状態が残る。
    // そこで、残っている安全な境界（初回Jobの保証）だけをresumeして完了させる。
    if (hasActiveRoadmap(storage, project.id)) {
      const resume = deps.ensureInitialWorkflows ?? ensureInitialWorkflowsForActiveTasks
      try {
        await resume(storage, project.id)
        storage.projects.updateStartStage(project.id, 'completed')
        resumed.push(project.id)
      } catch (error: unknown) {
        storage.projects.updateStartStage(
          project.id,
          'blocked',
          error instanceof Error ? error.message : String(error),
        )
      }
      continue
    }

    // Roadmapがまだ無い＝生成前に中断した。ここは頭から実行してよい（捨てる成果物が無い）。
    if (kickProjectStart(storage, project, { writeProjectMemory: true }, deps)) {
      rekicked.push(project.id)
    }
  }

  return { rekicked, resumed }
}

/**
 * テスト用: 切り離されたworkflowの完了を決定的に待つ。
 * これが無いとテストがmicrotaskのタイミング依存になり、非同期契約を検証できない。
 */
export async function awaitProjectStartForTest(projectId: string): Promise<void> {
  await inFlight.get(projectId)
}

/** テスト用: process-localな重複防止状態を初期化する。 */
export function resetInFlightProjectStartsForTest(): void {
  inFlight.clear()
}
