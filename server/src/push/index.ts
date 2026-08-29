import { db } from '../db/index.js';
import { config } from '../config.js';
import { sendToDevice, isConfigured, type FcmMessage } from './fcm.js';
import { hasLogo } from '../stripe/branding.js';
import type { EventRow } from '../db/repo.js';

/**
 * Notification language.
 *
 * Devices announce their language when they register, so one server can push to
 * a French phone and an English one at the same time. An unknown or missing
 * language falls back to English.
 */
export type Locale = 'en' | 'fr';

export function normalizeLocale(value: unknown): Locale {
  return String(value ?? '').trim().toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

const INTL_TAG: Record<Locale, string> = { en: 'en-US', fr: 'fr-FR' };

const CURRENCY_FMT = new Map<Locale, Intl.NumberFormat>();

function money(cents: number, locale: Locale): string {
  let fmt = CURRENCY_FMT.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(INTL_TAG[locale], {
      style: 'currency',
      currency: config.baseCurrency.toUpperCase(),
      maximumFractionDigits: 0,
    });
    CURRENCY_FMT.set(locale, fmt);
  }
  return fmt.format(cents / 100);
}

/**
 * Notification copy, by language.
 *
 * Kept as a plain table rather than reusing the app's translation file: the
 * server has no bundler, and these few dozen strings do not justify sharing a
 * module across two build systems.
 */
const COPY = {
  en: {
    someone: 'a customer',
    natureCreate: 'New subscription',
    natureCycle: 'Renewal',
    natureUpdate: 'Plan change',
    natureThreshold: 'Usage threshold',
    natureSubscription: 'Subscription',
    natureOneOff: 'One-off payment',
    newSubscriber: 'New subscriber',
    perMonth: '/mo MRR',
    trialStarted: 'Trial started',
    trialBody: 'just started a trial',
    upgrade: 'Upgrade',
    downgrade: 'Downgrade',
    perMonthShort: '/mo',
    cancellation: 'Cancellation',
    mrrLost: '/mo MRR lost',
    paymentFailed: 'Payment failed',
    refund: 'Refund',
    testTitle: '✅ Notifications active',
    testBody: 'Your phone is connected to the MRR server.',
  },
  fr: {
    someone: 'un client',
    natureCreate: 'Nouvel abonnement',
    natureCycle: 'Renouvellement',
    natureUpdate: 'Changement de formule',
    natureThreshold: 'Palier de consommation',
    natureSubscription: 'Abonnement',
    natureOneOff: 'Paiement ponctuel',
    newSubscriber: 'Nouvel abonné',
    perMonth: '/mois de MRR',
    trialStarted: 'Essai démarré',
    trialBody: 'vient de commencer un essai',
    upgrade: 'Upgrade',
    downgrade: 'Downgrade',
    perMonthShort: '/mois',
    cancellation: 'Annulation',
    mrrLost: '/mois de MRR perdu',
    paymentFailed: 'Paiement échoué',
    refund: 'Remboursement',
    testTitle: '✅ Notifications actives',
    testBody: 'Ton téléphone est connecté au serveur MRR.',
  },
} satisfies Record<Locale, Record<string, string>>;

/**
 * Registers a device's FCM token.
 *
 * FCM tokens have no documented, stable format, so this is a plausibility check
 * rather than a strict pattern that would reject genuine tokens the first time
 * Google changes their shape. An invalid token is purged on the first send
 * anyway.
 */
