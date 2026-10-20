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
					target.call(op, { ...args, project: PROJECT, short: true }, opts);
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

/** Instance ids known to the daemon: mcode, dsh, pi and any created instance. */
async function agentNames(c: Daemon): Promise<string[]> {
	const { agents } = await c.call("agents");
	return agents.map((a: any) => a.name);
}

const agentParam = Type.Optional(
	Type.String({
		description:
			'Which agent instance to use: mcode, dsh, pi, or the id of an instance from agent_instances. Default "mcode".',
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
		"Send a prompt to a resident coding agent (mcode, dsh, or pi) and get its answer. " +
		"Call agent_instances first: each instance has a role that says what it is for. " +
		"The agent process stays alive between calls; follow-ups reuse the same conversation. " +
		"Progress streams into the transcript while it runs.",
	parameters: Type.Object({
		prompt: Type.String({ description: "Task or question for the agent." }),
		agent: agentParam,
		sessionId: Type.Optional(
			Type.String({ description: "Run in this stored session instead of the active one." }),
		),
		cwd: Type.Optional(Type.String({ description: "Workspace directory." })),
		model: Type.Optional(
			Type.String({ description: "Model value from agent_models to apply first." }),
		),
		timeout: Type.Optional(Type.String({ description: 'e.g. "30s", "5m". Default "5m".' })),
		reset: Type.Optional(Type.Boolean({ description: "Start a fresh conversation first." })),
	}),

	async execute(_toolCallId, params, signal, onUpdate) {
		const c = await daemon();
		const agent = params.agent ?? "mcode";
		const timeoutMs = parseDuration(params.timeout ?? "5m");
		const started = await c.call("run", {
			agent,
			prompt: params.prompt,
			cwd: params.cwd,
			sessionId: params.sessionId,
			model: params.model,
			reset: params.reset,
			timeoutMs,
			async: true,
			// Subscribe server-side before the run starts, so a fast agent cannot
			// finish before we are listening.
			subscribe: true,
		});

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
			c.call("cancel", { agent }).catch(() => {});
		};
		signal?.addEventListener("abort", onAbort, { once: true });

			try {
				let result: any;
				try {
					const ev = await c.waitFor("job.done", (e: any) => e.jobId === started.jobId, timeoutMs + 60_000);
					if (ev.error) throw new Error(ev.error);
					result = ev.result;
				} catch (err) {
					// Fallback: the event was lost — read the final state instead.
					const snap = await c.call("tail", { agent, jobId: started.jobId }).catch(() => null);
					if (!snap || snap.running) throw err;
					result = { text: snap.text, sessionId: snap.sessionId, stopReason: "end_turn", metrics: snap.metrics };
				}

			const m = result.metrics;
			return {
				content: [
					{
						type: "text",
						text: `${result.text || "(no text output)"}\n\n---\n${fullMetrics(m)}`,
					},
				],
				details: {
					agent,
					sessionId: result.sessionId,
					stopReason: result.stopReason,
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

const useTool = defineTool({
	name: "agent_use",
	label: "Agent switch session",
	description: "Switch an agent to an existing session by id.",
	parameters: Type.Object({
		sessionId: Type.String({ description: "Session id from agent_sessions." }),
		agent: agentParam,
	}),
	async execute(_id, params) {
		const c = await daemon();
		const r = await c.call("use", { agent: params.agent, sessionId: params.sessionId });
		return {
			content: [{ type: "text", text: `${params.agent ?? "mcode"}: attached to ${r.sessionId}\ncwd: ${r.cwd}` }],
			details: r,
		};
	},
});

const newTool = defineTool({
	name: "agent_new",
	label: "Agent new session",
	description: "Start a fresh session for an agent.",
	parameters: Type.Object({ agent: agentParam, cwd: Type.Optional(Type.String()) }),
	async execute(_id, params) {
		const c = await daemon();
		const r = await c.call("new", { agent: params.agent, cwd: params.cwd });
		return { content: [{ type: "text", text: `new session for ${r.agent}: ${r.sessionId}` }], details: r };
	},
});

const renameTool = defineTool({
	name: "agent_rename",
	label: "Agent rename session",
	description: "Set a local label for a session (agents have no rename API).",
	parameters: Type.Object({
		label: Type.String({ description: "New label; empty clears it." }),
		sessionId: Type.Optional(Type.String()),
		agent: agentParam,
	}),
	async execute(_id, params) {
		const c = await daemon();
		const r = await c.call("rename", {
			agent: params.agent,
			sessionId: params.sessionId,
			label: params.label,
		});
		return {
			content: [{ type: "text", text: r.label ? `${r.sessionId} labelled "${r.label}"` : `${r.sessionId} label cleared` }],
			details: r,
		};
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
		"List agent instances: the built-in mcode, dsh and pi, and any created ones. " +
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
		"Create another instance of mcode, dsh or pi, pinned to a directory. " +
		"Use it when work must run in a different project than the existing instances.",
	parameters: Type.Object({
		id: Type.String({ description: "New instance id: a-z, 0-9, - or _, starts with a letter." }),
		type: Type.String({ description: "mcode, dsh or pi." }),
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
							`- ${i.id} [${i.type}] ${i.busy ? "busy" : i.alive ? "running" : "idle"}, dir ${i.cwd ?? "(base)"}${i.role ? `, role: ${i.role}` : ""}`,
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
					"This list is newer than anything agent_instances returned earlier in the conversation.",
			};
		});
	}

	pi.registerTool(runTool);
	pi.registerTool(sessionsTool);
	pi.registerTool(useTool);
	pi.registerTool(newTool);
	pi.registerTool(renameTool);
	pi.registerTool(modelsTool);
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
