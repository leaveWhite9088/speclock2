/** Text for people and for the dispatcher: metrics, health lines, durations. Pure functions, no pi and no daemon. */

/** Compact one-line metric summary for the transcript. */
export function metricsLine(m: any): string {
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
export function attentionLines(m: any): string {
	const list: any[] = m?.attention ?? [];
	if (!list.length) return "";
	const icon = (s: string) => (s === "error" ? "✗" : s === "warn" ? "!" : "i");
	return list.map((a) => `  ${icon(a.severity)} [${a.code}] ${a.text}`).join("\n");
}

export function fullMetrics(m: any): string {
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

export function flatten(opts: any[] = []): any[] {
	return opts.flatMap((o) => (Array.isArray(o.options) ? flatten(o.options) : [{ value: o.value, name: o.name }]));
}

export function parseDuration(s: string): number {
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(s.trim());
	if (!m) return 300_000;
	const n = Number(m[1]);
	return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"] as number);
}
