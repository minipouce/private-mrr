import { EventEmitter } from 'node:events';
import type { EventRow } from '../db/repo.js';

/**
 * Internal bus linking Stripe ingestion to connected SSE clients.
 * Every event inserted into the database is republished here so the app can
 * display it in real time without another request.
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
// One SSE client per device, plus internal subscribers: the default limit of 10
// listeners is reached quickly without any leak being involved.
bus.setMaxListeners(100);
