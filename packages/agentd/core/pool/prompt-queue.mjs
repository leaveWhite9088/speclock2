/**
 * The line an agent's work waits in. One thing runs at a time, in the order it was handed over; a prompt that has not
 * started yet can be cancelled by its job id, and its caller is answered at once (it only leaves the line when its turn
 * comes). Session operations go through the same line, so they never overlap a running prompt.
 */

export class PromptQueue {
  /** `touch` is called whenever work is queued or finishes (the pool uses it to recycle idle processes). */
  constructor({ touch = () => {} } = {}) {
    this.touch = touch;
    this.tail = Promise.resolve();
    /** Prompts handed over and not finished yet (running or waiting their turn). */
    this.inflight = 0;
    /** Prompts waiting their turn: jobId -> { text, at }. */
    this.queuedJobs = new Map();
    /** jobId -> answers its caller now, for a prompt that waits. */
    this.earlyCancel = new Map();
    /** Waiting prompts cancelled before their turn came. */
    this.cancelledJobs = new Set();
  }

  /** Run `task` after everything ahead of it, whether that succeeded or not. */
  enqueue(task) {
    this.touch();
    const run = this.tail.then(task, task);
    this.tail = run.then(this.touch, this.touch);
    return run;
  }

  /**
   * Put a prompt in line. `task` runs when its turn comes (unless it was cancelled meanwhile, then `cancelled()` is the
   * error). Returns `{ done, ahead }`: `done` settles when the task does, or at once when the prompt is cancelled while it
   * waits; `ahead` is how many were in line before it.
   */
  submit(jobId, label, task, cancelled) {
    const ahead = this.inflight;
    this.inflight += 1;
    this.queuedJobs.set(jobId, { text: String(label).slice(0, 300), at: Date.now() });
    let answerNow;
    const early = new Promise((_, reject) => {
      answerNow = () => reject(cancelled());
    });
    this.earlyCancel.set(jobId, answerNow);
    const chain = this.enqueue(async () => {
      this.queuedJobs.delete(jobId);
      this.earlyCancel.delete(jobId);
      if (this.cancelledJobs.delete(jobId)) throw cancelled();
      return task();
    });
    const leave = () => {
      this.inflight -= 1;
    };
    chain.then(leave, leave);
    return { done: Promise.race([chain, early]), ahead };
  }

  /** Cancel a prompt that is still waiting. False when it is not waiting (running, over, or unknown). */
  cancelWaiting(jobId) {
    if (!this.queuedJobs.has(jobId)) return false;
    this.cancelledJobs.add(jobId);
    this.earlyCancel.get(jobId)?.();
    return true;
  }

  /** The waiting prompts that nobody has cancelled, oldest first. */
  waiting() {
    return [...this.queuedJobs].filter(([id]) => !this.cancelledJobs.has(id)).map(([jobId, j]) => ({ jobId, text: j.text, at: j.at }));
  }
}
