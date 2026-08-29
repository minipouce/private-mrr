import { db } from '../db/index.js';
import { config } from '../config.js';
import { sendToDevice, isConfigured, type FcmMessage } from './fcm.js';
import { hasLogo } from '../stripe/branding.js';
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
 * Registers a device's FCM token.
 *
 * FCM tokens have no documented, stable format, so this is a plausibility check
 * rather than a strict pattern that would reject genuine tokens the first time
 * Google changes their shape. An invalid token is purged on the first send
 * anyway.
 */
export function registerToken(token: string, deviceName?: string): void {
  const trimmed = token.trim();
  if (trimmed.length < 32 || trimmed.length > 4096 || /\s/.test(trimmed)) {
    throw new Error('Invalid device token');
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

/** Decides whether an event deserves a notification, per project preferences. */
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

/**
 * The nature of a payment, as Stripe qualifies it.
 *
 * The amount alone does not say whether this is a first subscription or a
 * renewal, which is the most useful thing to know at a glance.
 */
function paymentNature(event: EventRow): string {
  switch (event.billing_reason) {
    case 'subscription_create':
      return 'New subscription';
    case 'subscription_cycle':
      return 'Renewal';
    case 'subscription_update':
      return 'Plan change';
    case 'subscription_threshold':
      return 'Usage threshold';
    default:
      // With no usable reason, the presence of a subscription is a safe signal.
      return event.subscription_id ? 'Subscription' : 'One-off payment';
  }
}

function compose(
  event: EventRow,
  projectName: string,
): { title: string; body: string } | null {
  const who = event.customer_name ?? event.customer_email ?? 'a customer';

  switch (event.kind) {
    case 'payment': {
      const nature = paymentNature(event);
      const glyph =
        event.billing_reason === 'subscription_create'
          ? '🎉'
          : event.billing_reason === 'subscription_cycle'
            ? '🔁'
            : '💰';
      return {
        title: `${glyph} ${money(event.amount_base_cents)} — ${projectName}`,
        body: `${nature} · ${who}${event.description ? ` · ${event.description}` : ''}`,
      };
    }
    case 'subscription_created':
      return {
        title: `🎉 New subscriber — ${projectName}`,
        body: `${who} · +${money(event.mrr_delta_cents)}/mo MRR`,
      };
    case 'trial_started':
      return {
        title: `🌱 Trial started — ${projectName}`,
        body: `${who} just started a trial`,
      };
    case 'subscription_updated': {
      if (event.mrr_delta_cents === 0) return null;
      const up = event.mrr_delta_cents > 0;
      return {
        title: `${up ? '📈 Upgrade' : '📉 Downgrade'} — ${projectName}`,
        body: `${who} · ${up ? '+' : ''}${money(event.mrr_delta_cents)}/mo`,
      };
    }
    case 'subscription_canceled':
      return {
        title: `❌ Cancellation — ${projectName}`,
        body: `${who} · ${money(event.mrr_delta_cents)}/mo MRR lost`,
      };
    case 'payment_failed':
      return {
        title: `⚠️ Payment failed — ${projectName}`,
        body: `${who} · ${money(event.amount_base_cents)}`,
      };
    case 'refund':
      return {
        title: `↩️ Refund — ${projectName}`,
        body: `${who} · ${money(Math.abs(event.amount_base_cents))}`,
      };
    default:
      return null;
  }
}

/** Broadcasts a message to every device, purging dead tokens. */
async function broadcast(build: (token: string) => FcmMessage): Promise<number> {
  const tokens = activeTokens();
  if (tokens.length === 0) return 0;

  const outcomes = await Promise.all(
    tokens.map(async (token) => {
      const result = await sendToDevice(build(token));
      if (!result.ok) {
        if (result.unregistered) {
          removeToken(token);
          console.log('[push] token purged (device unregistered)');
        } else {
          console.warn(`[push] send failed: ${result.message}`);
        }
      }
      return result.ok;
    }),
  );

  return outcomes.filter(Boolean).length;
}

/**
 * Sends the notification matching an event.
 * Errors are swallowed: a push outage must never fail webhook ingestion, or
 * Stripe would redeliver it indefinitely.
 */
/** The project's visual identity inside the notification. */
function projectVisuals(projectId: string): { color?: string; imageUrl?: string } {
  const row = db
    .prepare('SELECT color FROM projects WHERE id = ?')
    .get(projectId) as { color: string } | undefined;

  return {
    // Android tints the notification icon with this colour: the native way to
    // tell projects apart at a glance.
    color: row?.color,
    // The image is only attached when the server is publicly reachable: Firebase
    // downloads it itself, and a local URL would fail silently.
    imageUrl:
      config.publicUrl && hasLogo(projectId)
        ? `${config.publicUrl}/logos/${projectId}`
        : undefined,
  };
}

export async function notifyEvent(event: EventRow, projectName: string): Promise<void> {
  try {
    if (!isConfigured()) return;

    const prefs = prefsFor(event.project_id);
    if (!shouldNotify(event, prefs)) return;

    const content = compose(event, projectName);
    if (!content) return;

    const visuals = projectVisuals(event.project_id);

    // Payments go through a dedicated channel carrying the cash-register sound.
    // An Android channel's sound is frozen at creation, so this needs a separate
    // channel rather than a per-message parameter.
    const channelId = event.kind === 'payment' ? 'payments' : 'revenue';

    await broadcast((token) => ({
      token,
      title: content.title,
      body: content.body,
      channelId,
      sound: channelId === 'payments' ? 'cash.mp3' : 'default',
      color: visuals.color,
      imageUrl: visuals.imageUrl,
      // Lets the app open the right project when tapped.
      data: {
        projectId: event.project_id,
        eventId: event.id,
        kind: event.kind,
        amountBaseCents: event.amount_base_cents,
      },
    }));
  } catch (err) {
    console.error(`[push] send error: ${(err as Error).message}`);
  }
}

/** Test notification, triggered from the app to validate the chain. */
export async function sendTestNotification(): Promise<number> {
  if (!isConfigured()) throw new Error('FCM not configured on the server');

  return broadcast((token) => ({
    token,
    title: '✅ Notifications active',
    body: 'Your phone is connected to the MRR server.',
    data: { kind: 'test' },
  }));
}

export { isConfigured as isPushConfigured } from './fcm.js';
