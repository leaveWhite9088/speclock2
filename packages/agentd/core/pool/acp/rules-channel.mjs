/**
 * How an executor's rules reach its CLI. The rules text (the common executor rules, plus its template's prompt) is
 * handed over through whatever the CLI offers for extra system instructions (see pool/system-prompt.mjs); a CLI with
 * no channel gets the text in front of the first prompt of each session. Nothing is written into the user's project.
 */

import { injectionFor } from '../system-prompt.mjs';

export class RulesChannel {
  /** `spec.systemPrompt` is the text, or a function giving it, so an edited template applies the next time it starts. */
  constructor({ type, name, spec }) {
    this.type = type;
    this.name = name;
    this.spec = spec;
    this._injection = null;
    /** Sessions whose first prompt already carried the rules (only for a CLI with no other channel). */
    this.primed = new Set();
  }

  /** The rules this agent must follow now, or null. */
  get text() {
    const p = this.spec.systemPrompt;
    return (typeof p === 'function' ? p() : p) || null;
  }

  /** How the rules reach this CLI. Worked out again when the text changed; writes the rules file in agentd's data directory. */
  injection() {
    const text = this.text;
    if (!this._injection || this._injection.text !== text) this._injection = { ...injectionFor(this.type, text, this.name), text };
    return this._injection;
  }

  /** Where the rules go, in words (for the status). */
  via() {
    const i = this.injection();
    return i.prefix ? 'first message' : i.args.length ? i.args[0] : Object.keys(i.env)[0] ?? (i.meta ? `_meta.${Object.keys(i.meta)[0]}` : null);
  }

  /** The `_meta` of session requests, for the CLIs that take the rules there. */
  meta() {
    const meta = this.injection().meta;
    return meta ? { _meta: meta } : {};
  }

  /** A CLI with no channel gets the rules in front of the first prompt of a session, and again after a compaction. */
  withRules(text, sessionId) {
    if (!this.injection().prefix || !sessionId || this.primed.has(sessionId)) return text;
    this.primed.add(sessionId);
    return `${this.text.trim()}\n\n---\n\n${text}`;
  }
}
