/**
 * Whether the dispatcher is in a turn, and the messages that wait for it to end. One turn at a time: a message that
 * arrives meanwhile queues (first come, first served) and goes when the turn settles. It knows nothing about pi: it is
 * given a `send(message)` that starts a turn, and is told when pi began and settled one.
 */

export class TurnQueue {
  /**
   * `send(message)` starts a turn and resolves to `{ disposition }` (`'handled'`: it was a command, no turn will follow).
   * `onChange(length)` is called whenever the number of waiting messages changes.
   */
  constructor({ send, onChange = () => {}, log = () => {} }) {
    this.send = send;
    this.onChange = onChange;
    this.log = log;
    /** A turn is running, or a prompt is on its way (a message that arrives now waits). */
    this.busy = false;
    /** Waiting messages, oldest first. */
    this.items = [];
  }

  /** A message from a person: queued when a turn runs, else started now. */
  submit(message) {
    if (this.busy) {
      this.items.push(message);
      this.onChange(this.items.length);
      return { disposition: 'queued', position: this.items.length };
    }
    return this.start(message);
  }

  /** Start a turn with this message, whatever the queue holds. */
  async start(message) {
    this.busy = true;
    try {
      const r = await this.send(message);
      // Handled without a turn (a command): nothing will settle, so the next message may go.
      if (r?.disposition === 'handled') this.busy = false;
      return { disposition: r?.disposition ?? null };
    } catch (err) {
      this.busy = false;
      throw err;
    }
  }

  /** pi began a turn (also one nobody here started, e.g. from another front end). */
  began() {
    this.busy = true;
  }

  /** The turn ended: the next message that waited goes. */
  settled() {
    this.busy = false;
    this.drain();
  }

  /** The process is gone: its turn is over, and the waiting messages cannot reach the conversation they were meant for. */
  closed() {
    this.busy = false;
    this.clear();
  }

  /** Be busy while `work` runs (a compaction): what arrives meanwhile waits, and goes after. */
  async hold(work) {
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
      this.drain();
    }
  }

  drain() {
    if (this.busy || !this.items.length) return;
    const next = this.items.shift();
    this.onChange(this.items.length);
    this.start(next).then(
      () => this.drain(),
      (err) => {
        this.log(`could not send a queued message: ${err.message}`);
        this.drain();
      },
    );
  }

  /** Take a waiting message back (a person changed their mind). */
  take(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) return { removed: false };
    this.items.splice(i, 1);
    this.onChange(this.items.length);
    return { removed: true };
  }

  /** Drop everything that waits. */
  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.onChange(0);
  }
}
