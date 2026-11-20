#!/usr/bin/env node
/**
 * Stores a Stripe key in `.env.real` without it ever being displayed.
 *
 *   npm run stripe-key atyla              the API key
 *   npm run stripe-key atyla --webhook    the endpoint signing secret
 *
 * The key is read with the terminal in raw mode, so nothing is echoed: it never
 * appears on screen, in the shell history, or in the process list — which is
 * where it would sit had it been passed as an argument.
 *
 * Changing the Stripe account behind a project is exactly this, run twice: the
 * new account issues a new key, and a new endpoint issues a new signing secret.
 * Replacing one and forgetting the other is the quiet failure this script is
 * meant to prevent, so each run says what is still missing.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { askHidden } from './lib/ask-hidden.mjs';

const args = process.argv.slice(2);
const webhookMode = args.includes('--webhook');
const project = args.find((a) => !a.startsWith('-'));

if (!project) {
  console.error('Usage : npm run stripe-key <id-du-projet> [--webhook]');
  process.exit(1);
}

const FILE = new URL('../.env.real', import.meta.url).pathname;
if (!existsSync(FILE)) {
  console.error(`${FILE} introuvable`);
  process.exit(1);
}

const prefix = `PROJECT_${project.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
const variable = webhookMode ? `${prefix}_WEBHOOK_SECRET` : `${prefix}_STRIPE_KEY`;
let content = readFileSync(FILE, 'utf8');

const valueOf = (name) => content.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
if (!new RegExp(`^${variable}=`, 'm').test(content)) {
  console.error(`La ligne ${variable}= n'existe pas dans .env.real. Fichier inchange.`);
  process.exit(1);
}

const secret = await askHidden(
  webhookMode
    ? `Secret de signature (whsec_...) pour ${project} — collez-le puis Entree, rien ne s'affichera : `
    : `Cle API Stripe pour ${project} — collez-la puis Entree, rien ne s'affichera : `,
);

if (!secret) {
  console.error('Rien saisi, fichier inchange.');
  process.exit(1);
}
if (/\s/.test(secret) || secret.length < 16) {
  console.error('La saisie ne ressemble pas a une cle (espace, ou trop courte). Fichier inchange.');
  process.exit(1);
}

if (webhookMode) {
  // A signing secret cannot be checked without a delivery to verify, so its
  // shape is all there is to go on. Stripe does guarantee this one.
  if (!secret.startsWith('whsec_')) {
    console.error("Un secret de signature commence par 'whsec_'. Fichier inchange.");
    process.exit(1);
  }
} else {
  // The key is checked by using it, not by the shape of its prefix. Reading the
  // account back is also the only way to be sure which Stripe account was just
  // wired in — the point of the whole exercise when an account changes.
  process.stdout.write('Verification aupres de Stripe... ');
  let response;
  try {
    response = await fetch('https://api.stripe.com/v1/account', {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`\nStripe injoignable (${err.message}). Fichier inchange.`);
    process.exit(1);
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`\n${body?.error?.message ?? `reponse HTTP ${response.status}`}. Fichier inchange.`);
    process.exit(1);
  }

  const name =
    body?.business_profile?.name ?? body?.settings?.dashboard?.display_name ?? '(sans nom)';
  console.log('acceptee.');
  console.log(`  compte : ${body?.id} — ${name}`);
  console.log('  Verifie ce nom : une cle acceptee mais venant du mauvais compte passerait inapercue.');

  // `rk_` is restricted, `sk_` opens everything. Unlike a vendor's documented
  // prefix convention, this one is Stripe's own access model, so it is worth
  // saying out loud — as a warning, never a refusal: the choice is the owner's.
  if (secret.startsWith('sk_')) {
    console.log("\n  Attention : cle complete (sk_). Ce tableau de bord ne fait que lire ;");
    console.log('  une cle restreinte en lecture seule (rk_) limiterait les degats en cas de fuite.');
  }
}

content = content.replace(new RegExp(`^${variable}=.*$`, 'm'), `${variable}=${secret}`);
writeFileSync(FILE, content);
// `writeFileSync` only honours a mode when it creates the file; an existing one
// keeps whatever it had, and a file of live keys has no business being readable
// by anyone else on the machine.
chmodSync(FILE, 0o600);
console.log(`\n${variable} enregistree (${secret.length} caracteres). La valeur n'a pas ete affichee.`);

const base = (valueOf('PUBLIC_URL') || 'https://mrr.fibroweb.fr').replace(/\/+$/, '');
if (!webhookMode) {
  console.log(`\nIl reste le webhook, dans Stripe : Developers -> Webhooks -> Add endpoint`);
  console.log(`  URL  ${base}/webhooks/stripe/${project}`);
  console.log(`  puis : npm run stripe-key ${project} --webhook`);
} else {
  console.log(`\nLe projet ${project} est complet. Previens pour le deploiement.`);
}
