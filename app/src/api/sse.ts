import { loadConfig } from './config';
import { t } from '../i18n';

/**
 * Minimal SSE client built on XMLHttpRequest.
 *
 * `EventSource` does not exist in React Native, and would not let us send the
 * `Authorization` header anyway. The only alternative would be passing the
 * token as a URL parameter, where it would end up in the reverse proxy's
 * access logs. XHR exposes the response as it arrives and accepts headers, so
 * we parse the stream ourselves.
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
   * The server emits a keepalive frame every 25s. Past 70s of silence, the
   * connection is considered dead.
   *
   * This is essential on mobile: a Wi-Fi/4G handover, a sleep, or a server
   * restart leaves the socket open on the Android side without ever firing
   * `error` or reaching `readyState 4`. Without this guard, the app displays
   * "live" while being deaf.
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

    // Index of the last byte already handled: XHR accumulates the whole
    // response, so only the new fragment is read on each progress event.
    let consumed = 0;
    let buffer = '';

    const req = new XMLHttpRequest();
    xhr = req;
    req.open('GET', `${config.baseUrl}/api/stream`);
    req.setRequestHeader('Authorization', `Bearer ${config.token}`);
    req.setRequestHeader('Accept', 'text/event-stream');
    req.setRequestHeader('Cache-Control', 'no-cache');
    // Without this explicit type, React Native may buffer the response instead
    // of exposing it as it arrives.
    req.responseType = 'text';

    const flush = () => {
      // An SSE block ends with a blank line. Anything left over stays buffered
      // until the end of the block arrives.
      let index: number;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        let eventType = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // keepalive frame
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;

        try {
          handlers.onEvent?.(eventType, JSON.parse(dataLines.join('\n')));
        } catch {
          // Unreadable fragment: skip it rather than break the stream.
        }
      }
    };

    /**
     * Consumes the part of the response not yet handled.
     *
     * React Native accumulates everything in `responseText`, so only the new
     * fragment is read, located by the index of the last consumed byte.
     */
    const drain = () => {
      if (closed) return;
      let text: string;
      try {
        text = req.responseText ?? '';
      } catch {
        return; // body not readable yet at this point of the transfer
      }
      if (text.length > consumed) {
        lastActivity = Date.now();
        buffer += text.slice(consumed);
        consumed = text.length;
        flush();
      }
    };

    // Unlike browsers, React Native does not replay `readystatechange` on each
    // received fragment: `progress` is what carries the stream. Both are
    // listened to, so this does not depend on the implementation.
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
      return; // no point retrying with an invalid token
    }

    handlers.onError?.(t('connectionLost'));
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(start, retryDelay);
    // Capped exponential backoff: avoids hammering a server that is down.
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
