import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfig } from '../config.js';
import { stripeFor } from './client.js';
import { db } from '../db/index.js';

/**
 * Récupération des logos de marque depuis Stripe.
 *
 * Chaque compte expose une icône dans ses paramètres de marque. On la télécharge
 * pour la servir depuis ce serveur plutôt que de pointer vers Stripe : les liens
 * de fichiers n'existent pas sur tous les comptes, et une notification push doit
 * pouvoir charger l'image sans authentification.
 */

const LOGO_DIR = process.env.LOGO_DIR ?? './data/logos';
const MAX_BYTES = 2 * 1024 * 1024;

// Le fichier est stocké sans extension : Stripe sert indifféremment du PNG ou
// du JPEG, et se fier au nom conduirait à annoncer un mauvais type MIME.
export function logoPath(projectId: string): string {
  return join(LOGO_DIR, projectId);
}

export function hasLogo(projectId: string): boolean {
  return existsSync(logoPath(projectId));
}

/** Type MIME déduit des octets de signature, jamais du nom de fichier. */
export function sniffImageType(buf: Buffer): 'image/png' | 'image/jpeg' | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return null;
}

/**
 * Télécharge le logo d'un projet. Retourne `true` si un fichier a été écrit.
 * Toute erreur est absorbée : un logo manquant ne doit jamais bloquer une
 * synchronisation ni l'ingestion d'un paiement.
 */
export async function syncLogo(project: ProjectConfig): Promise<boolean> {
  const stripe = stripeFor(project);
  if (!stripe) return false;

  try {
    // Appelé sans identifiant, l'endpoint renvoie le compte associé à la clé.
    // Le typage du SDK n'expose que la variante « compte connecté », qui exige
    // un identifiant. On réécrit le type de la ressource plutôt que d'extraire
    // la méthode : sortie de son objet, elle perdrait son `this` et échouerait
    // à l'exécution.
    const accounts = stripe.accounts as unknown as { retrieve(): Promise<unknown> };
    const account = (await accounts.retrieve()) as {
      settings?: { branding?: { icon?: string | null; logo?: string | null } | null } | null;
    };

    // L'icône est carrée et pensée pour les petits formats ; le logo, souvent
    // horizontal, ne sert que de repli.
    const fileId = account.settings?.branding?.icon ?? account.settings?.branding?.logo;
    if (!fileId) return false;

    const file = (await stripe.files.retrieve(fileId)) as unknown as {
      url?: string | null;
      size?: number | null;
    };
    if (!file.url) return false;
    if (file.size && file.size > MAX_BYTES) {
      console.warn(`[branding] ${project.id}: logo too large (${file.size} bytes), skipped`);
      return false;
    }

    // L'URL de contenu exige la clé du compte : ce n'est pas un lien public.
    const res = await fetch(file.url, {
      headers: { Authorization: `Bearer ${project.stripeKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return false;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES || !sniffImageType(buf)) return false;

    const target = logoPath(project.id);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf);

    db.prepare('UPDATE projects SET logo_updated_at = ? WHERE id = ?').run(
      Math.floor(Date.now() / 1000),
      project.id,
    );

    console.log(`[branding] ${project.id}: logo fetched (${sniffImageType(buf)}, ${buf.length} bytes)`);
    return true;
  } catch (err) {
    const message = (err as Error).message;
    // Une clé sans permission Account est un cas de figure normal, pas une panne.
    if (!/permission/i.test(message)) {
      console.warn(`[branding] ${project.id}: ${message.slice(0, 100)}`);
    }
    return false;
  }
}

export async function syncAllLogos(projects: readonly ProjectConfig[]): Promise<number> {
  let count = 0;
  for (const project of projects) {
    if (await syncLogo(project)) count++;
  }
  return count;
}
