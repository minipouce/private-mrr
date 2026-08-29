/**
 * Fetches the brand logos of every configured project.
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
  console.log(`  ${p.id.padEnd(12)} ${hasLogo(p.id) ? '✓ logo' : '- none'}`);
}
console.log(`\n  ${n} logo(s) fetched across ${config.projects.length} projects`);
db.close();
