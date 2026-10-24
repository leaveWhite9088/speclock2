/**
 * What an agent's `session/update` messages add up to, for the run that is going on: the text it says, its reasoning, the
 * tool calls (each followed from start to end), the context it uses. It writes the transcript in the order things
 * happened and tells the front ends the run is alive. It knows nothing about processes or JSON-RPC: it is fed updates.
 */

import { appendFileSync } from 'node:fs';
import { appendEntry } from '../../transcripts.mjs';
import { inputText, outputText } from '../tool-text.mjs';

const finished = (status) => status === 'completed' || status === 'failed';

export class RunTracker {
  /** `getRun()` is the run that is going on (or null). */
  constructor({ name, getRun }) {
    this.name = name;
    this.getRun = getRun;
    /** Set by the front end: receives (jobId, progressPayload). */
    this.sink = null;
    /** Any update is a sign of life; open tool calls mean the agent is waiting on something. */
    this.lastSignal = Date.now();
    this.openTools = new Set();
    this.lastProgressAt = 0;
    /** What the agent said in the current prompt, as the caller gets it back. */
    this.streamedText = '';
    /** The latest context figures the agent reported. */
    this.lastUsage = null;
  }

  /** A prompt begins: silence is counted from now, nothing is open. */
  begin() {
    this.lastSignal = Date.now();
    this.openTools.clear();
  }

  /** How long the agent has said nothing, and whether it is waiting on a tool (which is not silence). */
  quiet() {
    return { forMs: Date.now() - this.lastSignal, waitingOnTool: this.openTools.size > 0 };
  }

  /** One `session/update`. */
  onUpdate(u) {
    this._noteSignal(u);
    const run = this.getRun();
    const isTool = u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update';
    if (run && isTool) {
      if (u.sessionUpdate === 'tool_call') {
        run.toolCalls = (run.toolCalls ?? 0) + 1;
        run.lastTool = u.title ?? u.kind ?? null;
      }
      this.progress(run, u.sessionUpdate === 'tool_call');
    }

    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
      this.streamedText += u.content.text;
      this._text(u.content.text);
      return;
    }
    // Reasoning is not answer text, but it is the only sign of life some agents give during long think phases.
    if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.text) {
      this._thought(u.content.text);
      return;
    }
    if (u.sessionUpdate === 'usage_update') {
      const ctx = {
        used: u.used ?? null,
        size: u.size ?? null,
        percent: u.used != null && u.size ? +((u.used / u.size) * 100).toFixed(1) : null,
      };
      if (run) {
        run.context = ctx;
        if (u.cost) run.cost = u.cost;
        if (u.tokens) run.tokens = u.tokens;
      }
      this.lastUsage = { ...ctx, cost: u.cost ?? null, tokens: u.tokens ?? null };
      return;
    }
    if (run?.sessionId && isTool) this._tool(run, u);
  }

  _noteSignal(u) {
    this.lastSignal = Date.now();
    const id = u.toolCallId ?? null;
    if (u.sessionUpdate === 'tool_call' && id && !finished(u.status)) this.openTools.add(id);
    else if (u.sessionUpdate === 'tool_call_update' && id) {
      if (finished(u.status)) this.openTools.delete(id);
      else if (u.status === 'in_progress' || u.status === 'pending') this.openTools.add(id);
    }
  }

  /**
   * A tool call goes into the transcript when it starts and again when it ends. Some agents send the arguments and a
   * readable title only in later updates, so each call is followed from its start: the latest title (not a
   * placeholder) and the first arguments that are not empty.
   */
  _tool(run, u) {
    const done = finished(u.status);
    let tool = null;
    if (u.toolCallId) {
      tool = run.tools.get(u.toolCallId) ?? {};
      if (u.title && !done && !u.title.endsWith('…')) tool.title = u.title;
      else if (!tool.title && u.title && u.sessionUpdate === 'tool_call') tool.title = u.title;
      const input = inputText(u.rawInput);
      if (input) tool.input = input;
      run.tools.set(u.toolCallId, tool);
    }
    if (u.sessionUpdate === 'tool_call') {
      this.flushPieces(run);
      appendEntry(this.name, run.sessionId, {
        role: 'tool',
        jobId: run.jobId,
        toolCallId: u.toolCallId ?? null,
        title: tool?.title ?? u.title ?? null,
        kind: u.kind ?? null,
        status: u.status ?? 'started',
        input: tool?.input ?? null,
      });
    } else if (done) {
      appendEntry(this.name, run.sessionId, {
        role: 'tool',
        jobId: run.jobId,
        toolCallId: u.toolCallId ?? null,
        title: tool?.title ?? null,
        kind: u.kind ?? null,
        status: u.status,
        input: tool?.input ?? null,
        output: outputText(u),
      });
    }
  }

  /** Append a streamed chunk to the run and push progress upstream. */
  _text(text) {
    const run = this.getRun();
    if (!run) return;
    if (run.firstChunkAt == null) run.firstChunkAt = Date.now();
    if (run.segAt == null) run.segAt = Date.now();
    run.text += text;
    run.chunks += 1;
    if (run.logFile) {
      try {
        appendFileSync(run.logFile, text, 'utf8');
      } catch {
        /* logging is best-effort */
      }
    }
    this.progress(run);
  }

  /** Reasoning text: counted for progress and kept (shortened) for the transcript, never returned as output. */
  _thought(text) {
    const run = this.getRun();
    if (!run) return;
    if (run.firstChunkAt == null) run.firstChunkAt = Date.now();
    if (run.thoughtAt == null) run.thoughtAt = Date.now();
    run.thoughtChars += text.length;
    if (run.thought.length < 20_000) run.thought += text;
    this.progress(run);
  }

  /**
   * Tell the front ends the run is alive: at most twice a second, or at once with `force`. Besides the sizes it says
   * which tool is running, so a long task with no text yet does not look hung.
   */
  progress(run, force = false) {
    const now = Date.now();
    if (!this.sink || (!force && now - this.lastProgressAt < 500)) return;
    this.lastProgressAt = now;
    this.sink(run.jobId, {
      agent: this.name,
      chars: run.text.length,
      thinkingChars: run.thoughtChars,
      elapsedMs: now - run.startedAt,
      tool: run.lastTool ?? null,
      toolCalls: run.toolCalls ?? 0,
      openTools: this.openTools.size,
    });
  }

  /**
   * Write what the agent has said and thought since the last piece into the transcript, as pieces of their own. Done when
   * a tool call starts and when the run ends, so text, reasoning and tool calls come out in the order they happened.
   */
  flushPieces(run, extra = {}) {
    if (!run?.sessionId) return;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
    const thought = run.thought.slice(run.flushedThought).trim();
    if (thought) {
      appendEntry(this.name, run.sessionId, { role: 'thought', jobId: run.jobId, text: thought.slice(0, 12_000), chars: thought.length, startedAt: iso(run.thoughtAt) });
    }
    run.flushedThought = run.thought.length;
    run.thoughtAt = null;
    const text = run.text.slice(run.flushed).trim();
    if (text) {
      appendEntry(this.name, run.sessionId, { role: 'assistant', jobId: run.jobId, piece: true, text, startedAt: iso(run.segAt), ...extra });
    }
    run.flushed = run.text.length;
    run.segAt = null;
  }
}
