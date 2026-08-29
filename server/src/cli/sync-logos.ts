/**
 * Récupère les logos de marque de tous les projets configurés.
 *   npm run sync-logos
 */
import 'dotenv/config';
import { config } from '../config.js';
import { syncProjectsFromConfig, db } from '../db/index.js';
import { syncAllLogos, hasLogo } from '../stripe/branding.js';

syncProjectsFromConfig();
const n = await syncAllLogos(config.projects);

console.log('');
for (const p of config.projects) {
  console.log(`  ${p.id.padEnd(12)} ${hasLogo(p.id) ? '✓ logo' : '— aucun'}`);
}
console.log(`\n  ${n} logo(s) récupéré(s) sur ${config.projects.length} projets`);
db.close();
