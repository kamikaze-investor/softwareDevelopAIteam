/**
 * Task detail screen for mobile CEO review.
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ApprovalGateStatus,
  ApprovalRequest,
  Job,
  JobStatus,
  RiskLevel,
  Task,
  TaskStatus,
} from '@ai-team/shared'
import { router, useLocalSearchParams } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

import { apiFetch } from '../../lib/api'

const RESUME_INSTRUCTION_MAX_LENGTH = 2000
const RESUME_HELP_TEXT =
  '元の停止した作業は履歴として残し、追加指示を含む新しい作業を開始します。危険な変更が含まれる場合は再び承認待ちになります。'
const RESUME_ERROR_MESSAGE_FALLBACK =
  '追加指示の送信に失敗しました。時間をおいて再度お試しください。'
const RESUME_ERROR_MESSAGE_BY_REASON: Record<string, string> = {
  'already exists for this task':
    '既に実行中または待機中の作業があるため、追加指示を送れませんでした。',
  'missing AI CLI':
    'AI実行設定が不足しているため、再開できませんでした。',
  'No jobs exist':
    '対象の作業履歴が見つからないため、再開できませんでした。',
  'not blocked':
    '現在は停止状態ではないため、追加指示を送れませんでした。',
  instruction: '入力内容を確認してください。',
  validation: '入力内容を確認してください。',
  'waiting for user review':
    '承認待ちの操作があるため、追加指示を送れませんでした。',
}

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  blocked: '停止中',
  done: '完了',
  in_progress: '進行中',
  pending: '未着手',
  review: 'レビュー中',
}

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  blocked: '停止中',
  failed: '失敗',
  queued: '待機中',
  running: '実行中',
  success: '完了',
}

const APPROVAL_STATUS_LABEL: Record<ApprovalGateStatus, string> = {
  APPROVED: '承認済み',
  CONSUMED: '反映済み',
  EXPIRED: '期限切れ',
  REJECTED: '却下により停止・追加指示待ち',
  STALE: '無効化',
  SUPERSEDED: '置き換え済み',
  WAITING_FOR_USER: '承認待ち',
}

const RISK_LEVEL_LABEL: Record<RiskLevel, string> = {
  CRITICAL: '危険度: 最重要',
  HIGH: '危険度: 高',
  LOW: '危険度: 低',
  MEDIUM: '危険度: 中',
}

const STATUS_TEXT_STYLE: Record<
  TaskStatus | JobStatus | ApprovalGateStatus,
  { color: string }
> = {
  APPROVED: { color: '#22c55e' },
  CONSUMED: { color: '#22c55e' },
  EXPIRED: { color: '#a3a3a3' },
  REJECTED: { color: '#ef4444' },
  STALE: { color: '#a3a3a3' },
  SUPERSEDED: { color: '#a3a3a3' },
  WAITING_FOR_USER: { color: '#f59e0b' },
  blocked: { color: '#f59e0b' },
  done: { color: '#22c55e' },
  failed: { color: '#ef4444' },
  in_progress: { color: '#60a5fa' },
  pending: { color: '#a3a3a3' },
  queued: { color: '#a3a3a3' },
  review: { color: '#a855f7' },
  running: { color: '#60a5fa' },
  success: { color: '#22c55e' },
}

const RISK_BADGE_STYLE: Record<
  RiskLevel,
  { backgroundColor: string; borderColor: string }
> = {
  CRITICAL: { backgroundColor: '#ef444422', borderColor: '#ef444466' },
  HIGH: { backgroundColor: '#f9731622', borderColor: '#f9731666' },
  LOW: { backgroundColor: '#22c55e22', borderColor: '#22c55e44' },
  MEDIUM: { backgroundColor: '#f59e0b22', borderColor: '#f59e0b55' },
}

const RISK_TEXT_STYLE: Record<RiskLevel, { color: string }> = {
  CRITICAL: { color: '#ef4444' },
  HIGH: { color: '#fb923c' },
  LOW: { color: '#22c55e' },
  MEDIUM: { color: '#f59e0b' },
}

const APPROVAL_STATUS_BADGE_STYLE: Record<
  ApprovalGateStatus,
  { backgroundColor: string; borderColor: string }
> = {
  APPROVED: { backgroundColor: '#22c55e22', borderColor: '#22c55e44' },
  CONSUMED: { backgroundColor: '#22c55e22', borderColor: '#22c55e44' },
  EXPIRED: { backgroundColor: '#73737322', borderColor: '#73737355' },
  REJECTED: { backgroundColor: '#ef444422', borderColor: '#ef444466' },
  STALE: { backgroundColor: '#73737322', borderColor: '#73737355' },
  SUPERSEDED: { backgroundColor: '#73737322', borderColor: '#73737355' },
  WAITING_FOR_USER: { backgroundColor: '#f59e0b22', borderColor: '#f59e0b66' },
}

const TRIGGERED_RULE_LABEL: Record<string, string> = {
  'AI instruction file': 'AIの行動ルールを定めるファイルの変更です',
  'CI/CD workflow change': '自動テスト・自動デプロイの仕組みに関わります',
  'DB migration / schema': 'データベース構造の変更に関わります',
  'alignment / gate change': '安全チェックの仕組み自体に関わります',
  'auth / permission guard': '認証・権限まわりの変更に関わります',
  'destructive operation': 'データ削除・破壊的操作の可能性があります',
  'docker / sandbox config': '実行環境・サンドボックス設定に関わります',
  'other risk factor detected': 'その他のリスク要因が検出されました',
  'payment / billing': '課金・支払いに関わる変更です',
  'secret suspected in diff': '秘密情報が含まれている可能性があります',
  'secrets / env / token': '秘密情報・APIキー等の扱いに関わります',
}

const UNKNOWN_TRIGGERED_RULE_LABEL =
  '未分類のリスク要因が検出されました'

interface TaskDetailData {
  task: Task
  jobs: Job[]
  approvalRequests: ApprovalRequest[]
}

async function fetchTask(taskId: string): Promise<Task | null> {
  const response = await apiFetch(
    `/api/tasks/${encodeURIComponent(taskId)}`,
  )

  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch task: ${response.status}`)
  }

  return (await response.json()) as Task
}

async function fetchJobs(taskId: string): Promise<Job[]> {
  const response = await apiFetch(
    `/api/jobs?taskId=${encodeURIComponent(taskId)}`,
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.status}`)
  }

  return (await response.json()) as Job[]
}

async function fetchApprovalRequests(
  taskId: string,
): Promise<ApprovalRequest[]> {
  const response = await apiFetch(
    `/api/approval-requests?taskId=${encodeURIComponent(taskId)}`,
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch approval requests: ${response.status}`)
  }

  return (await response.json()) as ApprovalRequest[]
}

function normalizeTaskId(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }

  return value ?? null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Failed to connect to API'
}

function parseDateTime(value: string): number {
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

function formatDateTime(value?: string): string {
  if (value === undefined) {
    return '未記録'
  }

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString()
}

function formatTaskStatus(status: string): string {
  return TASK_STATUS_LABEL[status as TaskStatus] ?? `状態: ${status}`
}

function formatJobStatus(status: string): string {
  return JOB_STATUS_LABEL[status as JobStatus] ?? `Job状態: ${status}`
}

function formatApprovalStatus(status: string): string {
  return (
    APPROVAL_STATUS_LABEL[status as ApprovalGateStatus] ??
    `承認状態: ${status}`
  )
}

function formatRiskLevel(riskLevel: string): string {
  return RISK_LEVEL_LABEL[riskLevel as RiskLevel] ?? `危険度: ${riskLevel}`
}

function formatTriggeredRule(rule: string): string {
  return TRIGGERED_RULE_LABEL[rule] ?? UNKNOWN_TRIGGERED_RULE_LABEL
}

function formatChangedFilesDetail(changedFiles: string[]): string {
  const head = changedFiles.slice(0, 8)
  const rest = changedFiles.length - head.length
  const joinedHead = head.join('\n')

  return rest > 0 ? `${joinedHead}\n他${rest}件` : joinedHead
}

function sortJobsByNewestFirst(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => {
    const aTime = parseDateTime(a.startedAt ?? a.createdAt)
    const bTime = parseDateTime(b.startedAt ?? b.createdAt)
    return bTime - aTime
  })
}

function sortApprovalRequestsByNewestFirst(
  approvalRequests: ApprovalRequest[],
): ApprovalRequest[] {
  return [...approvalRequests].sort(
    (a, b) => parseDateTime(b.createdAt) - parseDateTime(a.createdAt),
  )
}

// ────────────────────────────────────────────────────────────
// Job作成（実装 / 独立レビュー / 反映）
//
// workingDir はMobileから送信しない。API側（POST /api/jobs）が
// MVP-Aの正規workingDir（/workspace/target固定）をサーバー側で設定する。
// ────────────────────────────────────────────────────────────

/**
 * 独立レビューAIへ渡す固定プロンプト。
 * 対象は現在の未コミット差分のみ・コード変更禁止・出力は3000文字以内の
 * 固定フォーマットとする（MVP-Aポリシー）。
 */
