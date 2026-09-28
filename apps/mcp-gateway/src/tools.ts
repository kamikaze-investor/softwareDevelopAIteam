import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { AiteamosApiError, type AiteamosClient } from './aiteamosClient.js'

/**
 * MCP として公開する tool は**これだけ**である（CEO 方針・2026-09-28）:
 *
 * - safe read（projection 済み）: get_system_state / get_project / list_tasks / get_task /
 *   get_pl_triage_summary
 * - PL への依頼: ask_pl（Operator Request の作成。gateway は保存を依頼するだけ。実行の可否は
 *   AIteamOS 側で PL の通常判断と既存 Gate が決める）
 * - 依頼の結果: get_operator_request / list_operator_requests
 *
 * resume / approve / retry / quarantine 解除 / commit / PL tick 等の tool は**作らない**。
 * gateway は state も独自 Gate も持たず、各 tool は AIteamOS API の固定 route を 1 回呼ぶだけである。
 */

export const TOOL_NAMES = [
  'get_system_state',
  'get_project',
  'list_tasks',
  'get_task',
  'get_pl_triage_summary',
  'ask_pl',
  'get_operator_request',
  'list_operator_requests',
] as const

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

async function run(action: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await action()
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  } catch (error: unknown) {
    // API のエラー文言（credential を含まない）と status だけを返す。
    const message = error instanceof AiteamosApiError
      ? `AIteamOS API returned ${error.status}: ${error.message}`
      : 'AIteamOS API could not be reached'
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

const id = z.string().min(1).max(200)

export function buildMcpServer(client: AiteamosClient): McpServer {
  const server = new McpServer({ name: 'aiteamos-operator-gateway', version: '0.1.0' })

  server.registerTool('get_system_state', {
    title: 'AIteamOS system state',
    description:
      'Read-only overview of AIteamOS: projects, current tasks, job counts, design review status, and the ' +
      '"attention" list of things that are stopped or need a decision. Raw job output is not included.',
    annotations: READ_ONLY,
  }, async () => run(() => client.getSystemState()))

  server.registerTool('get_project', {
    title: 'Project detail',
    description: 'Read-only project detail with its active roadmap phases and completion.',
    inputSchema: { projectId: id },
    annotations: READ_ONLY,
  }, async ({ projectId }) => run(() => client.getProject(projectId)))

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'Read-only task list with status, latest job status and approval summary.',
    inputSchema: {
      projectId: id.optional(),
      status: z.enum(['pending', 'in_progress', 'review', 'done', 'blocked']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: READ_ONLY,
  }, async (args) => run(() => client.listTasks(args)))

  server.registerTool('get_task', {
    title: 'Task detail',
    description:
      'Read-only task detail: jobs (status, failure kind, guard result), approval requests, latest design ' +
      'review, reviews and QA results. Raw stdout/stderr and prompts are not included.',
    inputSchema: { taskId: id },
    annotations: READ_ONLY,
  }, async ({ taskId }) => run(() => client.getTask(taskId)))

  server.registerTool('get_pl_triage_summary', {
    title: 'PL blocked-triage statistics',
    description: 'Read-only aggregate statistics of how the PL has triaged blocked work.',
    annotations: READ_ONLY,
  }, async () => run(() => client.getPlTriageSummary()))

  server.registerTool('ask_pl', {
    title: 'Ask the PL',
    description:
      'Send a natural-language request or question to the AIteamOS Project Lead (PL). Calling this only records ' +
      'the request. On its next cycle the PL answers it; if the request asks for an action on a stalled item, ' +
      'the PL runs its normal decision for that item, and only an existing action that the mandatory gates allow ' +
      'is executed. The request text is never used as authorization, and nothing outside the PL\'s existing ' +
      'authority (approvals, CEO approvals, quarantine release, commits, deploys) can happen. Poll ' +
      'get_operator_request with the returned id for the answer and the recorded outcome (plAction).',
    inputSchema: {
      message: z.string().min(1).max(2000),
      projectId: id.optional(),
      taskId: id.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => run(() => client.createOperatorRequest(args)))

  server.registerTool('get_operator_request', {
    title: 'Get a PL request and its answer',
    description: 'Read an operator request created with ask_pl, including the PL response once answered.',
    inputSchema: { requestId: id },
    annotations: READ_ONLY,
  }, async ({ requestId }) => run(() => client.getOperatorRequest(requestId)))

  server.registerTool('list_operator_requests', {
    title: 'List PL requests',
    description: 'Read recent operator requests (newest first), optionally filtered by status.',
    inputSchema: {
      status: z.enum(['pending', 'answered', 'failed']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: READ_ONLY,
  }, async (args) => run(() => client.listOperatorRequests(args)))

  return server
}
