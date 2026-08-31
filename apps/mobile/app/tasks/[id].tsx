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
  TaskFailureClassification,
  TaskFailureExplanationResponse,
  TaskFailureFacts,
  TaskFailureQuestionResponse,
  TaskFailureQuestionTurn,
  TaskStatus,
} from '@ai-team/shared'
import { router, useLocalSearchParams } from 'expo-router'
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

import { apiFetch } from '../../lib/api'
import {
  canReflectChanges,
  canRunReview,
  canShowResumeUI,
  isImplementJob,
  isJobBusy,
  isReviewJob,
  manualWorkflowIsLocked,
  parseDateTime,
  sortJobsByNewestFirst,
} from '../../lib/taskWorkflow'
import { POLLING_INTERVAL_MS, usePolling } from '../../lib/usePolling'

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
  'git_commit requires CEO approval (policy)': '変更の反映にはCEO承認が必要です',
  'other risk factor detected': 'その他のリスク要因が検出されました',
  'payment / billing': '課金・支払いに関わる変更です',
  'secret suspected in diff': '秘密情報が含まれている可能性があります',
  'secrets / env / token': '秘密情報・APIキー等の扱いに関わります',
}

const UNKNOWN_TRIGGERED_RULE_LABEL =
  '未分類のリスク要因が検出されました'

const TASK_FAILURE_CLASSIFICATION_LABEL: Record<
  TaskFailureClassification,
  string
> = {
  approval_or_policy: 'Approval・方針に関する可能性',
  code: 'コード問題の可能性',
  configuration: '設定問題の可能性',
  environment: '環境問題の可能性',
  permission_or_safety: '権限・安全停止に関する可能性',
  unknown: '分類できません',
}

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

