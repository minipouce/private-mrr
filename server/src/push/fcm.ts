import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Firebase Cloud Messaging client (HTTP v1).
 *
 * Sends directly from this server, bypassing Expo's push service: notification
 * content, customer names and amounts included, passes through no extra
 * intermediary.
 *
 * Authentication follows Google's OAuth2 JWT-bearer flow: sign an assertion with
 * the service account private key, exchange it for an access token valid one
 * hour, and cache it.
 *
 * The RS256 signature uses Node's `crypto` module: a JWT library would add
 * nothing here beyond a dependency that handles secrets.
 */

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key: string;
  client_email: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let account: ServiceAccount | null = null;
let loaded = false;

function loadAccount(): ServiceAccount | null {
  if (loaded) return account;
  loaded = true;

  const path = resolve(
    process.env.FCM_SERVICE_ACCOUNT_PATH ?? './credentials/fcm-service-account.json',
  );

  if (!existsSync(path)) {
    console.warn(
      `[fcm] service account key not found (${path}); notifications disabled`,
    );
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ServiceAccount;
    if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
      throw new Error('unexpected structure');
    }
    account = parsed;
    console.log(`[fcm] service account loaded, project ${parsed.project_id}`);
    return account;
  } catch (err) {
    console.error(`[fcm] unreadable key: ${(err as Error).message}`);
    return null;
  }
}

export function isConfigured(): boolean {
  return loadAccount() !== null;
}

export function fcmProjectId(): string | null {
  return loadAccount()?.project_id ?? null;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

let cachedToken: { value: string; expiresAt: number } | null = null;

/** OAuth2 access token, renewed a minute before it expires. */
async function accessToken(): Promise<string | null> {
  const sa = loadAccount();
  if (!sa) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = base64url(signer.sign(sa.private_key));
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`token exchange refused (HTTP ${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
  return cachedToken.value;
}

export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  /** FCM only accepts strings in `data`, so numbers are converted. */
  data?: Record<string, string | number>;
  channelId?: string;
  /** Sound resource name, without a path. */
  sound?: string;
  color?: string;
  /** Image shown when the notification is expanded. */
  imageUrl?: string;
}

export type SendOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; unregistered: boolean; message: string };

/** Sends a notification to one device. Never throws. */
export async function sendToDevice(message: FcmMessage): Promise<SendOutcome> {
  const sa = loadAccount();
  if (!sa) {
    return { ok: false, retryable: false, unregistered: false, message: 'FCM not configured' };
  }

  let token: string | null;
  try {
    token = await accessToken();
  } catch (err) {
    return { ok: false, retryable: true, unregistered: false, message: (err as Error).message };
  }
  if (!token) {
    return { ok: false, retryable: false, unregistered: false, message: 'token unavailable' };
  }

  const payload = {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      android: {
        priority: 'HIGH',
        notification: {
          channel_id: message.channelId ?? 'revenue',
          // On Android 8 and later the channel sound wins; this field only serves
          // as a fallback for earlier versions.
          sound: message.sound ?? 'default',
          color: message.color ?? '#6366F1',
          default_vibrate_timings: true,
          ...(message.imageUrl ? { image: message.imageUrl } : {}),
        },
      },
      data: Object.fromEntries(
        Object.entries(message.data ?? {}).map(([k, v]) => [k, String(v)]),
      ),
    },
  };

  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (res.ok) return { ok: true };

    const text = await res.text();

    // 404 UNREGISTERED: the app was uninstalled or the token rotated.
    // 400 INVALID_ARGUMENT on `token`: malformed token.
    // Either way the token is permanently dead, so it is purged.
    const unregistered =
      res.status === 404 ||
      (res.status === 400 && /registration token|INVALID_ARGUMENT/i.test(text));

    return {
      ok: false,
      // 429 and 5xx are transient: the caller may retry later.
      retryable: res.status === 429 || res.status >= 500,
      unregistered,
      message: `HTTP ${res.status} — ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, retryable: true, unregistered: false, message: (err as Error).message };
  }
}
