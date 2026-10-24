import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '@/components/ui/toast';
import { api, enc, pq } from '@/lib/api';
import { onLive } from '@/lib/events';
import type { Item, Member, Session, TranscriptEntry } from '@/lib/types';
import { DISPATCHER, useUi } from '@/store';

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? (c as { type?: string; text?: string }[]).map((x) => (x.type === 'text' ? (x.text ?? '') : '')).filter(Boolean).join('\n') : '';

interface PiMessage {
  role: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  durationMs?: number;
  details?: { attempt?: number; maxAttempts?: number; durationMs?: number };
}

type Dispatch = Extract<Item, { kind: 'dispatch' }>;

const argOf = (a: unknown) => (a ?? {}) as { agent?: string; prompt?: string };

/** The task tag the dispatcher tool prints after every result and error: "[task t-1, attempt 2 of 3, job j]". */
const TAG = /\[task [^,\]]+, attempt (\d+) of (\d+)/;

/** A dispatch line once its result is in. */
function settle(it: Dispatch, text: string, isError: boolean, details?: { attempt?: number; maxAttempts?: number; durationMs?: number }, durationMs?: number): Dispatch {
  const tag = TAG.exec(text);
  return {
    ...it,
    state: isError ? 'fail' : 'done',
    attempt: details?.attempt ?? (tag ? Number(tag[1]) : it.attempt),
    maxAttempts: details?.maxAttempts ?? (tag ? Number(tag[2]) : it.maxAttempts),
    reply: text.slice(0, 4000),
    tookMs: details?.durationMs ?? durationMs ?? (it.startedAt ? Date.now() - it.startedAt : undefined),
  };
}

/** The dispatcher's history (pi's own message format) as view items. */
function fromPi(messages: PiMessage[], turns: { at: number; tookMs: number }[], next: () => string): Item[] {
  const out: Item[] = [];
  // How long a turn took goes under its last answer.
  let lastSay = -1;
  let turnTook: number | undefined;
  const closeTurn = () => {
    if (turnTook != null && lastSay >= 0) out[lastSay] = { ...(out[lastSay] as Extract<Item, { kind: 'user' | 'assistant' | 'error' }>), tookMs: turnTook, tookLabel: '本轮用时' };
    lastSay = -1;
    turnTook = undefined;
  };
  for (const msg of messages) {
    if (msg.role === 'user') {
      closeTurn();
      turnTook = turns.find((t) => t.at === msg.timestamp)?.tookMs;
      out.push({ id: next(), kind: 'user', text: textOf(msg.content) });
    } else if (msg.role === 'assistant') {
      for (const c of (msg.content ?? []) as { type: string; text?: string; name?: string; id?: string; arguments?: unknown }[]) {
        if (c.type === 'text' && c.text?.trim()) {
          out.push({ id: next(), kind: 'assistant', text: c.text, who: '调度器' });
          lastSay = out.length - 1;
        } else if (c.type === 'toolCall' && c.name === 'agent_run') {
          const a = argOf(c.arguments);
          out.push({ id: next(), kind: 'dispatch', agent: a.agent ?? '默认执行者', prompt: a.prompt ?? '', state: 'run', toolCallId: c.id });
        } else if (c.type === 'toolCall') out.push({ id: next(), kind: 'tool', name: c.name ?? 'tool', detail: JSON.stringify(c.arguments ?? {}, null, 2), result: false });
      }
    } else if (msg.role === 'toolResult' && msg.toolName === 'agent_run') {
      const at = out.findIndex((i) => i.kind === 'dispatch' && i.toolCallId === msg.toolCallId);
      if (at >= 0) out[at] = settle(out[at] as Dispatch, textOf(msg.content), Boolean(msg.isError), msg.details, msg.durationMs);
    } else if (msg.role === 'toolResult') out.push({ id: next(), kind: 'tool', name: msg.toolName ?? 'tool', detail: textOf(msg.content).slice(0, 1500), result: true });
  }
  closeTurn();
  // A dispatch with no result that the conversation has moved past never came back (the daemon stopped meanwhile).
  out.forEach((it, i) => {
    if (it.kind === 'dispatch' && it.state === 'run' && out.slice(i + 1).some((x) => x.kind === 'user')) out[i] = { ...it, state: 'fail', reply: '没有收到结果：执行过程被中断了。' };
  });
  return out;
}

/**
 * The conversation with the selected member: the dispatcher's history plus its live stream, or an executor's
 * transcript (pulled while it works, since its tool calls and text only reach the disk).
 * Items are kept in a ref and copied to state on every change, so async callbacks never see a stale list.
 */
