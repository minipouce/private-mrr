import { EventEmitter } from 'node:events';
import type { EventRow } from '../db/repo.js';

/**
 * Bus interne reliant l'ingestion Stripe aux clients SSE connectés.
 * Chaque événement inséré en base est republié ici pour un affichage
 * temps réel dans l'app sans nouvelle requête.
 */
class LiveBus extends EventEmitter {
  publishEvent(event: EventRow): void {
    this.emit('event', event);
  }

  publishMetricsDirty(): void {
    this.emit('metrics:dirty');
  }
}

export const bus = new LiveBus();
// Un client SSE par appareil, plus les abonnés internes : la limite par défaut
// de 10 listeners est vite atteinte sans que ce soit une fuite.
bus.setMaxListeners(100);
