/** `agent_run`: give an executor a task and wait for its answer. */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { fitReply } from "../../../core/reply.mjs";
import { daemon } from "../daemon.ts";
import { attentionLines, fullMetrics, metricsLine, parseDuration } from "../format.ts";
import { agentParam } from "../params.ts";
import { failureMessage, taskTag } from "../failure.ts";

export const runTool = defineTool({
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
		const tag = taskTag(started);
		const failure = (message: string, source?: string) => new Error(failureMessage(message, source, tag));

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
