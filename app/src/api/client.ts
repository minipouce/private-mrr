import { loadConfig } from './config';
import type {
  Overview, RevenueEvent, DailyPoint, MonthlyPoint,
  Subscriber, NotificationPrefs, ProjectInfo, Metrics,
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const config = await loadConfig();
  if (!config) throw new ApiError('Serveur non configuré', 0);

  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      // Un réseau mobile qui décroche ne doit pas laisser l'écran figé.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ApiError(
      (err as Error).name === 'TimeoutError'
        ? 'Le serveur ne répond pas'
        : 'Serveur injoignable',
      0,
    );
  }

  if (response.status === 401) {
    throw new ApiError('Jeton refusé par le serveur', 401);
  }
  if (!response.ok) {
    throw new ApiError(`Erreur serveur (${response.status})`, response.status);
  }
  return (await response.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return entries.length
    ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`
    : '';
};

export const api = {
  status: () =>
    request<{
      ok: boolean;
      events: number;
      projects: number;
      push: { configured: boolean; devices: number };
    }>('/api/status'),

  overview: () => request<Overview>('/api/overview'),

  projects: () => request<ProjectInfo[]>('/api/projects'),

  project: (id: string) => request<Metrics>(`/api/projects/${encodeURIComponent(id)}`),

  events: (params: { project?: string; kind?: string; limit?: number; before?: number } = {}) =>
    request<{ events: RevenueEvent[]; nextCursor: number | null }>(`/api/events${qs(params)}`),

  daily: (days = 30, project?: string) =>
    request<{ series: DailyPoint[] }>(`/api/series/daily${qs({ days, project })}`),

  monthly: (months = 12, project?: string) =>
    request<{ series: MonthlyPoint[] }>(`/api/series/monthly${qs({ months, project })}`),

  subscribers: (project?: string, limit = 100) =>
    request<{ subscribers: Subscriber[] }>(`/api/subscribers${qs({ project, limit })}`),

  setProjectIncluded: (projectId: string, included: boolean) =>
    request<ProjectInfo>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ include_in_totals: included }),
    }),

  setProjectGoal: (projectId: string, cents: number | null, kind: 'mrr' | 'arr') =>
    request<ProjectInfo>(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ goal_cents: cents, goal_kind: kind }),
    }),

  goal: () => request<{ cents: number; kind: string } | null>('/api/goal'),

  setGlobalGoal: (cents: number | null, kind: 'mrr' | 'arr') =>
    request<{ cents: number; kind: string } | null>('/api/goal', {
      method: 'PUT',
      body: JSON.stringify({ goal_cents: cents, goal_kind: kind }),
    }),

  prefs: () => request<NotificationPrefs[]>('/api/prefs'),

  updatePrefs: (projectId: string, body: Partial<Record<string, boolean | number>>) =>
    request<NotificationPrefs>(`/api/prefs/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  registerPush: (token: string, deviceName?: string) =>
    request<{ ok: boolean }>('/api/push/register', {
      method: 'POST',
      body: JSON.stringify({ token, deviceName }),
    }),

  testPush: () => request<{ sent: number }>('/api/push/test', { method: 'POST' }),

  reconcile: () => request<{ reconciled: number }>('/api/sync/reconcile', { method: 'POST' }),
};
