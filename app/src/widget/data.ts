import * as SecureStore from 'expo-secure-store';
import { loadConfig } from '../api/config';
import { moneyCompact, percent } from '../lib/format';
import type { Overview } from '../api/types';
import type { WidgetData } from './MrrWidget';
import { t } from '../i18n';

/**
 * Widget data, keeping the last known figures.
 *
 * Android puts an idle phone into Doze mode and cuts network access for
 * background applications. The periodic refresh does fire, but its request
 * fails, and replacing the figures with an error message is the worst possible
 * choice: two-hour-old data is still useful, "server unreachable" never is.
 *
 * So the last result is kept and displayed with its timestamp, rather than
 * being thrown away.
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
    // A cache with no amount is worthless: start from scratch instead.
    return parsed?.mrr ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(data: WidgetData): Promise<void> {
  try {
    await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(data));
  } catch {
    // An unavailable cache degrades comfort, not correctness.
  }
}

export async function loadWidgetData(): Promise<WidgetData> {
  const config = await loadConfig();
  if (!config) return fallback(t('widgetConfigure'));

  const cached = await readCache();

  try {
    const res = await fetch(`${config.baseUrl}/api/overview`, {
      headers: { Authorization: `Bearer ${config.token}` },
      // Android kills a widget task that runs too long: better to give up
      // cleanly than to be killed mid-render.
      signal: AbortSignal.timeout(12_000),
    });

    // A rejected token is not transient: saying so beats displaying figures
    // indefinitely that nothing will ever refresh again.
    if (res.status === 401) return fallback(t('widgetTokenRejected'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as Overview;
    const m = data.total;

    const fresh: WidgetData = {
      mrr: moneyCompact(m.mrrCents, m.currency),
      today: moneyCompact(m.todayCents, m.currency),
      mtd: moneyCompact(m.mtdCents, m.currency),
      delta: m.mtdVsPrevPct !== null ? `${percent(m.mtdVsPrevPct)} ${t('widgetVsLastMonth')}` : null,
      deltaPositive: (m.mtdVsPrevPct ?? 0) >= 0,
      updatedAt: t('widgetUpdatedAt', { time: stamp(new Date()) }),
    };

    await writeCache(fresh);
    return fresh;
  } catch {
    // No network, deep sleep, silent server: keep what we know and mark the
    // data as no longer fresh.
    if (cached) return { ...cached, stale: true };
    return fallback(t('widgetUnreachable'));
  }
}
