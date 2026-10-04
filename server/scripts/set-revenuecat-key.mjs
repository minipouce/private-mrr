#!/usr/bin/env node
/**
 * Stores a RevenueCat API key in `.env.real` without it ever being displayed.
 *
 *   npm run rc-key decal
 *
 * The key is read with the terminal in raw mode, so nothing is echoed: it never
 * appears on screen, in the shell history, or in the process list — which is
 * where it would sit had it been passed as an argument.
 *
 * Replaces an existing value rather than appending a second line, so running it
 * again on the same project is how a key is rotated.
 *
 * An unknown project is created rather than refused. A secret key belongs to
 * exactly one RevenueCat project, so the key itself answers every question the
 * configuration used to ask by hand: the project id, and the name to show. The
 * webhook secret is drawn here too, since it is ours to choose rather than
 * RevenueCat's to issue.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const project = process.argv[2];
if (!project) {
  console.error('Usage : npm run rc-key <id-du-projet>');
  process.exit(1);
}

const FILE = new URL('../.env.real', import.meta.url).pathname;
if (!existsSync(FILE)) {
  console.error(`${FILE} introuvable`);
  process.exit(1);
}

const slug = project.trim().toLowerCase();
const prefix = `PROJECT_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
const variable = `${prefix}_REVENUECAT_KEY`;
let content = readFileSync(FILE, 'utf8');

const valueOf = (name) => content.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
const isKnown = new RegExp(`^${variable}=`, 'm').test(content);

/**
 * Reads one line without echoing it.
 *
 * Raw mode rather than readline: readline in terminal mode redraws the line it
 * is reading, and muting that redraw erases the prompt along with it — which is
 * exactly how the first version of this script managed to show nothing and read
 * nothing. Here the terminal is simply told not to echo, and no redraw happens.
 *
 * A paste arrives as one chunk, not character by character, so the newline is
 * looked for inside the chunk rather than compared against it.
 */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);

    // Not a terminal (a pipe, a test): read the line plainly.
    if (!process.stdin.isTTY) {
      let piped = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { piped += c; });
      process.stdin.on('end', () => {
        process.stdout.write('\n');
        resolve(piped.split(/[\r\n]/)[0].trim());
      });
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let buffer = '';
    const done = (value) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      // Ctrl+C has to be handled by hand: raw mode swallows the signal.
      if (chunk.includes('\u0003')) {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }

      const end = chunk.search(/[\r\n]/);
      const typed = end === -1 ? chunk : chunk.slice(0, end);

      for (const ch of typed) {
        if (ch === '\u007f' || ch === '\b') buffer = buffer.slice(0, -1);
        else if (ch >= ' ') buffer += ch;
      }

      if (end !== -1) done(buffer.trim());
    };

    process.stdin.on('data', onData);
  });
}

const key = await askHidden(
  `Cle API v2 (secrete) pour ${project} — collez-la puis Entree, rien ne s'affichera : `,
);

if (!key) {
  console.error('Rien saisi, fichier inchange.');
  process.exit(1);
}
if (/\s/.test(key) || key.length < 16) {
  console.error('La saisie ne ressemble pas a une cle (espace, ou trop courte). Fichier inchange.');
  process.exit(1);
}

// The key is checked by using it, not by the shape of its prefix. A documented
// prefix is a convention, and a convention is not an authority on what the
// account actually issued — guessing one here once rejected a perfectly good
// key. RevenueCat answering is the only proof that matters.
let projectId = valueOf(`${prefix}_REVENUECAT_PROJECT_ID`);
let discoveredName = '';

