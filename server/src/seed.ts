/**
 * Génère un jeu de données de démonstration réaliste : 8 projets, 24 mois
 * d'historique, croissance, upgrades et attrition.
 *
 *   npm run seed            -> alimente la base (ajoute aux données existantes)
 *   npm run seed -- --reset -> vide d'abord les tables
 *
 * Aucun appel à Stripe n'est effectué.
 */
import { db, syncProjectsFromConfig } from './db/index.js';
import { insertEvent, upsertSubscription } from './db/repo.js';

/** PRNG déterministe (mulberry32) : deux exécutions produisent le même jeu. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260828);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const between = (min: number, max: number) => min + rand() * (max - min);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

const DEMO_PROJECTS = [
  { id: 'inboxly',    name: 'Inboxly',     color: '#6366f1', subs: 340, plans: [1900, 4900, 9900] },
  { id: 'pagecraft',  name: 'PageCraft',   color: '#10b981', subs: 210, plans: [900, 2900, 7900] },
  { id: 'metricbase', name: 'MetricBase',  color: '#f59e0b', subs: 95,  plans: [4900, 14900, 29900] },
  { id: 'snapform',   name: 'SnapForm',    color: '#ec4899', subs: 480, plans: [500, 1500, 3900] },
  { id: 'deployr',    name: 'Deployr',     color: '#06b6d4', subs: 62,  plans: [9900, 24900, 49900] },
  { id: 'lexiq',      name: 'Lexiq',       color: '#8b5cf6', subs: 155, plans: [1200, 2900, 5900] },
  { id: 'orbitcrm',   name: 'OrbitCRM',    color: '#ef4444', subs: 88,  plans: [3900, 8900, 19900] },
  { id: 'tinyhost',   name: 'TinyHost',    color: '#14b8a6', subs: 275, plans: [700, 1900, 4900] },
] as const;

const FIRST_NAMES = ['Camille','Julien','Sofia','Marc','Léa','Thomas','Nadia','Hugo','Elena','Karim','Chloé','Antoine','Inès','Lucas','Amina','Paul'];
const LAST_NAMES  = ['Martin','Dubois','Nakamura','Silva','Kowalski','Rossi','Andersen','Okafor','Bergman','Haddad','Moreau','Novak','Costa','Weber'];

function person() {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  const slug = `${first}.${last}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return { name: `${first} ${last}`, email: `${slug}@example.com` };
}

const MONTHS = 24;
const now = new Date();

function monthStart(offset: number): Date {
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function reset(): void {
  db.exec(`
    DELETE FROM events;
    DELETE FROM subscriptions;
    DELETE FROM sync_state;
    DELETE FROM notification_prefs;
    DELETE FROM projects;
  `);
  console.log('Tables vidées.');
}

function seedProjects(): void {
  const upsert = db.prepare(`
    INSERT INTO projects (id, name, color, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color
  `);
  const prefs = db.prepare('INSERT OR IGNORE INTO notification_prefs (project_id) VALUES (?)');
  const sync = db.prepare(
    `INSERT OR IGNORE INTO sync_state (project_id, backfill_done, last_backfill_at) VALUES (?, 1, ?)`,
  );

  const created = sec(monthStart(-MONTHS));
  for (const p of DEMO_PROJECTS) {
    upsert.run(p.id, p.name, p.color, created);
    prefs.run(p.id);
    sync.run(p.id, sec(now));
  }
}

interface DemoSub {
  id: string;
  customerId: string;
  name: string;
  email: string;
  plan: number;
  annual: boolean;
  startedAt: Date;
  canceledAt: Date | null;
}

/**
 * Répartit les abonnés sur 24 mois avec une acquisition croissante,
 * puis applique une attrition mensuelle d'environ 3 %.
 */
