/**
 * Handoff: move an executor to a fresh session of its own, carrying a handoff document.
 *
 * The dispatcher can only *propose* one (with a reason). A person then drives it in two steps, so they see the
 * document before anything changes:
 *   1. generate: the executor's current session writes the document as its reply;
 *   2. apply:    the person may edit the text; agentd starts a new session and gives it the document.
 * The old session is kept. Proposals live in memory. Nothing is written into the executor's directory and no skill
 * file is needed: the instructions are in the prompt, and the document travels as text. A copy of every applied
 * document is kept under agentd's data/handoffs/.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './pool/config.mjs';
import { handoffStartPrompt, handoffWritePrompt } from './rules.mjs';

const COPIES_DIR = join(DATA_DIR, 'handoffs');
const OPEN = ['pending', 'generating', 'review', 'applying'];

/** A readable short form of a conversation's id: executors have a uuid, the dispatcher's is a file `<time>_<uuid>.jsonl`. */
const shortSession = (id) => {
  const base = String(id ?? '').split(/[\\/]/).pop().replace(/\.jsonl$/, '');
  return (base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base).slice(0, 8);
};

/** What the conversation view shows instead of the long prompts (contexts/handoff-write.md, handoff-start.md). */
const SHOWN_WRITE = '（交接）请写出这个会话的交接文档';
const SHOWN_START = '（交接）新会话开始，已收到上一个会话的交接文档';

/**
 * @param {{ getAgent: (key: string) => any, keyOf: (project: string, id: string) => string, onChange: (p: object) => void }} deps
 */
export function createHandoffs({ getAgent, keyOf, onChange }) {
  /** @type {Map<string, any>} */
  const proposals = new Map();
  let seq = 0;

  const view = (p) => ({
    id: p.id, project: p.project, agent: p.agent, reason: p.reason, evidence: p.evidence, status: p.status,
    doc: p.doc ?? null, error: p.error ?? null, oldSession: p.oldSession ?? null, newSession: p.newSession ?? null,
    createdAt: p.createdAt,
  });
  const touch = (p, patch) => {
    Object.assign(p, patch);
    onChange(view(p));
    return view(p);
  };
  const get = (id) => {
    const p = proposals.get(id);
    if (!p) throw new Error(`unknown handoff "${id}"`);
    return p;
  };

  function propose({ project, agent, reason, evidence }) {
    const key = keyOf(project, agent);
    getAgent(key); // throws when the executor does not exist
    const open = [...proposals.values()].find((p) => p.key === key && OPEN.includes(p.status));
    if (open) return view(open);
    const p = {
      id: `h${++seq}-${Date.now().toString(36)}`, project, agent, key,
      reason: String(reason ?? '').slice(0, 1000), evidence: String(evidence ?? '').slice(0, 2000),
      status: 'pending', createdAt: new Date().toISOString(),
    };
    proposals.set(p.id, p);
    return touch(p, {});
  }

  const list = ({ project } = {}) => ({
    handoffs: [...proposals.values()].filter((p) => OPEN.includes(p.status) && (project ? p.project === project : true)).map(view),
  });

  /** Step 1: the current session writes the document. Returns at once; progress comes as change events. */
  function generate({ id }) {
    const p = get(id);
    if (p.status !== 'pending') throw new Error(`handoff is ${p.status}, not pending`);
    const a = getAgent(p.key);
    if (a.busy) throw new Error(`${p.agent} is working; try again when it is idle`);
    const prompt = handoffWritePrompt(); // read first: a missing file must fail before anything changes
    touch(p, { status: 'generating', error: null, oldSession: a.sessionId ?? a.preferSession ?? null });
    a.startPrompt(prompt, { timeoutMs: 300_000, display: SHOWN_WRITE })
      .done.then((r) => {
        const doc = String(r?.text ?? '').trim();
        if (!doc) throw new Error('the executor returned an empty handoff document');
        touch(p, { status: 'review', doc });
      })
      .catch((err) => touch(p, { status: 'pending', error: err.message }));
    return view(p);
  }

  /** Step 2: new session, document handed over. `text` is the document as the person left it. */
  function apply({ id, text }) {
    const p = get(id);
    if (p.status !== 'review') throw new Error(`handoff is ${p.status}, not ready to apply`);
    const a = getAgent(p.key);
    if (a.busy) throw new Error(`${p.agent} is working; try again when it is idle`);
    const doc = typeof text === 'string' && text.trim() ? text : p.doc;
    const startText = handoffStartPrompt(doc); // read first, for the same reason
    // A dated copy, for the record. Best effort: the handover does not depend on it.
    try {
      const dir = join(COPIES_DIR, String(p.key).replace(/[^A-Za-z0-9._~-]/g, '_'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`), doc, 'utf8');
    } catch {
      /* ignore */
    }
    touch(p, { status: 'applying', error: null });
    (async () => {
      const sessionId = await a.newSession();
      await Promise.resolve(a.renameSession(sessionId, `交接自 ${shortSession(p.oldSession)}`)).catch(() => {});
      touch(p, { newSession: sessionId });
      await a.startPrompt(startText, { timeoutMs: 300_000, display: SHOWN_START }).done;
      touch(p, { status: 'done' });
    })().catch((err) => touch(p, { status: 'review', error: err.message }));
    return view(p);
  }

  function cancel({ id }) {
    const p = get(id);
    if (['generating', 'applying'].includes(p.status)) throw new Error(`handoff is ${p.status}; wait for it to finish`);
    return touch(p, { status: 'cancelled' });
  }

  return { propose, list, generate, apply, cancel };
}
