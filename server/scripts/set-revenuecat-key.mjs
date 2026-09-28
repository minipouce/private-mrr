#!/usr/bin/env node
/**
 * Stores a RevenueCat API key in `.env.real` without it ever being displayed.
 *
 *   node scripts/set-revenuecat-key.mjs decal
 *
 * The key is read with the terminal echo turned off, written straight to the
 * file, and never printed, logged or passed as an argument — an argument would
 * sit in the shell history and in the process list for anyone to read.
 *
 * Replaces an existing value rather than appending a second line, so running it
 * again is how you rotate a key.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';

const project = process.argv[2];
if (!project) {
  console.error('Usage : node scripts/set-revenuecat-key.mjs <id-du-projet>');
  process.exit(1);
}

const FILE = new URL('../.env.real', import.meta.url).pathname;
if (!existsSync(FILE)) {
  console.error(`${FILE} introuvable`);
  process.exit(1);
}

const variable = `PROJECT_${project.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_REVENUECAT_KEY`;
const content = readFileSync(FILE, 'utf8');
if (!content.includes(`${variable}=`)) {
  console.error(`La ligne ${variable}= n'existe pas dans .env.real`);
  process.exit(1);
}

/** Reads one line with the echo off, so the key never appears on screen. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl.output;
    let first = true;
    output.write(question);
    // Swallow every echoed character; the prompt itself is written once.
    rl._writeToOutput = () => {
      if (first) first = false;
    };
    rl.question('', (answer) => {
      rl.close();
      output.write('\n');
      resolve(answer.trim());
    });
  });
}

const key = await askHidden(`Clé API v2 (secrète) pour ${project} — collez-la, rien ne s'affichera : `);

if (!key) {
  console.error('Rien saisi, fichier inchangé.');
  process.exit(1);
}
if (!key.startsWith('sk_')) {
  console.error(`La clé ne commence pas par sk_ : ce n'est pas une clé v2 secrète. Fichier inchangé.`);
  process.exit(1);
}

const updated = content.replace(new RegExp(`^${variable}=.*$`, 'm'), `${variable}=${key}`);
writeFileSync(FILE, updated);
// `writeFileSync` only honours `mode` when it creates the file, so an existing
// one keeps whatever it had. A file holding live keys has no business being
// readable by anyone else on the machine.
chmodSync(FILE, 0o600);
console.log(`${variable} enregistrée (${key.length} caractères). La valeur n'a pas été affichée.`);
