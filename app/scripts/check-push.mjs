#!/usr/bin/env node
/**
 * Diagnostic de la chaîne de notifications push.
 *
 * Chaque maillon peut échouer silencieusement : une app se compile et se lance
 * parfaitement alors qu'aucune notification ne partira jamais. Ce script rend
 * chaque maillon visible.
 *
 *   node scripts/check-push.mjs
 *   node scripts/check-push.mjs --server https://mrr.tondomaine.com --token <jeton>
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};

let failures = 0;
let warnings = 0;

const ok = (label, detail = '') => console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); };
const warn = (label, detail = '') => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`); };

console.log('\n\x1b[1mDiagnostic des notifications push\x1b[0m\n');

// --- 1. Configuration Expo -------------------------------------------------
console.log('\x1b[1m1. Projet Expo\x1b[0m');

let config;
try {
  config = JSON.parse(execSync('npx expo config --type public --json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
} catch {
  bad('Configuration Expo illisible', 'npx expo config a échoué');
}

const projectId = config?.extra?.eas?.projectId;
const androidPackage = config?.android?.package;

if (projectId) ok('projectId présent', projectId);
else bad('projectId absent', 'lance : npx eas-cli init');

if (androidPackage) ok('paquet Android', androidPackage);
else bad('paquet Android absent');

// --- 2. Fichier Firebase ---------------------------------------------------
console.log('\n\x1b[1m2. Firebase (google-services.json)\x1b[0m');

const gsPath = resolve(process.cwd(), 'google-services.json');
if (!existsSync(gsPath)) {
  bad('google-services.json absent', 'à télécharger depuis la console Firebase');
} else {
  try {
    const gs = JSON.parse(readFileSync(gsPath, 'utf8'));

    const packages = (gs.client ?? [])
      .map((c) => c?.client_info?.android_client_info?.package_name)
      .filter(Boolean);

    if (packages.includes(androidPackage)) {
      ok('nom de paquet cohérent', androidPackage);
    } else {
      bad('nom de paquet incohérent', `Firebase: [${packages.join(', ')}] ≠ app: ${androidPackage}`);
    }

    const projectNumber = gs.project_info?.project_number;
    const firebaseProject = gs.project_info?.project_id;
    if (projectNumber) ok('projet Firebase', `${firebaseProject} (n° ${projectNumber})`);
    else bad('project_info incomplet');

    const hasApiKey = (gs.client ?? []).some((c) => (c.api_key ?? []).some((k) => k.current_key));
    if (hasApiKey) ok('clé API présente');
    else warn('aucune clé API dans le fichier');
  } catch {
    bad('google-services.json illisible', 'JSON invalide');
  }
}

// --- 3. Clé de compte de service (côté serveur) ----------------------------
console.log('\n\x1b[1m3. Clé Firebase (côté serveur)\x1b[0m');

const serverKeyPath = resolve(process.cwd(), '../server/credentials/fcm-service-account.json');
if (existsSync(serverKeyPath)) {
  try {
    const sa = JSON.parse(readFileSync(serverKeyPath, 'utf8'));
    if (sa.type !== 'service_account') {
      bad('fichier inattendu', `type « ${sa.type} »`);
    } else {
      ok('clé de compte de service présente', sa.client_email);
      // Le serveur envoie vers le projet nommé dans SA clé : si elle pointe
      // ailleurs que google-services.json, les envois partiraient dans le vide.
      const gs = existsSync(gsPath) ? JSON.parse(readFileSync(gsPath, 'utf8')) : null;
      if (gs && gs.project_info?.project_id !== sa.project_id) {
        bad(
          'projets incohérents',
          `app: ${gs.project_info?.project_id} ≠ serveur: ${sa.project_id}`,
        );
      } else if (gs) {
        ok('projet cohérent avec l\'app', sa.project_id);
      }
    }
  } catch {
    bad('clé illisible', 'JSON invalide');
  }
} else {
  warn('clé absente à l\'emplacement par défaut', '../server/credentials/fcm-service-account.json');
  console.log('  \x1b[2mNormal si le serveur est déjà déployé ailleurs : vérifie alors\x1b[0m');
  console.log('  \x1b[2mFCM_SERVICE_ACCOUNT_PATH sur le serveur, et /health.\x1b[0m');
}

// --- 4. Serveur ------------------------------------------------------------
const server = argValue('server');
const token = argValue('token');

if (server && token) {
  console.log('\n\x1b[1m4. Serveur\x1b[0m');
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/api/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const health = await res.json();
      ok('serveur joignable', `${health.events} événements`);
      if (health.push?.configured) ok('FCM configuré côté serveur');
      else bad('FCM non configuré côté serveur', 'clé absente ou illisible');
      console.log(`  \x1b[2m${health.push?.devices ?? 0} appareil(s) enregistré(s)\x1b[0m`);
    } else {
      bad('serveur a répondu', `HTTP ${res.status}`);
    }
  } catch (err) {
    bad('serveur injoignable', err.message);
  }
} else {
  console.log('\n\x1b[1m4. Serveur\x1b[0m');
  console.log('  \x1b[2mIgnoré — passe --server <url> --token <jeton> pour le tester.\x1b[0m');
}

// --- Bilan -----------------------------------------------------------------
console.log('');
if (failures === 0 && warnings === 0) {
  console.log('\x1b[32mTout est en place.\x1b[0m Recompile l\'APK, puis dans l\'app : Réglages → Activer les notifications.\n');
} else {
  console.log(`\x1b[31m${failures} bloquant(s)\x1b[0m, \x1b[33m${warnings} avertissement(s)\x1b[0m.\n`);
}
process.exit(failures > 0 ? 1 : 0);
