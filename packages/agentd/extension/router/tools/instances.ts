/** Tools to list the executors and to create one. */

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { daemon } from "../daemon.ts";

export const instancesTool = defineTool({
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

export const createInstanceTool = defineTool({
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