const REVIEW_PROMPT = `あなたは独立したコードレビューAIです。

対象: 現在のworking treeにある未コミットの差分だけを確認してください。それ以外のファイルは見ないでください。
禁止: コードを変更しないでください。レビューのみを行ってください。

出力は次の形式で、3000文字以内にまとめてください:
【結論】(approve / changes_requested / reject のいずれか一つ)
【重大な問題】(無ければ「なし」)
【推奨対応】`

function isImplementJob(job: Job): boolean {
  return job.aiCliMode === 'implement'
}

function isReviewJob(job: Job): boolean {
  return job.aiCliMode === 'review'
}

function isJobBusy(jobs: Job[]): boolean {
  const latestJob = sortJobsByNewestFirst(jobs)[0]
  return latestJob?.status === 'queued' || latestJob?.status === 'running'
}

/** 実装Jobが少なくとも1件成功しているか（独立レビューJobを起票できるか） */
function canRunReview(jobs: Job[]): boolean {
  const latestImplement = sortJobsByNewestFirst(jobs).find(isImplementJob)
  return latestImplement?.status === 'success'
}

/**
 * 「変更を反映」を有効にする条件:
 *   最新の実装/レビュー関連Jobの中で最も新しいものが成功したレビューJobであり、
 *   かつそれより前に成功した実装Jobが存在すること
 *   （＝最新実装Jobがsuccess → その後の最新Review Jobがsuccess →
 *     Review後に新しい実装Jobが存在しない、と同値）。
 */
