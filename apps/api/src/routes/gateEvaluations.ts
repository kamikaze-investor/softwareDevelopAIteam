import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'

/**
 * trusted resulting_commit の exact verification。
 *
 * GitHub Actionsが「このcommitはtrusted resulting_commitか？」だけを機械検証するための
 * read-only routeで、ACTIONS_READONLY credentialから使う。
 *
 * 一般的なevidence一覧APIは提供しない（全件列挙する必要が無く、
 * 列挙できること自体が不要な情報露出になるため）。
 * diff・prompt・triggeredRules等の内部情報も返さない。
 */

const VerifyCommitQuery = z.object({
  resultingCommit: z.string().min(1),
})

export async function gateEvaluationRoutes(app: FastifyInstance): Promise<void> {
  const storage = (app as unknown as { storageOverride?: ReturnType<typeof getStorage> })
    .storageOverride ?? getStorage()

  // GET /api/gate-evaluations/verify-commit?resultingCommit=<sha>
  app.get('/gate-evaluations/verify-commit', async (req, reply) => {
    const parsed = VerifyCommitQuery.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send({ error: 'resultingCommit is required' })
    }

    const { resultingCommit } = parsed.data
    const trusted = storage.gateEvaluations
      .findByResultingCommit(resultingCommit)
      .filter(
        (evidence) =>
          evidence.resultingCommit === resultingCommit &&
          evidence.decision === 'ALLOW' &&
          evidence.bindingVerification === 'authoritative' &&
          evidence.approvedContentHash !== undefined,
      )

    // resulting_commitはpartial unique indexで一意なので、trustedは0件か1件になる。
    // 万一複数見えた場合は曖昧なのでtrustedとしない（fail closed）。
    if (trusted.length !== 1) {
      return reply.send({ trusted: false, resultingCommit })
    }

    return reply.send({
      trusted: true,
      resultingCommit,
      policyVersion: trusted[0].policyVersion,
    })
  })
}
