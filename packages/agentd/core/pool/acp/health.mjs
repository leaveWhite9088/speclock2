/**
 * How often an executor's process had to be killed because it ignored a cancel. Killed too often lately, it is marked
 * unstable and gets no more work until a person has looked at it and recovered it. Pure bookkeeping: it kills nothing.
 */

import { FORCED_STOP_LIMIT, FORCED_STOP_WINDOW_MS } from '../config.mjs';

export class StopHealth {
  constructor({ limit = FORCED_STOP_LIMIT, windowMs = FORCED_STOP_WINDOW_MS } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** Times (ms) of the kills inside the window, as of the last one. */
    this.stops = [];
  }

  /** A process was killed now. Returns how many kills lie inside the window, this one included. */
  note(now = Date.now()) {
    this.stops = [...this.stops.filter((t) => now - t < this.windowMs), now];
    return this.stops.length;
  }

  get count() {
    return this.stops.length;
  }

  /** Killed too often lately: no more work until `recover()`. */
  get unstable() {
    const now = Date.now();
    return this.stops.filter((t) => now - t < this.windowMs).length >= this.limit;
  }

  /** A person looked at it: forget the recent kills. */
  recover() {
    this.stops = [];
  }

  /** The window, in minutes, for messages. */
  get windowMinutes() {
    return Math.round(this.windowMs / 60_000);
  }
}