function canReflectChanges(jobs: Job[]): boolean {
  const relevant = sortJobsByNewestFirst(jobs).filter(
    (job) => isImplementJob(job) || isReviewJob(job),
  )
  const [newest] = relevant
  if (newest === undefined || !isReviewJob(newest) || newest.status !== 'success') {
    return false
  }
  const priorImplement = relevant.slice(1).find(isImplementJob)
  return priorImplement?.status === 'success'
}

interface CreateJobResult {
  ok: boolean
  message?: string
}

async function createTaskJob(
  taskId: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<CreateJobResult> {
  try {
    const response = await apiFetch('/api/jobs', {
      body: JSON.stringify({ projectId, taskId, ...body }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })

    if (response.status === 201) {
      return { ok: true }
    }

    return { ok: false, message: `作成に失敗しました（HTTP ${response.status}）` }
  } catch {
    return { ok: false, message: 'APIに接続できませんでした' }
  }
}

function canShowResumeUI(
  jobs: Job[],
  approvalRequests: ApprovalRequest[],
): boolean {
  // POST /api/tasks/:id/resume は最新Jobがblockedでない限り拒否するため、
  // UIの表示条件もAPIと同じく「最新Job」を基準にする（queued/running Jobの有無や
  // Task.status、古いREJECTEDだけでは判定しない）。
  const latestJob = sortJobsByNewestFirst(jobs)[0]

  if (latestJob?.status !== 'blocked') {
    return false
  }

  const latestApprovalRequest =
    sortApprovalRequestsByNewestFirst(approvalRequests)[0]

  if (latestApprovalRequest?.status === 'WAITING_FOR_USER') {
    return false
  }

  return true
}

async function readResumeApiError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : null
  } catch {
    return null
  }
}