export function useConversation(project: string, sel: string, member: Member | undefined) {
  const qc = useQueryClient();
  const version = useUi((s) => s.conversationVersion);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  const itemsRef = useRef<Item[]>([]);
  const gen = useRef(0); // bumped on every reload; a late answer for an older one is dropped
  const counter = useRef(0);
  const lastSeq = useRef(0);
  const sessionId = useRef<string | null>(null);
  const echoed = useRef<string[]>([]);
  const starts = useRef(new Map<string, number>()); // job id -> when its prompt was recorded
  const memberRef = useRef(member);
  memberRef.current = member;

  const next = () => `i${++counter.current}`;
  const commit = () => setItems([...itemsRef.current]);
  const isDispatcher = sel === DISPATCHER;
  const memberKey = member?.key;

  const dropLive = () => {
    itemsRef.current = itemsRef.current.filter((i) => !(i.kind === 'assistant' && i.live));
  };

  const pull = useCallback(async () => {
    const m = memberRef.current;
    const g = gen.current;
    if (!m || !sessionId.current) return;
    const q = lastSeq.current ? `?afterSeq=${lastSeq.current}` : '';
    const r = await api<{ entries: TranscriptEntry[] }>('GET', `/api/agents/${enc(m.key)}/sessions/${enc(sessionId.current)}/transcript${q}`);
    if (g !== gen.current) return;
    if (r.entries.some((e) => e.role === 'assistant' || e.role === 'error')) dropLive();
    for (const e of r.entries) {
      if (e.seq <= lastSeq.current) continue; // an overlapping pull already took it
      lastSeq.current = e.seq;
      const at0 = e.ts ? Date.parse(e.ts) : NaN;
      if (e.role === 'user' && e.jobId && Number.isFinite(at0)) starts.current.set(e.jobId, at0);
      const tookMs = e.jobId && starts.current.has(e.jobId) && Number.isFinite(at0) ? at0 - (starts.current.get(e.jobId) as number) : undefined;
      if (e.role === 'user') {
        const at = echoed.current.indexOf((e.text ?? '').trim());
        if (at >= 0) echoed.current.splice(at, 1); // typed here and already on screen
        else itemsRef.current.push({ id: next(), kind: 'user', text: e.text ?? '', note: (e.attempt ?? 1) > 1 ? `第 ${e.attempt} 次尝试` : undefined });
      } else if (e.role === 'tool') {
        // A tool call is recorded when it starts and again when it ends; it is drawn once and marked when the end arrives.
        const done = e.status === 'completed' || e.status === 'failed';
        const state: 'run' | 'done' | 'fail' = !done ? 'run' : e.status === 'failed' ? 'fail' : 'done';
        const at = itemsRef.current.findIndex((i) => i.kind === 'tool' && i.toolCallId === e.toolCallId);
        // What the tool was given comes with its start, what it returned with its end.
        const output = e.output ? `${e.output}` : '';
        if (at >= 0) {
          const old = itemsRef.current[at] as Extract<Item, { kind: 'tool' }>;
          // The end carries the readable title and the arguments too, for agents that only know them by then.
          const base = e.input && (!old.detail || old.detail === '{}') ? e.input : old.detail;
          itemsRef.current[at] = { ...old, state, name: e.title || old.name, detail: output ? `${base}${base ? '\n\n' : ''}— 输出 —\n${output}` : base };
        } else if (e.title || !done) itemsRef.current.push({ id: next(), kind: 'tool', name: e.title || e.kind || '工具', detail: e.input ?? output, result: false, toolCallId: e.toolCallId, state });
      } else if (e.role === 'thought') itemsRef.current.push({ id: next(), kind: 'thought', text: e.text ?? '', chars: e.chars });
      else if (e.role === 'error') itemsRef.current.push({ id: next(), kind: 'error', text: e.error || e.text || '出错了', who: e.interrupted ? '被中断' : '出错', tookMs: e.interrupted ? undefined : tookMs });
      else itemsRef.current.push({ id: next(), kind: 'assistant', text: e.text ?? '', who: m.id, tookMs });
    }
    commit();
  }, []);

  const load = useCallback(async () => {
    const g = ++gen.current;
    lastSeq.current = 0;
    sessionId.current = null;
    itemsRef.current = [];
    starts.current.clear();
    setLoading(true);
    try {
      if (!project) return commit();
      if (sel === DISPATCHER) {
        const r = await api<{ messages: PiMessage[]; turns?: { at: number; tookMs: number }[] }>('GET', `/api/dispatcher/messages${pq(project)}`);
        if (g !== gen.current) return;
        itemsRef.current = fromPi(r.messages, r.turns ?? [], next);
        return commit();
      }
      const m = memberRef.current;
      if (!m) return commit();
      // The transcript is on disk, so showing it must not start the process: use the remembered session.
      sessionId.current = m.preferSession;
      if (!sessionId.current && m.alive) {
        const { sessions } = await api<{ sessions: Session[] }>('GET', `/api/agents/${enc(m.key)}/sessions`);
        if (g !== gen.current) return;
        sessionId.current = sessions.find((s) => s.active)?.sessionId ?? sessions[0]?.sessionId ?? null;
      }
      if (!sessionId.current) return commit();
      await pull();
    } finally {
      if (g === gen.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, sel, pull]);

  // Reload when the member changes, the project changes, or a session was switched somewhere else.
  useEffect(() => {
    load().catch(() => setLoading(false));
  }, [load, version, memberKey]);

  // While an executor works: pull its transcript and the text written so far, every 1.5 s.
  const busy = Boolean(member?.busy);
  useEffect(() => {
    if (isDispatcher || !busy || !memberKey) return;
    const t = setInterval(async () => {
      try {
        await pull();
        const tail = await api<{ running?: boolean; text?: string }>('GET', `/api/agents/${enc(memberKey)}/tail`);
        if (!tail.running || !tail.text) return;
        const last = itemsRef.current.at(-1);
        if (last?.kind === 'assistant' && last.live) itemsRef.current[itemsRef.current.length - 1] = { ...last, text: tail.text };
        else itemsRef.current.push({ id: next(), kind: 'assistant', text: tail.text, who: memberRef.current?.id, live: true });
        commit();
      } catch {
        /* the next tick tries again */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [isDispatcher, busy, memberKey, pull]);

  // Live events: the dispatcher's stream, and "an executor's job finished".
  useEffect(
    () =>
      onLive((ev) => {
        if ((ev.name === 'job.done' || ev.name === 'job.interrupted') && ev.agent === sel && !isDispatcher) return void pull().catch(() => {});
        if (ev.name === 'job.started' && isDispatcher && ev.attempt && ev.agent?.startsWith(`${project}~`)) {
          // The attempt number is known as soon as the run starts: put it on the line that is waiting for it.
          const short = ev.agent.slice(project.length + 1);
          const at = itemsRef.current.findIndex((i) => i.kind === 'dispatch' && i.state === 'run' && i.attempt === undefined && i.agent === short);
          if (at >= 0) {
            itemsRef.current[at] = { ...(itemsRef.current[at] as Dispatch), attempt: ev.attempt, maxAttempts: ev.maxAttempts, queued: ev.queued, ahead: ev.ahead };
            commit();
          }
          return;
        }
        if (ev.name === 'job.running' && isDispatcher && ev.agent?.startsWith(`${project}~`)) {
          // A task that waited behind another has really started: the oldest waiting line of that executor.
          const short = ev.agent.slice(project.length + 1);
          const at = itemsRef.current.findIndex((i) => i.kind === 'dispatch' && i.state === 'run' && i.queued && i.agent === short);
          if (at >= 0) {
            itemsRef.current[at] = { ...(itemsRef.current[at] as Dispatch), queued: false };
            commit();
          }
          return;
        }
        if (ev.name !== 'dispatcher.event' || !isDispatcher || ev.project !== project) return;
        const d = ev.data ?? {};
        const last = itemsRef.current.at(-1);
        if (d.type === 'message_update' && d.kind === 'text_delta') {
          if (last?.kind === 'assistant' && last.live) itemsRef.current[itemsRef.current.length - 1] = { ...last, text: last.text + (d.delta ?? '') };
          else itemsRef.current.push({ id: next(), kind: 'assistant', text: d.delta ?? '', who: '调度器', live: true });
        } else if (d.type === 'tool_execution_start') {
          if (last?.kind === 'assistant') itemsRef.current[itemsRef.current.length - 1] = { ...last, live: false };
          if (d.toolName === 'agent_run') {
            const a = argOf(d.args);
            itemsRef.current.push({ id: next(), kind: 'dispatch', agent: a.agent ?? '默认执行者', prompt: a.prompt ?? '', state: 'run', toolCallId: d.toolCallId, startedAt: Date.now() });
          } else itemsRef.current.push({ id: next(), kind: 'tool', name: d.toolName ?? 'tool', detail: JSON.stringify(d.args ?? {}, null, 2), result: false });
        } else if (d.type === 'tool_execution_end' && d.result && d.toolName === 'agent_run') {
          const text = textOf(d.result.content ?? d.result);
          let at = itemsRef.current.findIndex((i) => i.kind === 'dispatch' && d.toolCallId && i.toolCallId === d.toolCallId);
          if (at < 0) at = itemsRef.current.findIndex((i) => i.kind === 'dispatch' && i.state === 'run');
          if (at >= 0) itemsRef.current[at] = settle(itemsRef.current[at] as Dispatch, text, Boolean(d.isError), d.result.details);
        } else if (d.type === 'tool_execution_end' && d.result) {
          itemsRef.current.push({ id: next(), kind: 'tool', name: d.toolName ?? 'tool', detail: textOf(d.result.content ?? d.result).slice(0, 1500), result: true });
        } else if (d.type === 'agent_settled') {
          void load(); // settle on the canonical history
          return;
        } else if (d.type === 'dispatcher_exit') {
          toast(`调度器进程退出（code ${d.code}）`);
          return;
        } else return;
        commit();
      }),
    [sel, isDispatcher, project, pull, load],
  );

  const send = useCallback(
    async (text: string) => {
      itemsRef.current.push({ id: next(), kind: 'user', text });
      commit();
      if (sel === DISPATCHER) await api('POST', `/api/dispatcher/prompt${pq(project)}`, { message: text });
      else {
        echoed.current.push(text);
        await api('POST', `/api/agents/${enc(sel)}/run`, { prompt: text, sessionId: sessionId.current || undefined });
      }
      await qc.invalidateQueries({ queryKey: ['projects'] });
    },
    [sel, project, qc],
  );

  return { items, loading, send };
}
