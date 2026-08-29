import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

const expected = Buffer.from(config.apiToken, 'utf8');

/**
 * Comparaison à temps constant : une comparaison naïve (`a === b`) laisse fuiter
 * la longueur du préfixe correct et permet de reconstituer le jeton octet par octet.
 */
function tokenMatches(candidate: string): boolean {
  const given = Buffer.from(candidate, 'utf8');
  if (given.length !== expected.length) {
    // On compare quand même contre une valeur factice pour ne pas révéler
    // la longueur attendue par le temps de réponse.
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
      'tentative d accès non authentifiée',
    );
    // Réponse volontairement laconique : aucun indice sur la cause de l'échec.
    return reply.code(401).send({ error: 'unauthorized' });
  }
}