function formatResumeErrorMessage(errorMessage: string | null): string {
  if (errorMessage === null || errorMessage.length === 0) {
    return RESUME_ERROR_MESSAGE_FALLBACK
  }

  const normalizedErrorMessage = errorMessage.toLowerCase()
  const matchingMessage = Object.entries(RESUME_ERROR_MESSAGE_BY_REASON).find(
    ([reason]) => normalizedErrorMessage.includes(reason.toLowerCase()),
  )

  return matchingMessage?.[1] ?? RESUME_ERROR_MESSAGE_FALLBACK
}

async function postResumeInstruction(
  taskId: string,
  instruction: string,
): Promise<{ message: string; ok: false } | { ok: true }> {
  try {
    const response = await apiFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/resume`,
      {
        body: JSON.stringify({ instruction }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    )

    if (response.status === 201) {
      return { ok: true }
    }

    const errorMessage = await readResumeApiError(response)
    return { message: formatResumeErrorMessage(errorMessage), ok: false }
  } catch {
    return { message: RESUME_ERROR_MESSAGE_FALLBACK, ok: false }
  }
}

function TaskInfoSection({ task }: { task: Task }): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Task情報</Text>
      <View style={styles.infoBox}>
        <Text style={styles.detailLabel}>説明</Text>
        <Text style={styles.bodyText}>
          {task.description.length > 0 ? task.description : '説明なし'}
        </Text>

        <Text style={styles.detailLabel}>状態</Text>
        <Text
          style={[
            styles.statusText,
            STATUS_TEXT_STYLE[task.status] ?? styles.statusTextFallback,
          ]}
        >
          {formatTaskStatus(task.status)}
        </Text>
      </View>
    </View>
  )
}

interface ResumeInstructionSectionProps {
  approvalRequests: ApprovalRequest[]
  instruction: string
  isEditorOpen: boolean
  isSubmitting: boolean
  jobs: Job[]
  onChangeInstruction: (instruction: string) => void
  onOpen: () => void
  onSubmit: () => void
}

function ResumeInstructionSection({
  approvalRequests,
  instruction,
  isEditorOpen,
  isSubmitting,
  jobs,
  onChangeInstruction,
  onOpen,
  onSubmit,
}: ResumeInstructionSectionProps): ReactElement | null {
  if (!canShowResumeUI(jobs, approvalRequests)) {
    return null
  }

  const trimmedInstruction = instruction.trim()
  const isSubmitDisabled =
    trimmedInstruction.length === 0 || isSubmitting

  if (!isEditorOpen) {
    return (
      <View style={styles.section}>
        <TouchableOpacity
          onPress={onOpen}
          style={styles.resumeOpenButton}
        >
          <Text style={styles.resumeOpenButtonText}>追加指示を出す</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <View style={styles.resumeBox}>
        <Text style={styles.resumeHelpText}>{RESUME_HELP_TEXT}</Text>
        <TextInput
          editable={!isSubmitting}
          maxLength={RESUME_INSTRUCTION_MAX_LENGTH}
          multiline
          onChangeText={onChangeInstruction}
          placeholder="追加指示を入力"
          placeholderTextColor="#737373"
          style={styles.resumeInput}
          textAlignVertical="top"
          value={instruction}
        />
        <View style={styles.resumeFooter}>
          <Text style={styles.resumeCounter}>
            {instruction.length}/{RESUME_INSTRUCTION_MAX_LENGTH}
          </Text>
          <TouchableOpacity
            disabled={isSubmitDisabled}
            onPress={onSubmit}
            style={[
              styles.resumeSubmitButton,
              isSubmitDisabled && styles.resumeSubmitButtonDisabled,
            ]}
          >
            {isSubmitting && (
              <ActivityIndicator color="#fff" size="small" />
            )}
            <Text style={styles.resumeSubmitButtonText}>
              追加指示して再開
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  )
}

type JobActionKind = 'implement' | 'review' | 'reflect'

function latestAiCliProvider(jobs: Job[]): Job['aiCliProvider'] {
  return sortJobsByNewestFirst(jobs).find(isImplementJob)?.aiCliProvider
}

function JobActionsSection({
  jobs,
  onCreated,
  task,
}: {
  jobs: Job[]
  onCreated: () => void
  task: Task
}): ReactElement {
  const [runningAction, setRunningAction] = useState<JobActionKind | null>(null)

  const busy = isJobBusy(jobs)
  const reviewEnabled = !busy && canRunReview(jobs)
  const reflectEnabled = !busy && canReflectChanges(jobs)

  const runAction = useCallback(
    async (kind: JobActionKind, body: Record<string, unknown>): Promise<void> => {
      setRunningAction(kind)
      try {
        const result = await createTaskJob(task.id, task.projectId, body)
        if (!result.ok) {
          Alert.alert('作成失敗', result.message ?? '作業を開始できませんでした')
          return
        }
        onCreated()
      } finally {
        setRunningAction(null)
      }
    },
    [task.id, task.projectId, onCreated],
  )

  const handleImplement = useCallback((): void => {
    void runAction('implement', {
      agentRole: 'developer_ai',
      aiCliMode: 'implement',
      aiCliPrompt: task.description,
      aiCliProvider: 'claude_code',
      safeCommand: { kind: 'test' },
    })
  }, [runAction, task.description])

  const handleReview = useCallback((): void => {
    void runAction('review', {
      agentRole: 'qa_ai',
      aiCliMode: 'review',
      aiCliPrompt: REVIEW_PROMPT,
      aiCliProvider: latestAiCliProvider(jobs) ?? 'claude_code',
      safeCommand: { kind: 'git_status' },
    })
  }, [runAction, jobs])

  const handleReflect = useCallback((): void => {
    Alert.alert('変更を反映', 'レビュー済みの変更を反映しますか？CEO承認が必要な場合は承認待ちになります。', [
      { style: 'cancel', text: 'キャンセル' },
      {
        onPress: () => {
          void runAction('reflect', {
            agentRole: 'developer_ai',
            safeCommand: {
              kind: 'git_commit',
              params: { commitMessage: task.title },
            },
          })
        },
        text: '反映する',
      },
    ])
  }, [runAction, task.title])

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>作業</Text>

      <TouchableOpacity
        disabled={busy}
        onPress={handleImplement}
        style={[styles.actionButton, styles.actionButtonImplement, busy && styles.actionButtonDisabled]}
      >
        {runningAction === 'implement' && <ActivityIndicator color="#fff" size="small" />}
        <Text style={styles.actionButtonText}>実装を開始</Text>
      </TouchableOpacity>

      <TouchableOpacity
        disabled={!reviewEnabled}
        onPress={handleReview}
        style={[
          styles.actionButton,
          styles.actionButtonReview,
          !reviewEnabled && styles.actionButtonDisabled,
        ]}
      >
        {runningAction === 'review' && <ActivityIndicator color="#fff" size="small" />}
        <Text style={styles.actionButtonText}>独立レビューを実行</Text>
      </TouchableOpacity>

      <TouchableOpacity
        disabled={!reflectEnabled}
        onPress={handleReflect}
        style={[
          styles.actionButton,
          styles.actionButtonReflect,
          !reflectEnabled && styles.actionButtonDisabled,
        ]}
      >
        {runningAction === 'reflect' && <ActivityIndicator color="#fff" size="small" />}
        <Text style={styles.actionButtonText}>変更を反映</Text>
      </TouchableOpacity>
      {!reflectEnabled && !busy && (
        <Text style={styles.actionHelpText}>独立レビュー完了後に反映できます</Text>
      )}
    </View>
  )
}

function JobHistorySection({ jobs }: { jobs: Job[] }): ReactElement {
  const sortedJobs = useMemo(() => sortJobsByNewestFirst(jobs), [jobs])

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Job履歴</Text>

      {sortedJobs.length === 0 && (
        <Text style={styles.sectionEmpty}>実行履歴なし</Text>
      )}

      {sortedJobs.map((job) => (
        <View key={job.id} style={styles.card}>
          <View style={styles.cardTop}>
            <Text
              style={[
                styles.statusText,
                STATUS_TEXT_STYLE[job.status] ?? styles.statusTextFallback,
              ]}
            >
              {formatJobStatus(job.status)}
            </Text>
            <Text style={styles.idText} numberOfLines={1}>
              {job.id}
            </Text>
          </View>

          <Text style={styles.metaText}>
            開始: {formatDateTime(job.startedAt ?? job.createdAt)}
          </Text>
          <Text style={styles.metaText}>
            完了: {formatDateTime(job.completedAt)}
          </Text>
          {job.exitCode !== undefined && (
            <Text style={styles.metaText}>exitCode: {job.exitCode}</Text>
          )}
          {job.changedFiles !== undefined && job.changedFiles.length > 0 && (
            <>
              <Text style={styles.detailLabel}>変更ファイル</Text>
              <Text style={styles.fileListText}>
                {formatChangedFilesDetail(job.changedFiles)}
              </Text>
            </>
          )}
          {job.stdout !== undefined && job.stdout.length > 0 && (
            <>
              <Text style={styles.detailLabel}>出力</Text>
              <Text style={styles.outputText}>{job.stdout}</Text>
            </>
          )}
          {job.stderr !== undefined && job.stderr.length > 0 && (
            <>
              <Text style={styles.detailLabel}>エラー出力</Text>
              <Text style={[styles.outputText, styles.outputTextError]}>
                {job.stderr}
              </Text>
            </>
          )}
        </View>
      ))}
    </View>
  )
}

function ApprovalHistorySection({
  approvalRequests,
}: {
  approvalRequests: ApprovalRequest[]
}): ReactElement {
  const sortedApprovalRequests = useMemo(
    () => sortApprovalRequestsByNewestFirst(approvalRequests),
    [approvalRequests],
  )

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>このTaskに関する承認履歴</Text>
      <Text style={styles.sectionDescription}>
        承認履歴はTask単位の関連情報です。特定Jobとの1対1対応は追跡していません。
      </Text>

      {sortedApprovalRequests.length === 0 && (
        <Text style={styles.sectionEmpty}>承認履歴はありません</Text>
      )}

      {sortedApprovalRequests.map((approvalRequest) => {
        const changedFiles = approvalRequest.changedFiles ?? []
        const triggeredRules = approvalRequest.triggeredRules ?? []
        const statusBadgeStyle =
          APPROVAL_STATUS_BADGE_STYLE[approvalRequest.status]
        const statusTextStyle =
          STATUS_TEXT_STYLE[approvalRequest.status] ?? styles.statusTextFallback

        return (
          <View key={approvalRequest.id} style={styles.card}>
            <View style={styles.cardTop}>
              <View style={[styles.statusBadge, statusBadgeStyle]}>
                <Text style={[styles.statusBadgeText, statusTextStyle]}>
                  {formatApprovalStatus(approvalRequest.status)}
                </Text>
              </View>
              <Text style={styles.idText} numberOfLines={1}>
                {approvalRequest.id}
              </Text>
            </View>

            <View
              style={[
                styles.riskBadge,
                RISK_BADGE_STYLE[approvalRequest.riskLevel],
              ]}
            >
              <Text
                style={[
                  styles.riskText,
                  RISK_TEXT_STYLE[approvalRequest.riskLevel],
                ]}
              >
                {formatRiskLevel(approvalRequest.riskLevel)}
              </Text>
            </View>

            <Text style={styles.detailLabel}>requestedAction</Text>
            <Text style={styles.bodyText}>{approvalRequest.requestedAction}</Text>

            <Text style={styles.detailLabel}>検出ルール</Text>
            {triggeredRules.length === 0 ? (
              <Text style={styles.metaText}>なし</Text>
            ) : (
              triggeredRules.map((rule, index) => (
                <Text key={`${rule}-${index}`} style={styles.metaText}>
                  ・{formatTriggeredRule(rule)}
                </Text>
              ))
            )}

            <Text style={styles.detailLabel}>変更ファイル</Text>
            {changedFiles.length === 0 ? (
              <Text style={styles.metaText}>なし</Text>
            ) : (
              <Text style={styles.fileListText}>
                {formatChangedFilesDetail(changedFiles)}
              </Text>
            )}

            <Text style={styles.metaText}>
              作成: {formatDateTime(approvalRequest.createdAt)}
            </Text>
            <Text style={styles.metaText}>
              期限: {formatDateTime(approvalRequest.expiresAt)}
            </Text>
          </View>
        )
      })}
    </View>
  )
}

export default function TaskDetailScreen(): ReactElement {
  const params = useLocalSearchParams()
  const taskId = normalizeTaskId(params.id)
  const [data, setData] = useState<TaskDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [resumeInstruction, setResumeInstruction] = useState('')
  const [isResumeEditorOpen, setIsResumeEditorOpen] = useState(false)
  const [isSubmittingResumeInstruction, setIsSubmittingResumeInstruction] =
    useState(false)

  const loadTaskDetail = useCallback(async (): Promise<void> => {
    if (taskId === null || taskId.length === 0) {
      setError('Task IDが指定されていません')
      setLoading(false)
      return
    }

    try {
      setError(null)
      setNotFound(false)

      // ApprovalRequestはtaskId単位の関連履歴であり、現状Jobとの厳密な1対1対応は追跡していない。
      // 詳細画面では3APIを並列に各1回だけ取得し、Job単位の追加fetchは行わない。
      const [taskResult, jobsResult, approvalRequestsResult] =
        await Promise.allSettled([
          fetchTask(taskId),
          fetchJobs(taskId),
          fetchApprovalRequests(taskId),
        ])

      if (taskResult.status === 'rejected') {
        throw taskResult.reason
      }

      if (taskResult.value === null) {
        setData(null)
        setNotFound(true)
        return
      }

      if (jobsResult.status === 'rejected') {
        throw jobsResult.reason
      }

      if (approvalRequestsResult.status === 'rejected') {
        throw approvalRequestsResult.reason
      }

      setData({
        approvalRequests: approvalRequestsResult.value,
        jobs: jobsResult.value,
        task: taskResult.value,
      })
    } catch (loadError) {
      const message = getErrorMessage(loadError)
      setError(message)
      Alert.alert('エラー', 'Task詳細の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    void loadTaskDetail()
  }, [loadTaskDetail])

  const submitResumeInstruction = useCallback(
    async (trimmedInstruction: string): Promise<void> => {
      if (taskId === null || taskId.length === 0) {
        Alert.alert(
          '送信失敗',
          'Task IDが指定されていないため、追加指示を送れませんでした。',
        )
        return
      }

      try {
        setIsSubmittingResumeInstruction(true)
        const result = await postResumeInstruction(taskId, trimmedInstruction)

        if (!result.ok) {
          Alert.alert('送信失敗', result.message)
          return
        }

        setResumeInstruction('')
        setIsResumeEditorOpen(false)
        Alert.alert(
          '追加指示して再開',
          '追加指示を受け付け、新しい作業を開始しました',
        )
        await loadTaskDetail()
      } finally {
        setIsSubmittingResumeInstruction(false)
      }
    },
    [loadTaskDetail, taskId],
  )

  const handleSubmitResumeInstruction = useCallback((): void => {
    const trimmedInstruction = resumeInstruction.trim()

    if (trimmedInstruction.length === 0 || isSubmittingResumeInstruction) {
      return
    }

    Alert.alert(
      '追加指示して再開',
      '追加指示を送信して新しい作業を開始しますか？',
      [
        { style: 'cancel', text: 'キャンセル' },
        {
          onPress: () => {
            void submitResumeInstruction(trimmedInstruction)
          },
          text: '送信',
        },
      ],
    )
  }, [
    isSubmittingResumeInstruction,
    resumeInstruction,
    submitResumeInstruction,
  ])

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#3b82f6" size="large" />
      </View>
    )
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.back}>
          <Text style={styles.backText}>← 戻る</Text>
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={2}>
          {data?.task.title ?? 'Task詳細'}
        </Text>
      </View>

      {error !== null && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {notFound && error === null && (
        <Text style={styles.empty}>Taskが見つかりません</Text>
      )}

      {data !== null && (
        <>
          <TaskInfoSection task={data.task} />
          <JobActionsSection
            jobs={data.jobs}
            onCreated={() => void loadTaskDetail()}
            task={data.task}
          />
          <ResumeInstructionSection
            approvalRequests={data.approvalRequests}
            instruction={resumeInstruction}
            isEditorOpen={isResumeEditorOpen}
            isSubmitting={isSubmittingResumeInstruction}
            jobs={data.jobs}
            onChangeInstruction={setResumeInstruction}
            onOpen={() => setIsResumeEditorOpen(true)}
            onSubmit={handleSubmitResumeInstruction}
          />
          <JobHistorySection jobs={data.jobs} />
          <ApprovalHistorySection
            approvalRequests={data.approvalRequests}
          />
        </>
      )}

      <View style={styles.bottomSpacer} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  back: {
    marginRight: 12,
    paddingVertical: 4,
  },
  backText: {
    color: '#3b82f6',
    fontSize: 15,
  },
  actionButton: {
    alignItems: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginBottom: 10,
    padding: 12,
  },
  actionButtonImplement: {
    backgroundColor: '#2563eb',
  },
  actionButtonReview: {
    backgroundColor: '#7c3aed',
  },
  actionButtonReflect: {
    backgroundColor: '#16a34a',
  },
  actionButtonDisabled: {
    backgroundColor: '#262626',
    opacity: 0.6,
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  actionHelpText: {
    color: '#737373',
    fontSize: 12,
    marginTop: -4,
    textAlign: 'center',
  },
  bodyText: {
    color: '#d4d4d4',
    fontSize: 14,
    lineHeight: 20,
  },
  bottomSpacer: {
    height: 40,
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    marginBottom: 12,
    padding: 16,
  },
  cardTop: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  center: {
    alignItems: 'center',
    backgroundColor: '#0a0a0a',
    flex: 1,
    justifyContent: 'center',
  },
  container: {
    backgroundColor: '#0a0a0a',
    flex: 1,
    padding: 16,
  },
  detailLabel: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 6,
    marginTop: 10,
  },
  empty: {
    color: '#737373',
    fontSize: 16,
    marginTop: 60,
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: '#2a1515',
    borderRadius: 8,
    marginBottom: 12,
    padding: 12,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  fileListText: {
    color: '#a3a3a3',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    marginBottom: 20,
    marginTop: 52,
  },
  idText: {
    color: '#737373',
    flex: 1,
    fontSize: 12,
    textAlign: 'right',
  },
  infoBox: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  metaText: {
    color: '#a3a3a3',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 4,
  },
  outputText: {
    backgroundColor: '#0f0f0f',
    borderColor: '#2a2a2a',
    borderRadius: 6,
    borderWidth: 1,
    color: '#d4d4d4',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 4,
    padding: 10,
  },
  outputTextError: {
    borderColor: '#ef444444',
    color: '#fca5a5',
  },
  resumeBox: {
    backgroundColor: '#141414',
    borderColor: '#2a2a2a',
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  resumeCounter: {
    color: '#737373',
    flex: 1,
    fontSize: 12,
  },
  resumeFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    marginTop: 10,
  },
  resumeHelpText: {
    color: '#d4d4d4',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
  },
  resumeInput: {
    backgroundColor: '#0f0f0f',
    borderColor: '#333',
    borderRadius: 8,
    borderWidth: 1,
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
    minHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  resumeOpenButton: {
    alignItems: 'center',
    backgroundColor: '#1d4ed8',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  resumeOpenButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  resumeSubmitButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  resumeSubmitButtonDisabled: {
    backgroundColor: '#262626',
    opacity: 0.7,
  },
  resumeSubmitButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  riskBadge: {
    alignSelf: 'flex-start',
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  riskText: {
    fontSize: 11,
    fontWeight: '700',
  },
  section: {
    marginBottom: 20,
  },
  sectionDescription: {
    color: '#a3a3a3',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  sectionEmpty: {
    color: '#737373',
    fontSize: 14,
    marginBottom: 12,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 10,
  },
  statusBadge: {
    borderRadius: 6,
    borderWidth: 1,
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  statusText: {
    color: '#d4d4d4',
    fontSize: 14,
    fontWeight: '700',
  },
  statusTextFallback: {
    color: '#d4d4d4',
  },
  title: {
    color: '#fff',
    flex: 1,
    fontSize: 22,
    fontWeight: 'bold',
    lineHeight: 28,
  },
})
