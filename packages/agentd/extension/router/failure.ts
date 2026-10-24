/**
 * What the dispatcher is told when a task ends badly: where the failure comes from, which task and attempt it was,
 * and that what happens next is for the user to decide. Pure functions.
 */

/** Printed after every result and error, so a retry can name what it retries. */
export function taskTag(started: { taskId: string; attempt: number; maxAttempts: number; jobId: string }): string {
	return `[task ${started.taskId}, attempt ${started.attempt} of ${started.maxAttempts}, job ${started.jobId}]`;
}

/** Say where a failure comes from, and that it is for the user to decide what happens next. */
export function failureMessage(message: string, source: string | undefined, tag: string): string {
	const from =
		source === "cli"
			? "The executor's own CLI reported this error (forwarded as it came):\n"
			: source === "agentd"
				? "agentd reports this (it is not an error message from the CLI):\n"
				: "";
	return `${from}${message}\n${tag}\nTell the user and wait for their decision. Do not retry or reassign this on your own.`;
}