function buildSubscribers(project: (typeof DEMO_PROJECTS)[number]): DemoSub[] {
  const subs: DemoSub[] = [];
  // Poids croissant : le mois -24 recrute peu, le mois courant beaucoup.
  const weights = Array.from({ length: MONTHS }, (_, i) => Math.pow(1 + i / MONTHS, 2.2));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  // On sur-recrute pour compenser les départs et retomber sur l'effectif visé.
  const gross = Math.round(project.subs * 1.55);

  let n = 0;
  for (let m = 0; m < MONTHS; m++) {
    const offset = m - MONTHS + 1;
    const count = Math.round((weights[m]! / totalWeight) * gross);
    const start = monthStart(offset);
    const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();

    for (let i = 0; i < count; i++) {
      const startedAt = new Date(start);
      startedAt.setDate(1 + Math.floor(rand() * days));
      startedAt.setHours(Math.floor(between(7, 23)), Math.floor(rand() * 60), 0, 0);
      if (startedAt > now) continue;

      const p = person();
      const annual = rand() < 0.18;

      // Attrition composée : ~3 % par mois d'ancienneté.
      let canceledAt: Date | null = null;
      const ageMonths = -offset;
      if (rand() < 1 - Math.pow(0.97, Math.max(ageMonths, 0))) {
        const life = Math.floor(between(1, Math.max(ageMonths, 2)));
        const c = new Date(startedAt);
        c.setMonth(c.getMonth() + life);
        if (c < now) canceledAt = c;
      }

      subs.push({
        id: `sub_demo_${project.id}_${n}`,
        customerId: `cus_demo_${project.id}_${n}`,
        name: p.name,
        email: p.email,
        plan: pick(project.plans),
        annual,
        startedAt,
        canceledAt,
      });
      n++;
    }
  }
  return subs;
}

