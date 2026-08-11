import type { SafeCommand } from './command'
import type { JobGuardResult, JobStatus } from './job'
import type { TaskStatus } from './task'

export type TaskFailureClassification =
  | 'code'
  | 'environment'
  | 'configuration'
  | 'permission_or_safety'
  | 'approval_or_policy'
  | 'unknown'

export interface TaskFailureFacts {
  whatHappened: string
  taskStatus: TaskStatus
  jobId: string
  jobStatus: Extract<JobStatus, 'failed' | 'blocked'>
  safeCommandKind: SafeCommand['kind']
  exitCode: number | null
  stderrExcerpt: string | null
  stdoutExcerpt: string | null
  changedFiles: string[]
  guardResult: JobGuardResult | null
}

export interface TaskFailureAiAnalysis {
  classification: TaskFailureClassification
  likelyCause: string
  impact: string
  recommendedNextAction: string
}

/**
 * Task/Jobからコードで構築する事実と、Geminiによる推測を分離した表示専用データ。
 */
export interface TaskFailureExplanationViewModel {
  generatedAt: string
  facts: TaskFailureFacts
  aiAnalysis: TaskFailureAiAnalysis
}

export type TaskFailureExplanationResponse =
  | { ok: true; explanation: TaskFailureExplanationViewModel }
  | { ok: false; error: string }

export interface TaskFailureQuestionTurn {
  role: 'user' | 'assistant'
  content: string
}

export type TaskFailureQuestionResponse =
  | { ok: true; answer: string }
  | { ok: false; error: string }
