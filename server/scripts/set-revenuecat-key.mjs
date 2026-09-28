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
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

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

const variable = `PROJECT_${project.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_REVENUECAT_KEY`;
const content = readFileSync(FILE, 'utf8');
if (!new RegExp(`^${variable}=`, 'm').test(content)) {
  console.error(`La ligne ${variable}= n'existe pas dans .env.real`);
  process.exit(1);
}

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
const projectId = content.match(
  new RegExp(`^PROJECT_${project.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_REVENUECAT_PROJECT_ID=(.*)$`, 'm'),
)?.[1]?.trim();

if (!projectId) {
  console.error(`Aucun project id pour ${project} dans .env.real. Fichier inchange.`);
  process.exit(1);
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

writeFileSync(FILE, content.replace(new RegExp(`^${variable}=.*$`, 'm'), `${variable}=${key}`));
// `writeFileSync` only honours a mode when it creates the file; an existing one
// keeps whatever it had, and a file of live keys has no business being readable
// by anyone else on the machine.
chmodSync(FILE, 0o600);
console.log(`${variable} enregistree (${key.length} caracteres). La valeur n'a pas ete affichee.`);
