import { db } from '../db/index.js';
import { config } from '../config.js';
import { sendToDevice, isConfigured, type FcmMessage } from './fcm.js';
import type { EventRow } from '../db/repo.js';

const CURRENCY_FMT = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: config.baseCurrency.toUpperCase(),
  maximumFractionDigits: 0,
});

function money(cents: number): string {
  return CURRENCY_FMT.format(cents / 100);
}

/**
 * Enregistre un jeton FCM d'appareil.
 *
 * Les jetons FCM n'ont pas de format documenté et stable ; on se contente donc
 * d'un contrôle de plausibilité plutôt que d'une expression régulière stricte
 * qui rejetterait de vrais jetons au premier changement de format côté Google.
 * Un jeton invalide sera de toute façon purgé au premier envoi.
 */
export function registerToken(token: string, deviceName?: string): void {
  const trimmed = token.trim();
  if (trimmed.length < 32 || trimmed.length > 4096 || /\s/.test(trimmed)) {
    throw new Error("Jeton d'appareil invalide");
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO push_tokens (token, device_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET device_name = excluded.device_name, last_seen_at = excluded.last_seen_at`,
  ).run(trimmed, deviceName ?? null, now, now);
}

export function removeToken(token: string): void {
  db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

function activeTokens(): string[] {
  const rows = db.prepare('SELECT token FROM push_tokens').all() as { token: string }[];
  return rows.map((r) => r.token);
}

interface Prefs {
  notify_payments: number;
  notify_signups: number;
  notify_cancels: number;
  notify_failures: number;
  min_amount_cents: number;
}

function prefsFor(projectId: string): Prefs {
  return (
    (db
      .prepare('SELECT * FROM notification_prefs WHERE project_id = ?')
      .get(projectId) as Prefs | undefined) ?? {
      notify_payments: 1,
      notify_signups: 1,
      notify_cancels: 1,
      notify_failures: 1,
      min_amount_cents: 0,
    }
  );
}

/** Décide si un événement mérite une notification, selon les préférences du projet. */
function shouldNotify(event: EventRow, prefs: Prefs): boolean {
  switch (event.kind) {
    case 'payment':
      return (
        prefs.notify_payments === 1 &&
        Math.abs(event.amount_base_cents) >= prefs.min_amount_cents
      );
    case 'subscription_created':
    case 'trial_started':
      return prefs.notify_signups === 1;
    case 'subscription_canceled':
      return prefs.notify_cancels === 1;
    case 'payment_failed':
      return prefs.notify_failures === 1;
    case 'refund':
      return prefs.notify_payments === 1;
    default:
      return false;
  }
}

function compose(
  event: EventRow,
  projectName: string,
): { title: string; body: string } | null {
  const who = event.customer_name ?? event.customer_email ?? 'un client';

  switch (event.kind) {
    case 'payment':
      return {
        title: `💰 ${money(event.amount_base_cents)} — ${projectName}`,
        body: `Paiement reçu de ${who}${event.description ? ` · ${event.description}` : ''}`,
      };
    case 'subscription_created':
      return {
        title: `🎉 Nouvel abonné — ${projectName}`,
        body: `${who} · +${money(event.mrr_delta_cents)}/mois de MRR`,
      };
    case 'trial_started':
      return {
        title: `🌱 Essai démarré — ${projectName}`,
        body: `${who} vient de commencer un essai`,
      };
    case 'subscription_updated': {
      if (event.mrr_delta_cents === 0) return null;
      const up = event.mrr_delta_cents > 0;
      return {
        title: `${up ? '📈 Upgrade' : '📉 Downgrade'} — ${projectName}`,
        body: `${who} · ${up ? '+' : ''}${money(event.mrr_delta_cents)}/mois`,
      };
    }
    case 'subscription_canceled':
      return {
        title: `❌ Annulation — ${projectName}`,
        body: `${who} · ${money(event.mrr_delta_cents)}/mois de MRR perdu`,
      };
    case 'payment_failed':
      return {
        title: `⚠️ Paiement échoué — ${projectName}`,
        body: `${who} · ${money(event.amount_base_cents)}`,
      };
    case 'refund':
      return {
        title: `↩️ Remboursement — ${projectName}`,
        body: `${who} · ${money(Math.abs(event.amount_base_cents))}`,
      };
    default:
      return null;
  }
}

/** Diffuse un message à tous les appareils, en purgeant les jetons morts. */
async function broadcast(build: (token: string) => FcmMessage): Promise<number> {
  const tokens = activeTokens();
  if (tokens.length === 0) return 0;

  const outcomes = await Promise.all(
    tokens.map(async (token) => {
      const result = await sendToDevice(build(token));
      if (!result.ok) {
        if (result.unregistered) {
          removeToken(token);
          console.log('[push] jeton purgé (appareil désinscrit)');
        } else {
          console.warn(`[push] envoi échoué : ${result.message}`);
        }
      }
      return result.ok;
    }),
  );

  return outcomes.filter(Boolean).length;
}

/**
 * Envoie la notification correspondant à un événement.
 * Les erreurs sont absorbées : une panne de push ne doit jamais faire échouer
 * l'ingestion d'un webhook, sinon Stripe le rejouerait indéfiniment.
 */
export async function notifyEvent(event: EventRow, projectName: string): Promise<void> {
  try {
    if (!isConfigured()) return;

    const prefs = prefsFor(event.project_id);
    if (!shouldNotify(event, prefs)) return;

    const content = compose(event, projectName);
    if (!content) return;

    await broadcast((token) => ({
      token,
      title: content.title,
      body: content.body,
      // Permet à l'app d'ouvrir directement le bon projet au tap.
      data: {
        projectId: event.project_id,
        eventId: event.id,
        kind: event.kind,
        amountBaseCents: event.amount_base_cents,
      },
    }));
  } catch (err) {
    console.error(`[push] envoi impossible : ${(err as Error).message}`);
  }
}

/** Notification de test, déclenchée depuis l'app pour valider la chaîne. */
export async function sendTestNotification(): Promise<number> {
  if (!isConfigured()) throw new Error('FCM non configuré côté serveur');

  return broadcast((token) => ({
    token,
    title: '✅ Notifications actives',
    body: 'Ton téléphone est bien relié au serveur MRR.',
    data: { kind: 'test' },
  }));
}

export { isConfigured as isPushConfigured } from './fcm.js';