// No project id on file: ask the key which project it belongs to. A secret key
// is scoped to one project, so this listing answers with exactly that one.
if (!projectId) {
  process.stdout.write('Identification du projet RevenueCat... ');
  let listing;
  try {
    listing = await fetch('https://api.revenuecat.com/v2/projects?limit=20', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    console.error(`\nRevenueCat injoignable (${err.message}). Fichier inchange.`);
    process.exit(1);
  }

  if (!listing.ok) {
    console.error(
      listing.status === 401
        ? "\ncle refusee : ce n'est pas une cle secrete v2 valide (une cle publique SDK ou une cle v1 ne marche pas). Fichier inchange."
        : `\nreponse HTTP ${listing.status} en listant les projets. Fichier inchange.`,
    );
    process.exit(1);
  }

  const items = (await listing.json().catch(() => null))?.items ?? [];
  if (items.length !== 1) {
    console.error(
      `\n${items.length} projet(s) derriere cette cle : impossible de choisir. ` +
        `Renseigne ${prefix}_REVENUECAT_PROJECT_ID a la main. Fichier inchange.`,
    );
    process.exit(1);
  }

  // Stored without the `proj` prefix, as the other entries are. The API accepts
  // either spelling, so this is only to keep the file reading uniformly.
  projectId = String(items[0].id ?? '').replace(/^proj/, '');
  discoveredName = String(items[0].name ?? '').trim();
  console.log(`c'est "${discoveredName || projectId}".`);
}

process.stdout.write('Verification aupres de RevenueCat... ');
let response;
try {
  response = await fetch(`https://api.revenuecat.com/v2/projects/${projectId}/metrics/overview`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
} catch (err) {
  console.error(`\nRevenueCat injoignable (${err.message}). Fichier inchange.`);
  process.exit(1);
}

if (!response.ok) {
  const why = {
    401: 'cle refusee : ce n\'est pas une cle secrete valide (une cle publique SDK ou une cle v1 ne marche pas)',
    403: 'cle valide mais sans la permission de lire les metriques du projet',
    404: `projet ${projectId} introuvable avec cette cle : verifie le project id, ou la cle appartient a un autre projet`,
  }[response.status] ?? `reponse HTTP ${response.status}`;
  console.error(`\n${why}. Fichier inchange.`);
  process.exit(1);
}

const body = await response.json().catch(() => null);
const metric = (id) => body?.metrics?.find((m) => m.id === id)?.value;
console.log('acceptee.');
console.log(
  `  ${project} : ${metric('active_subscriptions') ?? '?'} abonnements actifs, ` +
    `MRR ${metric('mrr') ?? '?'} (chiffres RevenueCat, bruts avant commission)`,
);

const PALETTE = [
  '#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4',
  '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#a855f7',
];

/** First palette colour the file is not already using, so two projects differ. */
function freeColor() {
  const taken = new Set(
    [...content.matchAll(/^PROJECT_[A-Z0-9_]+_COLOR="?(#[0-9a-fA-F]{6})"?$/gm)].map((m) =>
      m[1].toLowerCase(),
    ),
  );
  return PALETTE.find((c) => !taken.has(c.toLowerCase())) ?? PALETTE[0];
}

if (isKnown) {
  content = content.replace(new RegExp(`^${variable}=.*$`, 'm'), `${variable}=${key}`);
  if (!valueOf(`${prefix}_REVENUECAT_PROJECT_ID`)) {
    content = content.replace(
      new RegExp(`^${variable}=.*$`, 'm'),
      `${prefix}_REVENUECAT_PROJECT_ID=${projectId}\n${variable}=${key}`,
    );
  }
} else {
  // A project RevenueCat knows but the configuration does not: write the whole
  // block in one go. The webhook secret is drawn here rather than asked for,
  // because it is the one secret in this file we get to choose.
  const name = discoveredName || slug;
  const webhookAuth = randomBytes(32).toString('hex');

  const list = valueOf('PROJECTS');
  const ids = list.split(',').map((p) => p.trim()).filter(Boolean);
  if (!ids.includes(slug)) {
    ids.push(slug);
    content = content.replace(/^PROJECTS=.*$/m, `PROJECTS=${ids.join(',')}`);
  }

  content =
    content.replace(/\s*$/, '\n') +
    `\n# ${name} (RevenueCat)\n` +
    `${prefix}_NAME="${name}"\n` +
    `${prefix}_COLOR="${freeColor()}"\n` +
    `${prefix}_REVENUECAT_PROJECT_ID=${projectId}\n` +
    `${variable}=${key}\n` +
    `${prefix}_REVENUECAT_WEBHOOK_AUTH=${webhookAuth}\n`;
}

writeFileSync(FILE, content);
// `writeFileSync` only honours a mode when it creates the file; an existing one
// keeps whatever it had, and a file of live keys has no business being readable
// by anyone else on the machine.
chmodSync(FILE, 0o600);

console.log(`${variable} enregistree (${key.length} caracteres). La valeur n'a pas ete affichee.`);
if (!isKnown) {
  const base = (valueOf('PUBLIC_URL') || 'https://mrr.fibroweb.fr').replace(/\/+$/, '');
  console.log(`Projet "${discoveredName || slug}" ajoute a PROJECTS sous l'identifiant ${slug}.`);
  console.log(`\nIl reste le webhook, dans RevenueCat : Integrations -> Add webhook`);
  console.log(`  URL          ${base}/webhooks/revenuecat/${slug}`);
  console.log(`  Environment  Production`);
  console.log(`  le secret de l'en-tete Authorization : npm run rc-webhooks`);
}