export function registerToken(token: string, deviceName?: string, locale?: string): void {
  const trimmed = token.trim();
  if (trimmed.length < 32 || trimmed.length > 4096 || /\s/.test(trimmed)) {
    throw new Error('Invalid device token');
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO push_tokens (token, device_name, locale, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET
       device_name = excluded.device_name,
       locale      = excluded.locale,
       last_seen_at = excluded.last_seen_at`,
  ).run(trimmed, deviceName ?? null, normalizeLocale(locale), now, now);
}

export function removeToken(token: string): void {
  db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

interface Device {
  token: string;
  locale: Locale;
}

function activeDevices(): Device[] {
  const rows = db.prepare('SELECT token, locale FROM push_tokens').all() as {
    token: string;
    locale: string | null;
  }[];
  return rows.map((r) => ({ token: r.token, locale: normalizeLocale(r.locale) }));
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
function paymentNature(event: EventRow, locale: Locale): string {
  const c = COPY[locale];
  switch (event.billing_reason) {
    case 'subscription_create':
      return c.natureCreate;
    case 'subscription_cycle':
      return c.natureCycle;
    case 'subscription_update':
      return c.natureUpdate;
    case 'subscription_threshold':
      return c.natureThreshold;
    default:
      // With no usable reason, the presence of a subscription is a safe signal.
      return event.subscription_id ? c.natureSubscription : c.natureOneOff;
  }
}

export function compose(
  event: EventRow,
  projectName: string,
  locale: Locale,
): { title: string; body: string } | null {
  const c = COPY[locale];
  const who = event.customer_name ?? event.customer_email ?? c.someone;
  const money_ = (cents: number) => money(cents, locale);

  switch (event.kind) {
    case 'payment': {
      const nature = paymentNature(event, locale);
      const glyph =
        event.billing_reason === 'subscription_create'
          ? '🎉'
          : event.billing_reason === 'subscription_cycle'
            ? '🔁'
            : '💰';
      return {
        title: `${glyph} ${money_(event.amount_base_cents)} — ${projectName}`,
        body: `${nature} · ${who}${event.description ? ` · ${event.description}` : ''}`,
      };
    }
    case 'subscription_created':
      return {
        title: `🎉 ${c.newSubscriber} — ${projectName}`,
        body: `${who} · +${money_(event.mrr_delta_cents)}${c.perMonth}`,
      };
    case 'trial_started':
      return {
        title: `🌱 ${c.trialStarted} — ${projectName}`,
        body: `${who} ${c.trialBody}`,
      };
    case 'subscription_updated': {
      if (event.mrr_delta_cents === 0) return null;
      const up = event.mrr_delta_cents > 0;
      return {
        title: `${up ? `📈 ${c.upgrade}` : `📉 ${c.downgrade}`} — ${projectName}`,
        body: `${who} · ${up ? '+' : ''}${money_(event.mrr_delta_cents)}${c.perMonthShort}`,
      };
    }
    case 'subscription_canceled':
      return {
        title: `❌ ${c.cancellation} — ${projectName}`,
        body: `${who} · ${money_(event.mrr_delta_cents)}${c.mrrLost}`,
      };
    case 'payment_failed':
      return {
        title: `⚠️ ${c.paymentFailed} — ${projectName}`,
        body: `${who} · ${money_(event.amount_base_cents)}`,
      };
    case 'refund':
      return {
        title: `↩️ ${c.refund} — ${projectName}`,
        body: `${who} · ${money_(Math.abs(event.amount_base_cents))}`,
      };
    default:
      return null;
  }
}

/**
 * Broadcasts a message to every device, purging dead tokens.
 *
 * `build` is called once per device with that device's language, so a French
 * phone and an English one receive the same event worded differently.
 */
async function broadcast(build: (device: Device) => FcmMessage | null): Promise<number> {
  const devices = activeDevices();
  if (devices.length === 0) return 0;

  const outcomes = await Promise.all(
    devices.map(async (device) => {
      const message = build(device);
      if (!message) return false;

      const result = await sendToDevice(message);
      if (!result.ok) {
        if (result.unregistered) {
          removeToken(device.token);
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

    const visuals = projectVisuals(event.project_id);

    // Payments go through a dedicated channel carrying the cash-register sound.
    // An Android channel's sound is frozen at creation, so this needs a separate
    // channel rather than a per-message parameter.
    const channelId = event.kind === 'payment' ? 'payments' : 'revenue';

    await broadcast(({ token, locale }) => {
      const content = compose(event, projectName, locale);
      if (!content) return null;

      return {
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
      };
    });
  } catch (err) {
    console.error(`[push] send error: ${(err as Error).message}`);
  }
}

/** Test notification, triggered from the app to validate the chain. */
export async function sendTestNotification(): Promise<number> {
  if (!isConfigured()) throw new Error('FCM not configured on the server');

  return broadcast(({ token, locale }) => ({
    token,
    title: COPY[locale].testTitle,
    body: COPY[locale].testBody,
    data: { kind: 'test' },
  }));
}

export { isConfigured as isPushConfigured } from './fcm.js';