async function fetchTaskFailureExplanation(
  taskId: string,
): Promise<TaskFailureExplanationResponse> {
  try {
    const response = await apiFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/failure-explanation`,
      { method: 'POST' },
    )
    if (!response.ok) {
      throw new Error(`Failed to fetch Task failure explanation: ${response.status}`)
    }
    return (await response.json()) as TaskFailureExplanationResponse
  } catch {
    return { ok: false, error: 'AIによる分析を生成できませんでした' }
  }
}

async function askTaskFailureQuestion(
  taskId: string,
  question: string,
  history: TaskFailureQuestionTurn[],
): Promise<TaskFailureQuestionResponse> {
  try {
    const response = await apiFetch(
      `/api/tasks/${encodeURIComponent(taskId)}/failure-ask`,
      {
        body: JSON.stringify({ history: history.slice(-20), question }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    )
    if (!response.ok) {
      throw new Error(`Failed to ask Task failure question: ${response.status}`)
    }
    return (await response.json()) as TaskFailureQuestionResponse
  } catch {
    return { ok: false, error: 'AIから回答を取得できませんでした' }
  }
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

function formatGuardResult(facts: TaskFailureFacts): string {
  const guardResult = facts.guardResult
  if (guardResult === null) return '記録なし'

  const lines = [
    `権限チェック: ${guardResult.permissionAllowed ? '通過' : '停止'}`,
    `ファイル変更チェック: ${guardResult.fileChangeAllowed ? '通過' : '停止'}`,
  ]
  if (guardResult.permissionReason !== undefined) {
    lines.push(`権限チェック理由: ${guardResult.permissionReason}`)
  }
  if (
    guardResult.fileViolations !== undefined &&
    guardResult.fileViolations.length > 0
  ) {
    lines.push(`対象外ファイル:\n${formatChangedFilesDetail(guardResult.fileViolations)}`)
  }
  return lines.join('\n')
}

function TaskFailureFactsView({ facts }: { facts: TaskFailureFacts }): ReactElement {
  return (
    <View style={styles.failureFactsBox}>
      <Text style={styles.failureFactsTitle}>事実情報（何が起きたか）</Text>
      <Text style={styles.bodyText}>{facts.whatHappened}</Text>

      <Text style={styles.detailLabel}>Task / Job状態</Text>
      <Text style={styles.metaText}>
        {formatTaskStatus(facts.taskStatus)} / {formatJobStatus(facts.jobStatus)}
      </Text>

      <Text style={styles.detailLabel}>実行種別</Text>
      <Text style={styles.metaText}>{facts.safeCommandKind}</Text>

      <Text style={styles.detailLabel}>exitCode</Text>
      <Text style={styles.metaText}>
        {facts.exitCode === null ? '記録なし' : facts.exitCode}
      </Text>

      <Text style={styles.detailLabel}>変更ファイル</Text>
      <Text style={styles.fileListText}>
        {facts.changedFiles.length === 0
          ? 'なし'
          : formatChangedFilesDetail(facts.changedFiles)}
      </Text>

      <Text style={styles.detailLabel}>安全チェック結果</Text>
      <Text style={styles.metaText}>{formatGuardResult(facts)}</Text>

      {facts.stderrExcerpt !== null && (
        <>
          <Text style={styles.detailLabel}>エラー出力（記録された事実）</Text>
          <Text style={[styles.outputText, styles.outputTextError]}>
            {facts.stderrExcerpt}
          </Text>
        </>
      )}

      {facts.stdoutExcerpt !== null && (
        <>
          <Text style={styles.detailLabel}>標準出力（記録された事実）</Text>
          <Text style={styles.outputText}>{facts.stdoutExcerpt}</Text>
        </>
      )}
    </View>
  )
}

function TaskFailureQuestionModal({
  error,
  loading,
  onCancel,
  onChangeQuestion,
  onSubmit,
  question,
  turns,
  visible,
}: {
  error: string | null
  loading: boolean
  onCancel: () => void
  onChangeQuestion: (value: string) => void
  onSubmit: () => void
  question: string
  turns: TaskFailureQuestionTurn[]
  visible: boolean
}): ReactElement {
  const canSubmit = question.trim().length > 0 && !loading

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={visible}>
      <View style={styles.modalOverlay}>
        <View style={styles.questionModalBox}>
          <Text style={styles.modalTitle}>AIに質問する</Text>
          <Text style={styles.questionHelpText}>
            この画面を閉じるまでの履歴だけを送信します。AIの回答には推測が含まれる場合があります。
          </Text>

          {turns.length > 0 && (
            <ScrollView style={styles.questionHistory}>
              {turns.map((turn, index) => (
                <View
                  key={`${turn.role}-${index}`}
                  style={[
                    styles.questionTurn,
                    turn.role === 'user'
                      ? styles.questionTurnUser
                      : styles.questionTurnAssistant,
                  ]}
                >
                  <Text style={styles.questionTurnLabel}>
                    {turn.role === 'user' ? 'CEO' : 'AI（AIによる分析を含む）'}
                  </Text>
                  <Text style={styles.questionTurnText}>{turn.content}</Text>
                </View>
              ))}
            </ScrollView>
          )}

          {error !== null && <Text style={styles.failureAiErrorText}>{error}</Text>}

          <TextInput
            editable={!loading}
            maxLength={2_000}
            multiline
            onChangeText={onChangeQuestion}
            placeholder="例: これはコード問題ですか？"
            placeholderTextColor="#555"
            style={styles.questionInput}
            textAlignVertical="top"
            value={question}
          />

          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onCancel} style={styles.modalCancelButton}>
              <Text style={styles.modalCancelButtonText}>閉じる</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!canSubmit}
              onPress={onSubmit}
              style={[
                styles.questionSubmitButton,
                !canSubmit && styles.questionSubmitButtonDisabled,
              ]}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.questionSubmitButtonText}>質問する</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

function TaskFailureExplanationSection({
  jobs,
  task,
}: {
  jobs: Job[]
  task: Task
}): ReactElement | null {
  const latestJob = useMemo(() => sortJobsByNewestFirst(jobs)[0], [jobs])
  const shouldShow = latestJob?.status === 'failed' || task.status === 'blocked'
  const explanationKey = shouldShow
    ? `${task.id}:${task.status}:${latestJob?.id ?? 'no-job'}`
    : null
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TaskFailureExplanationResponse | null>(null)
  const [questionOpen, setQuestionOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [questionLoading, setQuestionLoading] = useState(false)
  const [questionError, setQuestionError] = useState<string | null>(null)
  const [turns, setTurns] = useState<TaskFailureQuestionTurn[]>([])

  useEffect(() => {
    if (explanationKey === null) {
      setResult(null)
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    setResult(null)
    setQuestionOpen(false)
    setQuestion('')
    setQuestionError(null)
    setTurns([])
    void fetchTaskFailureExplanation(task.id).then((nextResult) => {
      if (!active) return
      setResult(nextResult)
      setLoading(false)
    })

    return () => {
      active = false
    }
  }, [explanationKey, task.id])

  if (!shouldShow) return null

  function closeQuestionModal(): void {
    if (questionLoading) return
    setQuestionOpen(false)
    setQuestion('')
    setQuestionError(null)
  }

  async function submitQuestion(): Promise<void> {
    const trimmedQuestion = question.trim()
    if (trimmedQuestion.length === 0 || questionLoading) return

    setQuestionLoading(true)
    setQuestionError(null)
    const answer = await askTaskFailureQuestion(task.id, trimmedQuestion, turns)
    setQuestionLoading(false)
    if (!answer.ok) {
      setQuestionError('AIから回答を取得できませんでした')
      return
    }

    setTurns((current) => [
      ...current,
      { role: 'user', content: trimmedQuestion },
      { role: 'assistant', content: answer.answer },
    ])
    setQuestion('')
  }

  const title = task.status === 'blocked'
    ? '停止中／要対応の説明'
    : '実行失敗の説明'

  return (
    <>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {task.status === 'blocked' && (
          <Text style={styles.failureStatusDescription}>
            Approval待ち・安全停止等を含むため、停止中であることだけで失敗とは断定しません。
          </Text>
        )}

        {loading && (
          <View style={styles.failureAiLoading}>
            <ActivityIndicator color="#60a5fa" size="small" />
            <Text style={styles.metaText}>事実情報とAI分析を読み込んでいます</Text>
          </View>
        )}

        {result !== null && !result.ok && (
          <View style={styles.failureAiErrorBox}>
            <Text style={styles.failureAiErrorText}>
              AIによる分析を取得できませんでした。Task情報・Job履歴・再開機能は引き続き利用できます。
            </Text>
          </View>
        )}

        {result?.ok === true && (
          <>
            <TaskFailureFactsView facts={result.explanation.facts} />
            <View style={styles.aiAnalysisBox}>
              <Text style={styles.aiAnalysisTitle}>AIによる分析（推測を含みます）</Text>
              <Text style={styles.aiAnalysisDisclaimer}>
                以下は記録された事実を基にしたAIの分析であり、確定した原因ではありません。
              </Text>

              <Text style={styles.detailLabel}>分類</Text>
              <Text style={styles.bodyText}>
                {TASK_FAILURE_CLASSIFICATION_LABEL[
                  result.explanation.aiAnalysis.classification
                ]}
              </Text>

              <Text style={styles.detailLabel}>推定原因</Text>
              <Text style={styles.bodyText}>
                {result.explanation.aiAnalysis.likelyCause}
              </Text>

              <Text style={styles.detailLabel}>影響</Text>
              <Text style={styles.bodyText}>
                {result.explanation.aiAnalysis.impact}
              </Text>

              <Text style={styles.detailLabel}>推奨する次の対応</Text>
              <Text style={styles.bodyText}>
                {result.explanation.aiAnalysis.recommendedNextAction}
              </Text>
            </View>
          </>
        )}

        {!loading && (
          <TouchableOpacity
            onPress={() => {
              setQuestionError(null)
              setQuestionOpen(true)
            }}
            style={styles.failureQuestionButton}
          >
            <Text style={styles.failureQuestionButtonText}>AIに質問する</Text>
          </TouchableOpacity>
        )}
      </View>

      <TaskFailureQuestionModal
        error={questionError}
        loading={questionLoading}
        onCancel={closeQuestionModal}
        onChangeQuestion={setQuestion}
        onSubmit={() => void submitQuestion()}
        question={question}
        turns={turns}
        visible={questionOpen}
      />
    </>
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
  task: Task
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
  task,
}: ResumeInstructionSectionProps): ReactElement | null {
  if (!canShowResumeUI(task, jobs, approvalRequests)) {
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
  approvalRequests,
  jobs,
  onCreated,
  task,
}: {
  approvalRequests: ApprovalRequest[]
  jobs: Job[]
  onCreated: () => void
  task: Task
}): ReactElement {
  const [runningAction, setRunningAction] = useState<JobActionKind | null>(null)

  const actionsLocked = runningAction !== null || manualWorkflowIsLocked(jobs, approvalRequests)
  const reviewEnabled = runningAction === null && canRunReview(jobs, approvalRequests)
  const reflectEnabled = runningAction === null && canReflectChanges(jobs, approvalRequests)

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
        disabled={actionsLocked}
        onPress={handleImplement}
        style={[
          styles.actionButton,
          styles.actionButtonImplement,
          actionsLocked && styles.actionButtonDisabled,
        ]}
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
      {!reflectEnabled && !actionsLocked && (
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
        変更反映の承認後は、承認済みのJobが自動的に反映待ちへ戻ります。
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

  const pollingEnabled =
    data === null ||
    isJobBusy(data.jobs) ||
    sortJobsByNewestFirst(data.jobs)[0]?.status === 'blocked'

  usePolling(loadTaskDetail, {
    intervalMs: POLLING_INTERVAL_MS,
    enabled: pollingEnabled,
  })

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
          <TaskFailureExplanationSection
            jobs={data.jobs}
            task={data.task}
          />
          <JobActionsSection
            approvalRequests={data.approvalRequests}
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
            task={data.task}
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
  aiAnalysisBox: {
    backgroundColor: '#111827',
    borderColor: '#3b82f655',
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 12,
    padding: 14,
  },
  aiAnalysisDisclaimer: {
    color: '#93c5fd',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 4,
  },
  aiAnalysisTitle: {
    color: '#60a5fa',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 6,
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
  failureAiErrorBox: {
    backgroundColor: '#2a1515',
    borderColor: '#ef444444',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  failureAiErrorText: {
    color: '#fca5a5',
    fontSize: 13,
    lineHeight: 19,
  },
  failureAiLoading: {
    alignItems: 'center',
    backgroundColor: '#141414',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 10,
    padding: 14,
  },
  failureFactsBox: {
    backgroundColor: '#141414',
    borderColor: '#404040',
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  failureFactsTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
  },
  failureQuestionButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 8,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  failureQuestionButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  failureStatusDescription: {
    color: '#fbbf24',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 10,
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
  modalActions: {
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'flex-end',
  },
  modalCancelButton: {
    alignItems: 'center',
    backgroundColor: '#262626',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  modalCancelButtonText: {
    color: '#d4d4d4',
    fontSize: 14,
    fontWeight: '600',
  },
  modalOverlay: {
    alignItems: 'center',
    backgroundColor: '#000000aa',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
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
  questionHelpText: {
    color: '#a3a3a3',
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
  questionHistory: {
    marginBottom: 12,
    maxHeight: 300,
  },
  questionInput: {
    backgroundColor: '#0f0f0f',
    borderColor: '#333',
    borderRadius: 8,
    borderWidth: 1,
    color: '#fff',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
    minHeight: 110,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  questionModalBox: {
    backgroundColor: '#171717',
    borderColor: '#333',
    borderRadius: 12,
    borderWidth: 1,
    maxHeight: '85%',
    padding: 18,
    width: '100%',
  },
  questionSubmitButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 8,
    minWidth: 92,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  questionSubmitButtonDisabled: {
    backgroundColor: '#262626',
    opacity: 0.7,
  },
  questionSubmitButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  questionTurn: {
    borderRadius: 8,
    marginBottom: 8,
    padding: 10,
  },
  questionTurnAssistant: {
    backgroundColor: '#172554',
  },
  questionTurnLabel: {
    color: '#93c5fd',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 3,
  },
  questionTurnText: {
    color: '#e5e5e5',
    fontSize: 13,
    lineHeight: 19,
  },
  questionTurnUser: {
    backgroundColor: '#262626',
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
