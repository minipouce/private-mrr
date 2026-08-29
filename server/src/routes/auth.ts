import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

const expected = Buffer.from(config.apiToken, 'utf8');

/**
 * Constant-time comparison: a naive `a === b` leaks the length of the correct
 * prefix through timing, letting a token be reconstructed byte by byte.
 */
function tokenMatches(candidate: string): boolean {
  const given = Buffer.from(candidate, 'utf8');
  if (given.length !== expected.length) {
    // Still compare against a dummy value so the expected length is not revealed
    // by response time.
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim();
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = extractToken(request);

  if (!token || !tokenMatches(token)) {
    request.log.warn(
      { ip: request.ip, path: request.url },
      'unauthenticated access attempt',
    );
    // Deliberately terse response: no hint about why it failed.
    return reply.code(401).send({ error: 'unauthorized' });
  }
}
