import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { db } from '../db/index.js';

/**
 * Fetches brand logos from Stripe.
 *
 * Each account exposes an icon in its branding settings. It is downloaded and
 * served from this server rather than linked to Stripe: file links do not exist
 * on every account, and a push notification must be able to load the image
 * without authentication.
 */

const LOGO_DIR = process.env.LOGO_DIR ?? './data/logos';
const MAX_BYTES = 2 * 1024 * 1024;

// Stored without an extension: Stripe serves PNG or JPEG interchangeably, and
// trusting the filename would mean announcing the wrong MIME type.
export function logoPath(projectId: string): string {
  return join(LOGO_DIR, projectId);
}

export function hasLogo(projectId: string): boolean {
  return existsSync(logoPath(projectId));
}

/** MIME type derived from the magic bytes, never from the filename. */
export function sniffImageType(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}

/**
 * Downloads a project's logo. Returns `true` when a file was written.
 * Errors are swallowed: a missing logo must never block a sync or the ingestion
 * of a payment.
 */
export async function syncLogo(project: ProjectConfig): Promise<boolean> {
  const stripe = stripeFor(project);
  if (!stripe) return false;

  try {
    // Called without an id, the endpoint returns the account behind the key. The
    // SDK only types the connected-account variant, which requires an id. The
    // resource type is rewritten rather than the method extracted: pulled out of
    // its object it would lose `this` and fail at runtime.
    const accounts = stripe.accounts as unknown as { retrieve(): Promise<unknown> };
    const account = (await accounts.retrieve()) as {
      settings?: { branding?: { icon?: string | null; logo?: string | null } | null } | null;
    };

    // The icon is square and meant for small sizes; the logo, often horizontal,
    // serves only as a fallback.
    const fileId = account.settings?.branding?.icon ?? account.settings?.branding?.logo;
    if (!fileId) return false;

    const file = (await stripe.files.retrieve(fileId)) as unknown as {
      url?: string | null;
      size?: number | null;
    };
    if (!file.url) return false;
    if (file.size && file.size > MAX_BYTES) {
      console.warn(`[branding] ${project.id}: logo too large (${file.size} bytes), skipped`);
      return false;
    }

    // The content URL requires the account key: it is not a public link.
    const res = await fetch(file.url, {
      headers: { Authorization: `Bearer ${project.stripeKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES || !sniffImageType(buf)) return false;

    const target = logoPath(project.id);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);

    db.prepare('UPDATE projects SET logo_updated_at = ? WHERE id = ?').run(
      Math.floor(Date.now() / 1000),
      project.id,
    );

    console.log(`[branding] ${project.id}: logo fetched (${sniffImageType(buf)}, ${buf.length} bytes)`);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    // A key without Account permission is an expected case, not a failure.
    if (!/permission/i.test(message)) {
      console.warn(`[branding] ${project.id}: ${message.slice(0, 100)}`);
    }
    return false;
  }
}

export async function syncAllLogos(projects: readonly ProjectConfig[]): Promise<number> {
  let count = 0;
  for (const project of projects) {
    if (await syncLogo(project)) count++;
  }
  return count;
}
