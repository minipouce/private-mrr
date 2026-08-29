import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Client Firebase Cloud Messaging (HTTP v1).
 *
 * Envoi direct depuis ce serveur, sans passer par le service push d'Expo :
 * le contenu des notifications — nom du client, montant — ne transite donc par
 * aucun intermédiaire supplémentaire.
 *
 * L'authentification suit le flot OAuth2 « JWT bearer » de Google : on signe
 * une assertion avec la clé privée du compte de service, on l'échange contre un
 * jeton d'accès valable une heure, et on le met en cache.
 *
 * La signature RS256 est faite avec le module `crypto` de Node : une
 * bibliothèque JWT n'apporterait rien ici et ajouterait une dépendance qui
 * manipule des secrets.
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
      `[fcm] clé de compte de service absente (${path}) — notifications désactivées`,
    );
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ServiceAccount;
    if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
      throw new Error('structure inattendue');
    }
    account = parsed;
    console.log(`[fcm] compte de service chargé — projet ${parsed.project_id}`);
    return account;
  } catch (err) {
    console.error(`[fcm] clé illisible : ${(err as Error).message}`);
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

/** Jeton d'accès OAuth2, renouvelé une minute avant expiration. */
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
    throw new Error(`échange de jeton refusé (HTTP ${res.status}) : ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: now + body.expires_in };
  return cachedToken.value;
}

export interface FcmMessage {
  token: string;
  title: string;
  body: string;
  /** FCM n'accepte que des chaînes dans `data` : les nombres sont convertis. */
  data?: Record<string, string | number>;
  channelId?: string;
  color?: string;
  /** Image affichée lorsque la notification est dépliée. */
  imageUrl?: string;
}

export type SendOutcome =
  | { ok: true }
  | { ok: false; retryable: boolean; unregistered: boolean; message: string };

/** Envoie une notification à un appareil. N'émet jamais d'exception. */
export async function sendToDevice(message: FcmMessage): Promise<SendOutcome> {
  const sa = loadAccount();
  if (!sa) {
    return { ok: false, retryable: false, unregistered: false, message: 'FCM non configuré' };
  }

  let token: string | null;
  try {
    token = await accessToken();
  } catch (err) {
    return { ok: false, retryable: true, unregistered: false, message: (err as Error).message };
  }
  if (!token) {
    return { ok: false, retryable: false, unregistered: false, message: 'jeton indisponible' };
  }

  const payload = {
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      android: {
        priority: 'HIGH',
        notification: {
          channel_id: message.channelId ?? 'revenue',
          sound: 'default',
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

    // 404 UNREGISTERED : l'app a été désinstallée ou le jeton renouvelé.
    // 400 INVALID_ARGUMENT sur le champ `token` : jeton malformé.
    // Dans les deux cas le jeton est définitivement mort, on le purge.
    const unregistered =
      res.status === 404 ||
      (res.status === 400 && /registration token|INVALID_ARGUMENT/i.test(text));

    return {
      ok: false,
      // 429 et 5xx sont temporaires : l'appelant peut réessayer plus tard.
      retryable: res.status === 429 || res.status >= 500,
      unregistered,
      message: `HTTP ${res.status} — ${text.slice(0, 200)}`,
    };
  } catch (err) {
    return { ok: false, retryable: true, unregistered: false, message: (err as Error).message };
  }
}
