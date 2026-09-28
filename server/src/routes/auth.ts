import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Projects this request may see; `null` for the unrestricted token. */
    projectScope: string[] | null;
  }
}

const expected = Buffer.from(config.apiToken, 'utf8');

/**
 * Constant-time comparison: a naive `a === b` leaks the length of the correct
 * prefix through timing, letting a token be reconstructed byte by byte.
 */
function sameToken(candidate: string, reference: Buffer): boolean {
  const given = Buffer.from(candidate, 'utf8');
  if (given.length !== reference.length) {
    // Still compare against a dummy value so the expected length is not revealed
    // by response time.
    timingSafeEqual(reference, reference);
    return false;
  }
  return timingSafeEqual(given, reference);
}

const scoped = config.scopedTokens.map((t) => ({ ...t, buffer: Buffer.from(t.token, 'utf8') }));

/**
 * Resolves a token to what it is allowed to see.
 *
 * Every candidate is compared, never short-circuiting on the first match, so
 * the number of comparisons does not depend on which token was sent.
 */
function resolveScope(candidate: string): { ok: boolean; projects: string[] | null } {
  let ok = sameToken(candidate, expected);
  let projects: string[] | null = null;

  for (const t of scoped) {
    if (sameToken(candidate, t.buffer)) {
      ok = true;
      projects = t.projects;
    }
  }
  return { ok, projects };
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
  const resolved = token ? resolveScope(token) : { ok: false, projects: null };

  if (!token || !resolved.ok) {
    request.log.warn(
      { ip: request.ip, path: request.url },
      'unauthenticated access attempt',
    );
    // Deliberately terse response: no hint about why it failed.
    return reply.code(401).send({ error: 'unauthorized' });
  }

  request.projectScope = resolved.projects;
}
