import * as SecureStore from 'expo-secure-store';
import { loadConfig } from '../api/config';
import { moneyCompact, percent } from '../lib/format';
import type { Overview } from '../api/types';
import type { WidgetData } from './MrrWidget';
import { t } from '../i18n';

/**
 * Données du widget, avec conservation des derniers chiffres connus.
 *
 * Android place le téléphone inactif en mode Doze et coupe l'accès réseau des
 * applications en arrière-plan. Le rafraîchissement périodique se déclenche donc
 * bien, mais son appel échoue — et remplacer alors les chiffres par un message
 * d'erreur est le pire des choix : une donnée d'il y a deux heures reste utile,
 * « serveur injoignable » ne l'est jamais.
 *
 * On conserve donc le dernier résultat et on l'affiche en le datant, plutôt que
 * de le perdre.
 */

const CACHE_KEY = 'mrr.widget_cache';

function fallback(message: string): WidgetData {
  return {
    mrr: '—',
    today: '—',
    mtd: '—',
    delta: null,
    deltaPositive: true,
    updatedAt: '',
    error: message,
  };
}

function stamp(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

async function readCache(): Promise<WidgetData | null> {
  try {
    const raw = await SecureStore.getItemAsync(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WidgetData;
    // Un cache sans montant n'a aucune valeur : autant repartir de zéro.
    return parsed?.mrr ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(data: WidgetData): Promise<void> {
  try {
    await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(data));
  } catch {
    // Un cache indisponible dégrade le confort, pas le fonctionnement.
  }
}

export async function loadWidgetData(): Promise<WidgetData> {
  const config = await loadConfig();
  if (!config) return fallback(t('widgetConfigure'));

  const cached = await readCache();

  try {
    const res = await fetch(`${config.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${config.token}` },
      // Android interrompt une tâche de widget trop longue : mieux vaut
      // renoncer proprement que d'être tué en plein rendu.
      signal: AbortSignal.timeout(12_000),
    });

    // Un jeton refusé n'a rien de passager : le signaler vaut mieux que
    // d'afficher indéfiniment des chiffres que plus rien ne rafraîchira.
    if (res.status === 401) return fallback(t('widgetTokenRejected'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as Overview;
    const m = data.total;

    const fresh: WidgetData = {
      mrr: moneyCompact(m.mrrCents, m.currency),
      today: moneyCompact(m.todayCents, m.currency),
      mtd: moneyCompact(m.mtdCents, m.currency),
      delta: m.mtdVsPrevPct !== null ? `${percent(m.mtdVsPrevPct)} vs mois dernier` : null,
      deltaPositive: (m.mtdVsPrevPct ?? 0) >= 0,
      updatedAt: `à ${stamp(new Date())}`,
    };

    await writeCache(fresh);
    return fresh;
  } catch {
    // Réseau coupé, veille profonde, serveur muet : on garde ce qu'on sait,
    // en indiquant que la donnée n'est plus fraîche.
    if (cached) return { ...cached, stale: true };
    return fallback(t('widgetUnreachable'));
  }
}
