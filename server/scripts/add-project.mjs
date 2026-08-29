#!/usr/bin/env node
/**
 * Ajoute un projet au fichier .env, avec un nommage de variables correct.
 *
 *   node scripts/add-project.mjs <identifiant> "<Nom affiché>" [couleur]
 *
 * Le nom des variables dérive mécaniquement de l'identifiant
 * (`saas-a` -> `PROJECT_SAAS_A_*`) : c'est l'erreur la plus fréquente quand on
 * écrit les blocs à la main, et elle se traduit par un projet silencieusement
 * ignoré au démarrage.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#ef4444', '#14b8a6'];

const [, , id, name, colorArg] = process.argv;
const envPath = resolve(process.env.ENV_FILE ?? '.env');

if (!id || !name) {
  console.error('Usage : node scripts/add-project.mjs <identifiant> "<Nom affiché>" [couleur]');
  console.error('Exemple : node scripts/add-project.mjs saas-a "SaaS A"');
  process.exit(1);
}

if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  console.error(
    `Identifiant invalide : « ${id} ».\n` +
      'Minuscules, chiffres et tirets uniquement — il apparaît dans l\'URL du webhook.',
  );
  process.exit(1);
}

if (!existsSync(envPath)) {
  console.error(`${envPath} introuvable. Copie d'abord .env.example.`);
  process.exit(1);
}

let env = readFileSync(envPath, 'utf8');
const prefix = `PROJECT_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

if (env.includes(`${prefix}_STRIPE_KEY`)) {
  console.error(`Le projet « ${id} » est déjà déclaré.`);
  process.exit(1);
}

// Mise à jour de la liste PROJECTS, en préservant l'ordre existant.
const match = env.match(/^PROJECTS=(.*)$/m);
const existing = (match?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (existing.includes(id)) {
  console.error(`« ${id} » figure déjà dans PROJECTS.`);
  process.exit(1);
}
const updated = [...existing, id];

env = match
  ? env.replace(/^PROJECTS=.*$/m, `PROJECTS=${updated.join(',')}`)
  : `PROJECTS=${updated.join(',')}\n${env}`;

const color = colorArg ?? PALETTE[existing.length % PALETTE.length];

env = env.replace(/\n*$/, '\n');
env += `
${prefix}_NAME="${name.replace(/"/g, '\\"')}"
${prefix}_STRIPE_KEY=
${prefix}_WEBHOOK_SECRET=
${prefix}_COLOR="${color}"
`;

writeFileSync(envPath, env, { mode: 0o600 });

console.log(`✓ ${name} ajouté (${id})`);
console.log(`  À compléter dans ${envPath} :`);
console.log(`    ${prefix}_STRIPE_KEY=rk_live_…`);
console.log(`    ${prefix}_WEBHOOK_SECRET=whsec_…   (plus tard)`);
console.log(`  URL du webhook : https://TON_DOMAINE/webhooks/stripe/${id}`);
