import { loadConfig } from '../api/config';
import { moneyCompact, percent } from '../lib/format';
import type { Overview } from '../api/types';
import type { WidgetData } from './MrrWidget';

/**
 * Données du widget.
 *
 * Partagé entre le gestionnaire de tâche — réveillé par Android hors de
 * l'application — et le rafraîchissement déclenché depuis l'application. Les
 * deux doivent produire exactement le même contenu, sans quoi l'un écraserait
 * le travail de l'autre.
 */
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

export async function loadWidgetData(): Promise<WidgetData> {
  const config = await loadConfig();
  if (!config) return fallback("Ouvre l'app pour configurer");

  try {
    const res = await fetch(`${config.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${config.token}` },
      // Android interrompt une tâche de widget trop longue : mieux vaut
      // renoncer proprement que d'être tué en plein rendu.
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401) return fallback('Jeton refusé');
    if (!res.ok) return fallback(`Erreur ${res.status}`);

    const data = (await res.json()) as Overview;
    const t = data.total;
    const now = new Date();

    return {
      mrr: moneyCompact(t.mrrCents, t.currency),
      today: moneyCompact(t.todayCents, t.currency),
      mtd: moneyCompact(t.mtdCents, t.currency),
      delta: t.mtdVsPrevPct !== null ? `${percent(t.mtdVsPrevPct)} vs mois dernier` : null,
      deltaPositive: (t.mtdVsPrevPct ?? 0) >= 0,
      updatedAt: `à ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    };
  } catch {
    return fallback('Serveur injoignable');
  }
}