function seedProject(project: (typeof DEMO_PROJECTS)[number]): number {
  const subs = buildSubscribers(project);
  let events = 0;

  const run = db.transaction(() => {
    for (const sub of subs) {
      // Un abonnement annuel paie 12x le tarif mensuel, mais pèse le tarif mensuel en MRR.
      const mrr = sub.plan;
      const charge = sub.annual ? sub.plan * 12 : sub.plan;
      const active = !sub.canceledAt;

      upsertSubscription({
        id: sub.id,
        project_id: project.id,
        customer_id: sub.customerId,
        customer_email: sub.email,
        customer_name: sub.name,
        status: active ? 'active' : 'canceled',
        currency: 'eur',
        amount_cents: charge,
        interval: sub.annual ? 'year' : 'month',
        interval_count: 1,
        quantity: 1,
        mrr_cents: active ? mrr : 0,
        mrr_base_cents: active ? mrr : 0,
        product_name: sub.annual ? 'Annuel' : 'Mensuel',
        started_at: sec(sub.startedAt),
        canceled_at: sub.canceledAt ? sec(sub.canceledAt) : null,
        current_period_end: null,
      });

      if (
        insertEvent(
          {
            project_id: project.id,
            stripe_event_id: `demo:created:${sub.id}`,
            stripe_object_id: sub.id,
            kind: 'subscription_created',
            amount_cents: charge,
            currency: 'eur',
            amount_base_cents: charge,
            mrr_delta_cents: mrr,
            customer_id: sub.customerId,
            customer_email: sub.email,
            customer_name: sub.name,
            subscription_id: sub.id,
            payment_intent: null,
            billing_reason: null,
            description: sub.annual ? 'Annuel' : 'Mensuel',
            occurred_at: sec(sub.startedAt),
          },
          { publish: false },
        )
      ) events++;

      // Facturation périodique jusqu'à aujourd'hui ou jusqu'à l'annulation.
      const end = sub.canceledAt ?? now;
      const cursor = new Date(sub.startedAt);
      let cycle = 0;
      while (cursor <= end && cycle < 40) {
        if (
          insertEvent(
            {
              project_id: project.id,
              stripe_event_id: `demo:inv:${sub.id}:${cycle}`,
              stripe_object_id: `in_demo_${sub.id}_${cycle}`,
              kind: 'payment',
              amount_cents: charge,
              currency: 'eur',
              amount_base_cents: charge,
              mrr_delta_cents: 0,
              customer_id: sub.customerId,
              customer_email: sub.email,
              customer_name: sub.name,
              subscription_id: sub.id,
              payment_intent: null,
              billing_reason: null,
              description: `${project.name} · ${sub.annual ? 'Annuel' : 'Mensuel'}`,
              occurred_at: sec(cursor),
            },
            { publish: false },
          )
        ) events++;

        // ~4 % d'échecs de paiement, rejoués le cycle suivant.
        if (rand() < 0.04) {
          const failedAt = new Date(cursor);
          failedAt.setDate(failedAt.getDate() + 1);
          if (failedAt < now) {
            insertEvent(
              {
                project_id: project.id,
                stripe_event_id: `demo:failed:${sub.id}:${cycle}`,
                stripe_object_id: `in_demo_${sub.id}_${cycle}_f`,
                kind: 'payment_failed',
                amount_cents: charge,
                currency: 'eur',
                amount_base_cents: charge,
                mrr_delta_cents: 0,
                customer_id: sub.customerId,
                customer_email: sub.email,
                customer_name: sub.name,
                subscription_id: sub.id,
                payment_intent: null,
                billing_reason: null,
                description: 'Carte refusée',
                occurred_at: sec(failedAt),
              },
              { publish: false },
            );
            events++;
          }
        }

        cursor.setMonth(cursor.getMonth() + (sub.annual ? 12 : 1));
        cycle++;
      }

      // Upgrades ponctuels sur les abonnements encore actifs.
      if (active && rand() < 0.12) {
        const upAt = new Date(sub.startedAt);
        upAt.setMonth(upAt.getMonth() + Math.floor(between(2, 8)));
        if (upAt < now) {
          const delta = Math.round(mrr * between(0.3, 1.2));
          insertEvent(
            {
              project_id: project.id,
              stripe_event_id: `demo:upgrade:${sub.id}`,
              stripe_object_id: sub.id,
              kind: 'subscription_updated',
              amount_cents: charge + delta,
              currency: 'eur',
              amount_base_cents: charge + delta,
              mrr_delta_cents: delta,
              customer_id: sub.customerId,
              customer_email: sub.email,
              customer_name: sub.name,
              subscription_id: sub.id,
              payment_intent: null,
              billing_reason: null,
              description: 'Changement de formule',
              occurred_at: sec(upAt),
            },
            { publish: false },
          );
          events++;
        }
      }

      if (sub.canceledAt) {
        insertEvent(
          {
            project_id: project.id,
            stripe_event_id: `demo:canceled:${sub.id}`,
            stripe_object_id: sub.id,
            kind: 'subscription_canceled',
            amount_cents: 0,
            currency: 'eur',
            amount_base_cents: 0,
            mrr_delta_cents: -mrr,
            customer_id: sub.customerId,
            customer_email: sub.email,
            customer_name: sub.name,
            subscription_id: sub.id,
            payment_intent: null,
            billing_reason: null,
            description: 'Abonnement résilié',
            occurred_at: sec(sub.canceledAt),
          },
          { publish: false },
        );
        events++;
      }
    }

    // Quelques ventes ponctuelles (licences, prestations) sur 12 mois.
    const oneOffs = Math.round(between(10, 40));
    for (let i = 0; i < oneOffs; i++) {
      const at = new Date(now.getTime() - Math.floor(between(0, 365)) * 86_400_000);
      const amount = Math.round(between(4900, 89000));
      const p = person();
      insertEvent(
        {
          project_id: project.id,
          stripe_event_id: `demo:oneoff:${project.id}:${i}`,
          stripe_object_id: `ch_demo_${project.id}_${i}`,
          kind: 'payment',
          amount_cents: amount,
          currency: 'eur',
          amount_base_cents: amount,
          mrr_delta_cents: 0,
          customer_id: null,
          customer_email: p.email,
          customer_name: p.name,
          subscription_id: null,
          payment_intent: null,
          billing_reason: null,
          description: 'Licence perpétuelle',
          occurred_at: sec(at),
        },
        { publish: false },
      );
      events++;
    }
  });

  run();
  return events;
}

// ---- Exécution

if (process.argv.includes('--reset')) reset();

syncProjectsFromConfig();
seedProjects();

let total = 0;
for (const project of DEMO_PROJECTS) {
  const n = seedProject(project);
  total += n;
  console.log(`${project.name.padEnd(12)} ${String(n).padStart(6)} événements`);
}

const mrr = db
  .prepare(`SELECT COALESCE(SUM(mrr_base_cents),0) AS m FROM subscriptions WHERE status = 'active'`)
  .get() as { m: number };

console.log(`\n${total} événements générés · MRR total ${(mrr.m / 100).toFixed(0)} €`);
db.close();
