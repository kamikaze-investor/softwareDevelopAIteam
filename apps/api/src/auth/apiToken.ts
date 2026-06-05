import type { FastifyReply, FastifyRequest } from 'fastify'

const BEARER_PREFIX = 'Bearer '

/**
 * Validates Authorization: Bearer <token> against API_TOKEN.
 * Authentication is skipped when API_TOKEN is not configured.
 */
export async function apiTokenAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expectedToken = process.env.API_TOKEN
  if (!expectedToken) return

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: 'Authorization header required' })
    return
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim()
  if (token !== expectedToken) {
    reply.status(401).send({ error: 'Invalid token' })
  }
}
