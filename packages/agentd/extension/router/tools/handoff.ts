/** `propose_handoff`: the dispatcher may only propose; a person confirms. */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { daemon } from "../daemon.ts";

export const proposeHandoffTool = defineTool({
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
