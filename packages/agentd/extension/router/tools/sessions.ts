/** Tools for an executor's sessions, models and status. */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { daemon, agentNames } from "../daemon.ts";
import { attentionLines, flatten } from "../format.ts";
import { agentParam } from "../params.ts";

export const sessionsTool = defineTool({
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

export const modelsTool = defineTool({
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

export const setModelTool = defineTool({
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

export const statusTool = defineTool({
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
