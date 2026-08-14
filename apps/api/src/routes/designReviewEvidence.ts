import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getStorage } from '../storage'
import { computeDesignTextHash } from '../designReviewEvidencePolicy'

const ReviewLoadSchema = z.enum(['low', 'medium', 'high', 'critical'])
const DesignReviewDecisionSchema = z.enum(['ALIGNED', 'CONFLICT', 'UNCERTAIN', 'REVIEW_UNAVAILABLE'])
const IndependentReviewVerdictSchema = z.enum(['approved', 'changes_requested', 'blocking'])

const CreateDesignReviewEvidenceBody = z.object({
  taskId: z.string().min(1),
  designText: z.string().min(1).max(50_000),
  reviewLoad: ReviewLoadSchema,
  decision: DesignReviewDecisionSchema,
  independentReviewRequired: z.boolean(),
  independentReviewVerdict: IndependentReviewVerdictSchema.optional(),
}).strict()

export async function designReviewEvidenceRoutes(app: FastifyInstance): Promise<void> {
  const storage = getStorage()

  app.post('/design-review-evidence', async (req, reply) => {
    const result = CreateDesignReviewEvidenceBody.safeParse(req.body)
    if (!result.success) {
      return reply.status(400).send({ error: 'Validation failed', details: result.error.format() })
    }

    const task = storage.tasks.findById(result.data.taskId)
    if (!task) {
      return reply.status(404).send({ error: 'Task not found' })
    }

    const evidence = storage.designReviewEvidence.create({
      taskId: result.data.taskId,
      designTextHash: computeDesignTextHash(result.data.designText),
      reviewLoad: result.data.reviewLoad,
      decision: result.data.decision,
      independentReviewRequired: result.data.independentReviewRequired,
      independentReviewVerdict: result.data.independentReviewVerdict,
    })

    return reply.status(201).send(evidence)
  })
}
