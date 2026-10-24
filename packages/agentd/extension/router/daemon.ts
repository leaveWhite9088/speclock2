/**
 * The connection to agentd, shared for the life of this process. When agentd started this pi as a project's
 * dispatcher, every call carries the project (see `scoped`).
 */

import { connect } from "../../client/agentd-client.mjs";

export type Daemon = Awaited<ReturnType<typeof connect>>;

/**
 * When agentd starts this pi as a project's dispatcher it sets AGENTD_PROJECT.
 * Every call then carries the project, and agentd resolves names, lists and
 * directories inside it. The model cannot reach another project's agents.
 */
export const PROJECT = process.env.AGENTD_PROJECT || null;

export function scoped(c: Daemon): Daemon {
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

export async function daemon(): Promise<Daemon> {
	if (!daemonPromise) {
		daemonPromise = connect().then(scoped).catch((err) => {
			daemonPromise = null;
			throw err;
		});
	}
	return daemonPromise;
}

/** Release the socket so pi can exit cleanly. Must be idempotent. */
export async function closeDaemon(): Promise<void> {
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

/** Instance ids known to the daemon: the built-in types and any created instance. */
export async function agentNames(c: Daemon): Promise<string[]> {
	const { agents } = await c.call("agents");
	return agents.map((a: any) => a.name);
}
