/**
 * Agent Router — pi extension front end for the scheduler daemon.
 *
 * It is the front door to `agentd`; the daemon keeps the agents, this file only registers what pi gets: the tools the
 * dispatcher calls, the slash commands (/agents, /agent-model, /agent-usage) and the live list of the project's
 * executors in the system prompt. The code is in `router/`. Everything about process lifetime and session state lives
 * in the daemon, so the extension is stateless: it opens a socket, asks, renders, disconnects.
 *
 * agentd loads it by path when it starts a project's dispatcher (pi `-e`). It imports files next to it and in
 * `../client` and `../core`, so it is not a single file to copy somewhere else.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./router/commands.ts";
import { closeDaemon } from "./router/daemon.ts";
import { registerRoster } from "./router/roster.ts";
import { runTool } from "./router/tools/run.ts";
import { proposeHandoffTool } from "./router/tools/handoff.ts";
import { createInstanceTool, instancesTool } from "./router/tools/instances.ts";
import { modelsTool, sessionsTool, setModelTool, statusTool } from "./router/tools/sessions.ts";

export default function agentRouter(pi: ExtensionAPI) {
	// Without this the open daemon socket keeps pi's event loop alive, so `pi -p`
	// prints its answer and then never exits.
	pi.on("session_shutdown", async () => {
		await closeDaemon();
	});

	registerRoster(pi);

	pi.registerTool(runTool);
	pi.registerTool(sessionsTool);
	pi.registerTool(modelsTool);
	pi.registerTool(proposeHandoffTool);
	pi.registerTool(setModelTool);
	pi.registerTool(statusTool);
	pi.registerTool(instancesTool);
	pi.registerTool(createInstanceTool);

	registerCommands(pi);
}
