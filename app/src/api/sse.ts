import { loadConfig } from './config';
import { t } from '../i18n';

/**
 * Client SSE minimal bâti sur XMLHttpRequest.
 *
 * `EventSource` n'existe pas en React Native et ne permettrait de toute façon
 * pas d'envoyer l'en-tête `Authorization` — la seule alternative serait de
 * passer le jeton en paramètre d'URL, où il finirait dans les journaux d'accès
 * du reverse-proxy. XHR expose la réponse au fil de l'eau et accepte les
 * en-têtes : on parse le flux nous-mêmes.
 */
export interface SseHandlers {
  onEvent?: (type: string, data: unknown) => void;
  onOpen?: () => void;
  onError?: (message: string) => void;
}

export interface SseConnection {
  close: () => void;
}

export function connectStream(handlers: SseHandlers): SseConnection {
  let xhr: XMLHttpRequest | null = null;
  let closed = false;
  let retryDelay = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastActivity = Date.now();

  /**
   * Le serveur émet une trame de maintien toutes les 25 s. Au-delà de 70 s de
   * silence, la connexion est considérée morte.
   *
   * C'est indispensable sur mobile : un basculement Wi-Fi/4G, une veille, ou un
   * redémarrage du serveur laissent la socket ouverte côté Android sans jamais
   * déclencher `error` ni `readyState 4`. Sans ce garde-fou, l'app affiche
   * « en direct » tout en étant sourde.
   */
  const startWatchdog = () => {
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(() => {
      if (closed) return;
      if (Date.now() - lastActivity > 70_000) {
        xhr?.abort();
        scheduleRetry(false);
      }
    }, 15_000);
  };

  const start = async () => {
    if (closed) return;

    const config = await loadConfig();
    if (!config) {
      handlers.onError?.(t('serverNotConfigured'));
      return;
    }

    // Index du dernier octet déjà traité : XHR accumule la réponse entière,
    // on ne relit donc que le nouveau fragment à chaque progression.
    let consumed = 0;
    let buffer = '';

    const req = new XMLHttpRequest();
    xhr = req;
    req.open('GET', `${config.baseUrl}/api/stream`);
    req.setRequestHeader('Authorization', `Bearer ${config.token}`);
    req.setRequestHeader('Accept', 'text/event-stream');
    req.setRequestHeader('Cache-Control', 'no-cache');
    // Sans ce type explicite, React Native peut mettre la réponse en tampon
    // au lieu de l'exposer au fil de l'eau.
    req.responseType = 'text';

    const flush = () => {
      // Un bloc SSE est terminé par une ligne vide. Tout reliquat reste en
      // tampon jusqu'à réception de la fin du bloc.
      let index: number;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        let eventType = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // trame de maintien
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;

        try {
          handlers.onEvent?.(eventType, JSON.parse(dataLines.join('\n')));
        } catch {
          // Fragment illisible : on l'ignore plutôt que de rompre le flux.
        }
      }
    };

    /**
     * Consomme la portion de réponse pas encore traitée.
     *
     * React Native accumule tout dans `responseText` : on ne relit donc que le
     * nouveau fragment, repéré par l'index du dernier octet consommé.
     */
    const drain = () => {
      if (closed) return;
      let text: string;
      try {
        text = req.responseText ?? '';
      } catch {
        return; // corps pas encore lisible selon l'état du transfert
      }
      if (text.length > consumed) {
        lastActivity = Date.now();
        buffer += text.slice(consumed);
        consumed = text.length;
        flush();
      }
    };

    // React Native ne rejoue pas `readystatechange` à chaque fragment reçu,
    // contrairement aux navigateurs : c'est `progress` qui porte le flux.
    // On écoute les deux pour être indépendant de l'implémentation.
    req.onprogress = drain;

    req.onreadystatechange = () => {
      if (closed) return;

      if (req.readyState === 2 && req.status === 200) {
        retryDelay = 1000;
        lastActivity = Date.now();
        startWatchdog();
        handlers.onOpen?.();
      }

      if (req.readyState >= 3) drain();

      if (req.readyState === 4) scheduleRetry(req.status === 401);
    };

    req.onerror = () => scheduleRetry(false);
    req.ontimeout = () => scheduleRetry(false);
    req.send();
  };

  const scheduleRetry = (unauthorized: boolean) => {
    if (closed) return;

    if (unauthorized) {
      handlers.onError?.(t('tokenRejected'));
      return; // inutile de réessayer avec un jeton invalide
    }

    handlers.onError?.(t('connectionLost'));
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(start, retryDelay);
    // Repli exponentiel plafonné : évite de marteler un serveur en panne.
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };

  void start();

  return {
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (watchdog) clearInterval(watchdog);
      xhr?.abort();
      xhr = null;
    },
  };
}
