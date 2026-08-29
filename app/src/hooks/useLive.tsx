import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Haptics from 'expo-haptics';
import { api, ApiError } from '../api/client';
import { connectStream, type SseConnection } from '../api/sse';
import { loadConfig } from '../api/config';
import type { Overview, RevenueEvent } from '../api/types';
import { refreshWidget } from '../widget/refresh';
import { t } from '../i18n';

type Status = 'loading' | 'live' | 'offline' | 'unconfigured' | 'error';

interface LiveState {
  overview: Overview | null;
  events: RevenueEvent[];
  status: Status;
  error: string | null;
  /** Identifiant du dernier événement reçu en direct, pour animer sa ligne. */
  flashId: number | null;
  refresh: () => Promise<void>;
  reconfigure: () => Promise<void>;
}

const LiveContext = createContext<LiveState | null>(null);

const MAX_EVENTS = 200;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<RevenueEvent[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<number | null>(null);

  const streamRef = useRef<SseConnection | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const config = await loadConfig();
    if (!config) {
      setStatus('unconfigured');
      return;
    }

    try {
      const [snapshot, feed] = await Promise.all([api.overview(), api.events({ limit: 60 })]);
      if (!mountedRef.current) return;
      setOverview(snapshot);
      setEvents(feed.events);
      setError(null);
      setStatus('live');
      // Android ne rafraîchit le widget que toutes les 30 minutes au mieux :
      // on le remet à jour dès qu'on dispose de chiffres frais.
      void refreshWidget();
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof ApiError ? err.message : t('unexpectedError');
      setError(message);
      setStatus(err instanceof ApiError && err.status === 0 ? 'offline' : 'error');
    }
  }, []);

  const openStream = useCallback(async () => {
    streamRef.current?.close();

    const config = await loadConfig();
    if (!config) return;

    streamRef.current = connectStream({
      onOpen: () => {
        if (mountedRef.current) {
          setStatus('live');
          setError(null);
        }
      },
      onError: (message) => {
        if (!mountedRef.current) return;
        setStatus(message === t('tokenRejected') ? 'error' : 'offline');
        setError(message);
      },
      onEvent: (type, data) => {
        if (!mountedRef.current) return;

        if (type === 'metrics') {
          setOverview(data as Overview);
          void refreshWidget();
          return;
        }

        if (type === 'event') {
          const incoming = data as RevenueEvent;
          setEvents((prev) => {
            // Le backfill et le direct peuvent se recouper : on déduplique.
            if (prev.some((e) => e.id === incoming.id)) return prev;
            return [incoming, ...prev].slice(0, MAX_EVENTS);
          });
          setFlashId(incoming.id);

          // Retour haptique : un encaissement se sent sans regarder l'écran.
          if (incoming.kind === 'payment' || incoming.kind === 'subscription_created') {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } else if (
            incoming.kind === 'subscription_canceled' ||
            incoming.kind === 'payment_failed'
          ) {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          }
        }
      },
    });
  }, []);

  const start = useCallback(async () => {
    await load();
    await openStream();
  }, [load, openStream]);

  useEffect(() => {
    mountedRef.current = true;
    void start();

    // Android suspend les sockets en arrière-plan : au retour au premier plan
    // on resynchronise puis on rouvre le flux, sinon l'écran affiche des
    // chiffres périmés sans que rien ne le signale.
    const onAppState = (next: AppStateStatus) => {
      if (next === 'active') void start();
      else streamRef.current?.close();
    };

    const sub = AppState.addEventListener('change', onAppState);

    // Filet de sécurité indépendant du flux : même si le SSE échouait
    // silencieusement malgré son chien de garde, les chiffres ne resteraient
    // jamais périmés plus de 90 secondes.
    const safetyNet = setInterval(() => {
      if (AppState.currentState === 'active') void load();
    }, 90_000);

    return () => {
      mountedRef.current = false;
      sub.remove();
      clearInterval(safetyNet);
      streamRef.current?.close();
    };
  }, [start, load]);

  const value = useMemo<LiveState>(
    () => ({
      overview,
      events,
      status,
      error,
      flashId,
      refresh: load,
      reconfigure: start,
    }),
    [overview, events, status, error, flashId, load, start],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  const context = useContext(LiveContext);
  if (!context) throw new Error('useLive doit être utilisé dans un LiveProvider');
  return context;
}
