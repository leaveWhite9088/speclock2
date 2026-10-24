/**
 * Agent Router — pi extension front end for the scheduler daemon.
 *
 * It is the front door to `agentd`; the daemon keeps the agents, this file only
 * renders and routes. What it adds over a plain tool protocol:
 *   - live streaming through `onUpdate` (progress in the TUI, no context cost)
 *   - slash commands: /agents, /agent-model, /agent-usage
 *   - rich result rendering (model, tokens, tok/s, cost)
 *
 * Everything about process lifetime and session state still lives in the daemon,
 * so the extension is stateless: it opens a socket, asks, renders, disconnects.
 *
 * Install: copy to ~/.pi/agent/extensions/ or <project>/.pi/extensions/
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { connect } from "../client/agentd-client.mjs";
import { fitReply } from "../core/reply.mjs";

type Daemon = Awaited<ReturnType<typeof connect>>;

/**
 * When agentd starts this pi as a project's dispatcher it sets AGENTD_PROJECT.
 * Every call then carries the project, and agentd resolves names, lists and
 * directories inside it. The model cannot reach another project's agents.
 */
const PROJECT = process.env.AGENTD_PROJECT || null;

function scoped(c: Daemon): Daemon {
	if (!PROJECT) return c;
	return new Proxy(c, {
		get(target: any, prop) {
			if (prop === "call") {
				return (op: string, args: any = {}, opts?: any) =>
					target.call(op, { ...args, project: PROJECT, short: true, caller: "dispatcher" }, opts);
			}
			const v = target[prop];
			return typeof v === "function" ? v.bind(target) : v;
		},
	}) as Daemon;
}

// ---------------------------------------------------------------------------
// Daemon handle (lazy, shared for the process lifetime)
// ---------------------------------------------------------------------------

let daemonPromise: Promise<Daemon> | null = null;

async function daemon(): Promise<Daemon> {
	if (!daemonPromise) {
		daemonPromise = connect().then(scoped).catch((err) => {
			daemonPromise = null;
			throw err;
		});
	}
	return daemonPromise;
}

