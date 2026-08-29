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

console.log('\n\x1b[1mPush notification diagnostic\x1b[0m\n');

// --- 1. Configuration Expo -------------------------------------------------
console.log('\x1b[1m1. Expo project\x1b[0m');

let config;
try {
  config = JSON.parse(execSync('npx expo config --type public --json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
} catch {
  bad('Expo config unreadable', 'npx expo config failed');
}

const projectId = config?.extra?.eas?.projectId;
const androidPackage = config?.android?.package;

if (projectId) ok('projectId present', projectId);
else bad('projectId missing', 'run: npx eas-cli init');

if (androidPackage) ok('Android package', androidPackage);
else bad('Android package missing');

// --- 2. Fichier Firebase ---------------------------------------------------
console.log('\n\x1b[1m2. Firebase (google-services.json)\x1b[0m');

const gsPath = resolve(process.cwd(), 'google-services.json');
if (!existsSync(gsPath)) {
  bad('google-services.json missing', 'download it from the Firebase console');
} else {
  try {
    const gs = JSON.parse(readFileSync(gsPath, 'utf8'));

    const packages = (gs.client ?? [])
      .map((c) => c?.client_info?.android_client_info?.package_name)
      .filter(Boolean);

    if (packages.includes(androidPackage)) {
      ok('package name matches', androidPackage);
    } else {
      bad('package name mismatch', `Firebase: [${packages.join(', ')}] != app: ${androidPackage}`);
    }

    const projectNumber = gs.project_info?.project_number;
    const firebaseProject = gs.project_info?.project_id;
    if (projectNumber) ok('Firebase project', `${firebaseProject} (no. ${projectNumber})`);
    else bad('project_info incomplete');

    const hasApiKey = (gs.client ?? []).some((c) => (c.api_key ?? []).some((k) => k.current_key));
    if (hasApiKey) ok('API key present');
    else warn('no API key in the file');
  } catch {
    bad('google-services.json unreadable', 'invalid JSON');
  }
}

// --- 3. Clé de compte de service (côté serveur) ----------------------------
console.log('\n\x1b[1m3. Firebase key (server side)\x1b[0m');

const serverKeyPath = resolve(process.cwd(), '../server/credentials/fcm-service-account.json');
if (existsSync(serverKeyPath)) {
  try {
    const sa = JSON.parse(readFileSync(serverKeyPath, 'utf8'));
    if (sa.type !== 'service_account') {
      bad('unexpected file', `type "${sa.type}"`);
    } else {
      ok('service account key present', sa.client_email);
      // Le serveur envoie vers le projet nommé dans SA clé : si elle pointe
      // ailleurs que google-services.json, les envois partiraient dans le vide.
      const gs = existsSync(gsPath) ? JSON.parse(readFileSync(gsPath, 'utf8')) : null;
      if (gs && gs.project_info?.project_id !== sa.project_id) {
        bad(
          'project mismatch',
          `app: ${gs.project_info?.project_id} != server: ${sa.project_id}`,
        );
      } else if (gs) {
        ok('project matches the app', sa.project_id);
      }
    }
  } catch {
    bad('unreadable key', 'invalid JSON');
  }
} else {
  warn('key not at the default path', '../server/credentials/fcm-service-account.json');
  console.log('  \x1b[2mExpected if the server is already deployed elsewhere. Check\x1b[0m');
  console.log('  \x1b[2mFCM_SERVICE_ACCOUNT_PATH on the server, and /health.\x1b[0m');
}

// --- 4. Serveur ------------------------------------------------------------
const server = argValue('server');
const token = argValue('token');

if (server && token) {
  console.log('\n\x1b[1m4. Server\x1b[0m');
  try {
    const res = await fetch(`${server.replace(/\/+$/, '')}/api/status`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const health = await res.json();
      ok('server reachable', `${health.events} events`);
      if (health.push?.configured) ok('FCM configured on the server');
      else bad('FCM not configured on the server', 'key missing or unreadable');
      console.log(`  \x1b[2m${health.push?.devices ?? 0} device(s) registered\x1b[0m`);
    } else {
      bad('server responded', `HTTP ${res.status}`);
    }
  } catch (err) {
    bad('server unreachable', err.message);
  }
} else {
  console.log('\n\x1b[1m4. Server\x1b[0m');
  console.log('  \x1b[2mSkipped. Pass --server <url> --token <token> to test it.\x1b[0m');
}

// --- Bilan -----------------------------------------------------------------
console.log('');
if (failures === 0 && warnings === 0) {
  console.log('\x1b[32mAll set.\x1b[0m Rebuild the APK, then in the app: Settings > Enable notifications.\n');
} else {
  console.log(`\x1b[31m${failures} blocker(s)\x1b[0m, \x1b[33m${warnings} warning(s)\x1b[0m.\n`);
}
process.exit(failures > 0 ? 1 : 0);
