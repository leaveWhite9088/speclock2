/** The slash commands: interactive pickers that cannot be expressed as a tool call. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentNames, daemon } from "./daemon.ts";
import { flatten, fullMetrics } from "./format.ts";

async function pickAgent(ctx: ExtensionContext): Promise<string | null> {
	const names = await agentNames(await daemon());
	const c = await ctx.ui.select("Which agent?", names);
	return c ?? null;
}

export function registerCommands(pi: ExtensionAPI): void {
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