/** Release the socket so pi can exit cleanly. Must be idempotent. */
async function closeDaemon(): Promise<void> {
	const p = daemonPromise;
	daemonPromise = null;
	if (!p) return;
	try {
		const c = await p;
		c.close();
	} catch {
		/* nothing to close */
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Instance ids known to the daemon: the built-in types and any created instance. */
async function agentNames(c: Daemon): Promise<string[]> {
	const { agents } = await c.call("agents");
	return agents.map((a: any) => a.name);
}

const agentParam = Type.Optional(
	Type.String({
		description:
			'Which agent instance to use: a type name, or the id of an instance from agent_instances. Default "mcode".',
	}),
);

/** Compact one-line metric summary for the transcript. */
function metricsLine(m: any): string {
	if (!m) return "";
	const bits: string[] = [];
	if (m.modelName || m.model) bits.push(`${m.modelName ?? m.model}`);
	bits.push(`${(m.durationMs / 1000).toFixed(1)}s`);
	if (m.timeToFirstTokenMs != null) bits.push(`ttft ${(m.timeToFirstTokenMs / 1000).toFixed(1)}s`);
	if (m.tokens) bits.push(`out ${m.tokens.output ?? "?"} tok`);
	if (m.tokensPerSecond != null) bits.push(`${m.tokensPerSecond} tok/s`);
	if (m.chars) bits.push(`${m.chars} chars`);
	if (m.context?.percent != null) bits.push(`ctx ${m.context.percent}%`);
	if (m.cost?.amount) bits.push(`$${Number(m.cost.amount).toFixed(4)}`);
	return bits.join(" · ");
}

/** Health lines inferred by the scheduler (no agent cooperation needed). */
function attentionLines(m: any): string {
	const list: any[] = m?.attention ?? [];
	if (!list.length) return "";
	const icon = (s: string) => (s === "error" ? "✗" : s === "warn" ? "!" : "i");
	return list.map((a) => `  ${icon(a.severity)} [${a.code}] ${a.text}`).join("\n");
}

function fullMetrics(m: any): string {
	if (!m) return "";
	const lines = [
		`model:      ${m.modelName ?? m.model ?? "(unknown)"}`,
		`duration:   ${m.durationMs}ms${m.timeToFirstTokenMs != null ? `   first token: ${m.timeToFirstTokenMs}ms` : ""}`,
	];
	if (m.tokens) {
		const t = m.tokens;
		lines.push(
			`tokens:     in ${t.input ?? "?"} / out ${t.output ?? "?"}` +
				(t.cacheRead != null ? ` / cache-read ${t.cacheRead}` : "") +
				(t.total != null ? ` / total ${t.total}` : ""),
		);
		lines.push(`tps:        ${m.tokensPerSecond ?? "n/a"} tok/s (output)`);
	} else {
		lines.push("tokens:     not exposed by this agent over ACP");
	}
	lines.push(`throughput: ${m.charsPerSecond ?? "n/a"} chars/s, ${m.chars} chars in ${m.chunks} chunks`);
	if (m.thinkingChars) lines.push(`thinking:   ${m.thinkingChars} chars of reasoning`);
	if (m.context) {
		lines.push(
			`context:    ${m.context.used ?? "?"} / ${m.context.size ?? "?"}` +
				(m.context.percent != null ? ` (${m.context.percent}%)` : ""),
		);
	}
	if (m.cost) lines.push(`cost:       ${m.cost.amount} ${m.cost.currency ?? ""}`.trimEnd());
	if (m.logFile) lines.push(`log:        ${m.logFile}`);
	const att = attentionLines(m);
	if (att) lines.push(`health:     ${m.health}\n${att}`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const runTool = defineTool({
	name: "agent_run",
	label: "Agent run",
	description:
		"Send a prompt to a resident coding agent (mcode, dsh, pi, opencode, claude or codex) and get its answer. " +
		"Call agent_instances first: each instance has a role that says what it is for. " +
		"The agent process stays alive between calls; follow-ups reuse the same conversation. Sessions and directories are managed by the user, not by you. " +
		"Progress streams into the transcript while it runs. A long reply comes back as its start and end, with the path of a file holding the full text.",
	parameters: Type.Object({
		prompt: Type.String({ description: "Task or question for the agent." }),
		agent: agentParam,
		model: Type.Optional(
			Type.String({ description: "Model value from agent_models to apply first." }),
		),
		timeout: Type.Optional(Type.String({ description: 'Give up after this much silence from the agent, e.g. "30s", "5m". Default "5m". A running tool call (build, long command) is not silence, and the agent keeps going as long as it reports progress.' })),
		retry_of: Type.Optional(
			Type.String({
				description:
					"When you send a task again because an earlier attempt failed, the task id or job id of that attempt (printed at the end of every result and error). " +
					"Only when the user has asked for a retry. A task is not sent more than 3 times in total; after that, stop and tell the user.",
			}),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate) {
		const c = await daemon();
		const agent = params.agent ?? "mcode";
		const timeoutMs = parseDuration(params.timeout ?? "5m");
		const started = await c.call("run", {
			agent,
			prompt: params.prompt,
			model: params.model,
			timeoutMs,
			retryOf: params.retry_of,
			async: true,
			// Subscribe server-side before the run starts, so a fast agent cannot
			// finish before we are listening.
			subscribe: true,
		});
		// Printed after every result and error, so a retry can name what it retries.
		const tag = `[task ${started.taskId}, attempt ${started.attempt} of ${started.maxAttempts}, job ${started.jobId}]`;
		// Say where a failure comes from, and that it is for the user to decide what happens next.
		const failure = (message: string, source?: string) => {
			const from =
				source === "cli"
					? "The executor's own CLI reported this error (forwarded as it came):\n"
					: source === "agentd"
						? "agentd reports this (it is not an error message from the CLI):\n"
						: "";
			return new Error(`${from}${message}\n${tag}\nTell the user and wait for their decision. Do not retry or reassign this on your own.`);
		};

		const off = c.on("progress", (ev: any) => {
			if (ev.jobId !== started.jobId) return;
			onUpdate?.({
				content: [
					{
						type: "text",
						text:
							`${agent}: ${ev.chars} chars` +
							(ev.thinkingChars ? ` (+${ev.thinkingChars} thinking)` : "") +
							` · ${(ev.elapsedMs / 1000).toFixed(1)}s`,
					},
				],
				details: { streaming: true, ...ev },
			});
		});

		const onAbort = () => {
			// This task only (running or still waiting), not whatever else the executor happens to be running.
			c.call("cancel", { agent, jobId: started.jobId }).catch(() => {});
		};
		signal?.addEventListener("abort", onAbort, { once: true });

			try {
				let result: any;
				// Wait for the job.done event, but look at the job itself every 15 s: an event lost on the way
				// must not leave the dispatcher waiting for a run that finished long ago.
				const deadline = Date.now() + 3 * 60 * 60_000;
				while (!result) {
					let ev: any = null;
					try {
						ev = await c.waitFor("job.done", (e: any) => e.jobId === started.jobId, 15_000);
					} catch {
						const snap = await c.call("tail", { agent, jobId: started.jobId }).catch(() => null);
						if (snap && !snap.running) {
							if (snap.metrics?.error) throw failure(snap.metrics.error, snap.metrics.failureSource);
							result = { text: snap.text, sessionId: snap.sessionId, stopReason: "end_turn", metrics: snap.metrics };
						} else if (Date.now() > deadline) throw failure("agent_run is still waiting after 3 hours", "agentd");
						continue;
					}
					if (ev.error) throw failure(ev.error, ev.metrics?.failureSource);
					result = ev.result;
				}

			const m = result.metrics;
			// A long reply would sit in the dispatcher's conversation for good: it gets the start and the end.
			const reply = fitReply(started.jobId, result.text);
			return {
				content: [
					{
						type: "text",
						text: `${reply.text || "(no text output)"}\n\n---\n${fullMetrics(m)}\n${tag}`,
					},
				],
				details: {
					agent,
					taskId: started.taskId,
					attempt: started.attempt,
					maxAttempts: started.maxAttempts,
					sessionId: result.sessionId,
					stopReason: result.stopReason,
					replyFile: reply.file,
					replyOmitted: reply.omitted,
					...m,
				},
			};
		} finally {
			off();
			signal?.removeEventListener("abort", onAbort);
			await c.call("unsubscribe", { jobId: started.jobId }).catch(() => {});
		}
	},

	renderCall(args, theme) {
		return theme.text(`${theme.bold("agent_run")} ${args.agent ?? "mcode"}  ${args.prompt.slice(0, 60)}`);
	},

	renderResult(result, opts, theme) {
		const d: any = result.details ?? {};
		if (opts.isPartial) {
			const text = result.content?.find((c: any) => c.type === "text")?.text ?? "streaming…";
			return theme.text(theme.dim(text));
		}
		const mark = d.health === "error" ? "✗" : d.health === "warn" ? "!" : "✓";
		const head = theme.bold(`${mark} ${d.agent ?? "agent"}  ${d.sessionId ?? ""}`);
		const att = attentionLines(d);
		return [head, theme.dim(`   ${metricsLine(d)}`), att ? theme.text(att) : ""].filter(Boolean).join("\n");
	},
});

const sessionsTool = defineTool({
	name: "agent_sessions",
	label: "Agent sessions",
	description: "List stored sessions for one or all agents, with labels, cwd and timestamps.",
	parameters: Type.Object({
		agent: agentParam,
		limit: Type.Optional(Type.Number({ description: "Max rows per agent. Default 20." })),
	}),

	async execute(_id, params) {
		const c = await daemon();
		const names = params.agent ? [params.agent] : await agentNames(c);
		const blocks: string[] = [];
		const data: any[] = [];

		for (const name of names) {
			const { sessions } = await c.call("sessions", { agent: name });
			const status = await c.call("status", { agent: name }).catch(() => null);
			const limit = params.limit ?? 20;
			data.push({ agent: name, activeSessionId: status?.sessionId, sessions: sessions.slice(0, limit) });
			const rows = sessions.slice(0, limit).map((s: any, i: number) => {
				const mark = s.active ? "*" : " ";
				const when = s.updatedAt ? s.updatedAt.slice(0, 19).replace("T", " ") : "-";
				return `${mark} ${String(i + 1).padStart(2)}. ${s.label || s.title || "(untitled)"}   ${s.sessionId}\n      ${s.cwd ?? "-"}   ${when}`;
			});
			blocks.push(`### ${name} — ${sessions.length} session(s)\n${rows.join("\n") || "(none)"}`);
		}
		return { content: [{ type: "text", text: blocks.join("\n\n") }], details: { agents: data } };
	},

	renderResult(result, opts, theme) {
		const text = result.content?.find((c: any) => c.type === "text")?.text ?? "";
		return theme.text(opts.isPartial ? theme.dim("loading sessions…") : text);
	},
});

const proposeHandoffTool = defineTool({
	name: "propose_handoff",
	label: "Propose handoff",
	description:
		"Propose moving one executor to a fresh session when its context has clearly drifted (repeated compactions, loops, " +
		"repeated failures, contradicting itself). This only asks the user; nothing changes until they confirm and review " +
		"the handoff note. High context usage alone is not a reason: compaction handles that. Give the concrete evidence.",
	parameters: Type.Object({
		agent: Type.String({ description: "The executor to replace the session of." }),
		reason: Type.String({ description: "One sentence: why this executor's session should be replaced." }),
		evidence: Type.Optional(Type.String({ description: "What you observed: counts, repeated errors, contradictions." })),
	}),

	async execute(_id, params) {
		const c = await daemon();
		const h = await c.call("handoff.propose", { agent: params.agent, reason: params.reason, evidence: params.evidence });
		return {
			content: [{ type: "text", text: `Handoff proposed for ${params.agent} (${h.status}). Waiting for the user to confirm; do not send this executor new work meanwhile unless the user says so.` }],
			details: h,
		};
	},

	renderResult(result, opts, theme) {
		const text = result.content?.find((c: any) => c.type === "text")?.text ?? "";
		return theme.text(opts.isPartial ? theme.dim("proposing handoff…") : text);
	},
});

const modelsTool = defineTool({
	name: "agent_models",
	label: "Agent models",
	description: "List model / thinking-level options an agent exposes and the current value.",
	parameters: Type.Object({ agent: agentParam, sessionId: Type.Optional(Type.String()) }),
	async execute(_id, params) {
		const c = await daemon();
		const { sessionId, configOptions } = await c.call("models", {
			agent: params.agent,
			sessionId: params.sessionId,
		});
		const blocks = [`session ${sessionId}`];
		for (const opt of configOptions ?? []) {
			blocks.push(`\n${opt.id} (current: ${opt.currentValue})`);
			for (const o of flatten(opt.options)) {
				blocks.push(`${o.value === opt.currentValue ? "*" : " "} ${o.value}  ${o.name ?? ""}`.trimEnd());
			}
		}
		return { content: [{ type: "text", text: blocks.join("\n") }], details: { sessionId, configOptions } };
	},
});

const setModelTool = defineTool({
	name: "agent_set_model",
	label: "Agent set model",
	description: "Set the model (or reasoning effort) for a session.",
	parameters: Type.Object({
		value: Type.String({ description: "Exact option value from agent_models." }),
		configId: Type.Optional(Type.String({ description: 'Default "model".' })),
		agent: agentParam,
		sessionId: Type.Optional(Type.String()),
	}),
	async execute(_id, params) {
		const c = await daemon();
		const configId = params.configId ?? "model";
		const r = await c.call("setModel", {
			agent: params.agent,
			value: params.value,
			configId,
			sessionId: params.sessionId,
		});
		const opt = r.configOptions?.find((o: any) => o.id === configId);
		const name = flatten(opt?.options).find((o: any) => o.value === params.value)?.name;
		return {
			content: [{ type: "text", text: `${configId} = ${opt?.currentValue ?? params.value}${name ? ` (${name})` : ""}` }],
			details: { configId, value: opt?.currentValue, name },
		};
	},
});

const statusTool = defineTool({
	name: "agent_status",
	label: "Agent status",
	description: "Liveness, active session, model, spawn count for one or all agents.",
	parameters: Type.Object({ agent: agentParam }),
	async execute(_id, params) {
		const c = await daemon();
		const names = params.agent ? [params.agent] : await agentNames(c);
		const rows = [];
		for (const name of names) rows.push(await c.call("status", { agent: name }));
		const text = rows
			.map((s: any) => {
				const att = attentionLines(s);
				return [
					`${s.agent}: ${s.alive ? "alive" : "stopped"}  health ${s.health ?? "ok"}  pid ${s.pid ?? "-"}  spawns ${s.spawns}`,
					`  cwd     ${s.cwd}${s.defaultCwd && s.defaultCwd !== s.cwd ? `  (default ${s.defaultCwd})` : ""}`,
					`  session ${s.sessionId ?? "(none)"}${s.sessionLabel ? ` "${s.sessionLabel}"` : ""}`,
					`  model   ${s.modelName ?? s.model ?? "(unknown)"}`,
					s.lastError ? `  lastError ${s.lastError}` : "",
					att,
				]
					.filter(Boolean)
					.join("\n");
			})
			.join("\n");
		return { content: [{ type: "text", text }], details: { agents: rows } };
	},
});

const instancesTool = defineTool({
	name: "agent_instances",
	label: "Agent instances",
	description:
		"List agent instances: the built-in ones (mcode, dsh, pi, opencode, claude, codex), and any created ones. " +
		"Each instance is one resident process pinned to one directory.",
	parameters: Type.Object({}),
	async execute() {
		const c = await daemon();
		const { instances, types } = await c.call("instances");
		const rows = instances.map(
			(i: any) =>
				`${i.id}  [${i.type}${i.custom ? ", created" : ""}]  ${i.alive ? "alive" : "stopped"}${i.busy ? ", busy" : ""}\n  cwd ${i.cwd ?? "(base)"}${i.role ? `\n  role: ${i.role}` : ""}`,
		);
		return {
			content: [{ type: "text", text: `${rows.join("\n")}\n\ntypes you can create: ${types.join(", ")}` }],
			details: { instances, types },
		};
	},
});

const createInstanceTool = defineTool({
	name: "agent_instance_create",
	label: "Agent instance create",
	description:
		"Create another instance of a CLI type, pinned to a directory. " +
		"Use it when work must run in a different project than the existing instances.",
	parameters: Type.Object({
		id: Type.String({ description: "New instance id: a-z, 0-9, - or _, starts with a letter." }),
		type: Type.String({ description: "mcode, dsh, pi, opencode, claude or codex." }),
		cwd: Type.String({
			description: "Directory the instance works in. Inside a project, relative to the project root.",
		}),
		role: Type.Optional(Type.String({ description: "What this instance is for (shown to whoever dispatches)." })),
	}),
	async execute(_id, params) {
		const c = await daemon();
		const r = await c.call("instance.create", params);
		return { content: [{ type: "text", text: `created ${r.id} (${r.type}) in ${r.cwd}` }], details: r };
	},
});

function flatten(opts: any[] = []): any[] {
	return opts.flatMap((o) => (Array.isArray(o.options) ? flatten(o.options) : [{ value: o.value, name: o.name }]));
}

function parseDuration(s: string): number {
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim());
	if (!m) return 300_000;
	const n = Number(m[1]);
	return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"] as number);
}

// ---------------------------------------------------------------------------
// Slash commands — interactive UI, not expressible as a tool call
// ---------------------------------------------------------------------------

async function pickAgent(ctx: ExtensionContext): Promise<string | null> {
	const names = await agentNames(await daemon());
	const c = await ctx.ui.select("Which agent?", names);
	return c ?? null;
}

export default function agentRouter(pi: ExtensionAPI) {
	// Without this the open daemon socket keeps pi's event loop alive, so `pi -p`
	// prints its answer and then never exits.
	pi.on("session_shutdown", async () => {
		await closeDaemon();
	});

	// A dispatcher gets the live roster of its project in the system prompt of every run, so an
	// executor registered while the conversation is open is known at once. Without this the model
	// reuses the list from the last agent_instances call earlier in the conversation.
	if (PROJECT) {
		pi.on("before_agent_start", async (event) => {
			let roster = "";
			try {
				const c = await daemon();
				const { instances } = await c.call("instances");
				roster = instances
					.map(
						(i: any) =>
							`- ${i.id} [${i.type}] ${i.busy ? "busy" : i.alive ? "running" : "idle"}, dir ${i.cwd ?? "(base)"}${i.role ? `, role: ${i.role}` : ""}` +
							(i.unstable ? "\n  ! UNSTABLE: its process had to be killed several times lately; it refuses tasks until a person recovers it. Do not send it work." : "") +
							(i.interrupted
								? `\n  ! INTERRUPTED: its last task (${i.interrupted.startedAt}${i.interrupted.prompt ? `, "${String(i.interrupted.prompt).slice(0, 80)}"` : ""}) was cut off when the daemon stopped, so it may have done only part of it. Check its files before deciding whether to send the task again, and tell the user.`
								: ""),
					)
					.join("\n");
			} catch {
				return undefined; // no daemon answer: leave the prompt alone
			}
			if (!roster) return undefined;
			return {
				systemPrompt:
					event.systemPrompt +
					`

## Executors of this project (current, refreshed every turn)

${roster}

` +
					"You are the dispatcher. Hands-on work (writing files, code, drawings, running commands) goes to the executor whose role fits it, through agent_run; " +
					"do it yourself only when no executor fits, and say so. Pick by role and directory from the list above. " +
					"This list is newer than anything agent_instances returned earlier in the conversation. " +
					"If a task fails, tell the user the reason exactly as reported and wait for their decision; do not retry or give it to another executor on your own. " +
					"Send it again only when the user asks (pass retry_of, the task id printed with the failure; a task is sent at most 3 times in total).",
			};
		});
	}

	pi.registerTool(runTool);
	pi.registerTool(sessionsTool);
	pi.registerTool(modelsTool);
	pi.registerTool(proposeHandoffTool);
	pi.registerTool(setModelTool);
	pi.registerTool(statusTool);
	pi.registerTool(instancesTool);
	pi.registerTool(createInstanceTool);

	pi.registerCommand("agents", {
		description: "Browse, switch and rename agent sessions",
		handler: async (_args, ctx) => {
			const c = await daemon();
			const agent = await pickAgent(ctx);
			if (!agent) return;

			const { sessions } = await c.call("sessions", { agent });
			if (!sessions.length) {
				ctx.ui.notify(`${agent}: no sessions yet`, "info");
				return;
			}
			const labels = sessions.map(
				(s: any, i: number) =>
					`${s.active ? "* " : "  "}${String(i + 1).padStart(2)}. ${s.label || s.title || "(untitled)"}  —  ${s.sessionId.slice(0, 8)}`,
			);
			const picked = await ctx.ui.select(`${agent} sessions`, labels);
			if (!picked) return;
			const idx = labels.indexOf(picked);
			const target = sessions[idx];
			if (!target) return;

			await c.call("use", { agent, sessionId: target.sessionId });
			ctx.ui.notify(`${agent}: switched to ${target.label || target.sessionId.slice(0, 8)}`, "info");
		},
	});

	pi.registerCommand("agent-model", {
		description: "Pick the model for the active agent session",
		handler: async (_args, ctx) => {
			const c = await daemon();
			const agent = await pickAgent(ctx);
			if (!agent) return;
			const { configOptions, sessionId } = await c.call("models", { agent });
			const modelOpt = configOptions.find((o: any) => o.id === "model");
			if (!modelOpt) {
				ctx.ui.notify(`${agent}: no model options`, "info");
				return;
			}
			const flat = flatten(modelOpt.options);
			const list = flat.map(
				(o: any) => `${o.value === modelOpt.currentValue ? "* " : "  "}${o.name ?? o.value}`,
			);
			const picked = await ctx.ui.select(`${agent} model`, list);
			if (!picked) return;
			const idx = list.indexOf(picked);
			await c.call("setModel", { agent, value: flat[idx].value, configId: "model", sessionId });
			ctx.ui.notify(`${agent}: model set to ${flat[idx].name ?? flat[idx].value}`, "info");
		},
	});

	pi.registerCommand("agent-usage", {
		description: "Show the last run's metrics for an agent",
		handler: async (_args, ctx) => {
			const c = await daemon();
			const agent = await pickAgent(ctx);
			if (!agent) return;
			const snap = await c.call("tail", { agent });
			if (!snap) {
				ctx.ui.notify(`${agent}: no run yet`, "info");
				return;
			}
			ctx.ui.notify(
				`${snap.jobId}  ${snap.running ? "running" : "done"}\n${fullMetrics(snap.metrics)}`,
				"info",
			);
		},
	});
}
