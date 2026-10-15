/**
 * SpecLock 2 核心代理扩展（pi extension，jiti 加载）。
 *
 * 环境变量（由工作台 pi_runtime 启动子进程时注入）：
 *   SPECLOCK2_API_BASE  工作台地址（默认 http://127.0.0.1:8000）
 *   SPECLOCK2_SLUG      当前项目 slug
 *
 * 集成面收缩在 pi 的稳定层：registerTool（扩展 API）+ 工作台 REST 契约 v0.3。
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const API = process.env.SPECLOCK2_API_BASE || "http://127.0.0.1:8000";
const SLUG = process.env.SPECLOCK2_SLUG || "";
const REPO_ROOT = process.env.SPECLOCK2_REPO_ROOT || process.cwd();

/** 调工作台 REST；非 2xx 抛 ApiError（带状态码，工具按码给纠偏回路）。 */
class ApiError extends Error {
	constructor(method: string, path: string, readonly status: number, body: unknown) {
		super(`${method} ${path} -> ${status}: ${JSON.stringify(body)}`);
	}
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
	const res = await fetch(`${API}/api/p/${SLUG}${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new ApiError(method, path, res.status, data);
	}
	return data;
}

/** 路径纪律（修复单 19）：任务说明出现宿主/工作台仓库绝对路径 → 拒绝执行。
 *  主代理的领地由工作台按名册解析（--cwd），说明里写绝对路径会把产物写进工作台仓库。 */
function promptHasHostPath(prompt: string): boolean {
	const root = REPO_ROOT.replace(/[\\/]+$/, "");
	return root.length > 3 && prompt.toLowerCase().includes(root.toLowerCase());
}

function hostPathRejection(prompt: string) {
	return {
		content: [{
			type: "text",
			text: `任务说明里出现了工作台仓库的绝对路径（${REPO_ROOT}）。` +
				`主代理只能写自己的工作目录。请把路径改写成「在你的工作目录下创建 …」的说法后重新提交；本次未执行。`,
		}],
		details: { outcome: "prompt_rejected", reason: "host_path_in_prompt" },
	};
}

/** 派发（慢工单异步化）：同步段只做 状态机→唤醒计划→spawn，随即返回；
 *  跟单（输出上报/回执/收尸）在后台继续——mcode 一跑十几分钟，同步等待会
 *  撑爆 chief 的回合超时（testproj T-0001 实证 981 秒）。落定后由工作台
 *  通知回合把结果送回对话流，chief 再向用户转述。 */
async function startDispatch(taskId: string, prompt: string, watchdogMinutes: number) {
	// 1. 状态机推进 + 看门狗；非 queued 任务返回 skipped：不 spawn、无副作用
	const dispatchRes = await api("POST", `/tasks/${taskId}/dispatch`, { watchdog_minutes: watchdogMinutes });
	if (dispatchRes.skipped) {
		const st = dispatchRes.task?.status ?? "unknown";
		return {
			content: [{ type: "text", text: `任务 ${taskId} 状态为 ${st}，不可派发（只有 queued 能派发）。请新建任务（create_task）后用新任务号重试；这是状态机跳过，不是通道故障，不要上报「通道不可用」。` }],
			details: { outcome: "skipped", state: st },
		};
	}

	// 2. 唤醒计划由工作台统一计算（名册 harness×harness-map×会话接续）
	const plan = await api("POST", `/tasks/${taskId}/launch-plan`, { prompt });
	const argv: string[] = plan.argv ?? [];
	const isCmd = !!plan.wrap_cmd;
	const finalArgv = isCmd ? ["cmd", "/c", plan.command, ...argv] : argv;
	const command = isCmd ? "cmd" : plan.command;

	// 3. spawn + 后台跟单（不等待进程结束）
	const proc = spawn(command, finalArgv, { cwd: plan.cwd ?? REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
	monitorDispatch(taskId, plan, proc);
	return {
		content: [{ type: "text", text: `任务 ${taskId} 已派发（工作目录：${plan.cwd}）。后台执行中：完成或失败都会由系统通知你，届时向用户转述——文件与结论以回执为准，不要现在声称完成。` }],
		details: { outcome: "dispatched", cwd: plan.cwd },
	};
}

/** 后台跟单：逐行聚合 stdout（message_end 取全文）、stderr 留尾；
 *  过程输出每 2s 节流上报；进程结束按退出码回执或快速收尸。失败静默。 */
function monitorDispatch(taskId: string, plan: any, proc: any): void {
	const started = Date.now();
	let buffer = "";
	let text = "";
	let usage: any = null;
	let stderrTail = "";
	let allOutput = "";
	let reportedLen = 0;
	let lastOutputPost = 0;
	const postOutput = (force: boolean) => {
		if (allOutput.length <= reportedLen) return;
		const now = Date.now();
		if (!force && now - lastOutputPost < 2000) return;
		const increment = allOutput.slice(reportedLen);
		reportedLen = allOutput.length;
		lastOutputPost = now;
		api("POST", `/tasks/${taskId}/output`, { text: increment }).catch(() => {});
	};
	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			text = (event.message.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
			usage = event.message.usage ?? usage;
		}
	};
	proc.stdout.on("data", (data: Buffer) => {
		const chunk = data.toString("utf-8");
		allOutput += chunk;
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) processLine(line);
		postOutput(false);
	});
	proc.stderr.on("data", (data: Buffer) => {
		stderrTail = (stderrTail + data.toString("utf-8")).slice(-500);
	});
	proc.on("error", (err: Error) => {
		// spawn 失败（命令不存在等）：快速收尸，失败原因回流
		api("POST", `/tasks/${taskId}/fail`, {
			reason: `进程无法启动：${String(err)}`,
			stderr: stderrTail || undefined,
		}).catch(() => {});
	});
	proc.on("close", (code: number | null) => {
		if (buffer.trim()) processLine(buffer);
		postOutput(true); // 收尾补一发增量，之后停播
		const exitCode = code ?? 1;
		if (exitCode !== 0) {
			// 快速失败收尸（修复单 21）：立即标 timeout，不干等看门狗。
			// mcode 类 harness 的报错在 stdout（模型路由拒绝等），一并带上
			const stdoutTail = allOutput.slice(-500);
			api("POST", `/tasks/${taskId}/fail`, {
				reason: `被派发进程异常退出（码 ${exitCode}）`,
				exit_code: exitCode,
				stderr: (stderrTail || stdoutTail || "").slice(-500) || undefined,
			}).catch(() => {});
			return;
		}
		// 回执 + 遥测；任务若已被看门狗收尸（409）则静默放弃——账本为准。
		// FILES 解析源：NDJSON 的 assistant 全文；text 模式（mcode）没有事件流，
		// 约定行在纯文本 stdout 里——两个源都找（E2E 实证：mcode 回执曾丢文件清单）
		const source = text || allOutput;
		const files = (source.match(/FILES:\s*(.+)/)?.[1] ?? "").split(/\s+/).filter(Boolean);
		api("POST", `/tasks/${taskId}/receipt`, {
			files_changed: files,
			self_check: `主代理进程退出码 0`,
			summary: source.slice(0, 200),
			telemetry: {
				duration_ms: Date.now() - started,
				tokens: usage ? { input: usage.input, output: usage.output } : null,
				token_source: usage ? "exact" : "estimated",
			},
		}).catch(() => {});
	});
}

export default function (pi: ExtensionAPI) {
	/** 起草审批卡片：结构化变更的唯一合法通道（卡片必须经工具产出）。 */
	pi.registerTool(
		defineTool({
			name: "draft_card",
			label: "起草审批卡片",
			description:
				"把本轮文档变更起草为结构化审批卡片，提交工作台等待人批准。" +
				"这是唯一合法的起草通道，禁止在回复文本里贴卡片 JSON。",
			promptGuidelines: [
				"起草审批卡片必须调用 draft_card 工具，禁止在回复文本中输出卡片 JSON。",
				"statement 的「说明」用动词开头一句话，「动机」说清业务为什么。",
			],
			parameters: Type.Object({
				statement: Type.Object({
					说明: Type.String({ description: "一句话，动词开头，说清变更做了什么" }),
					动机: Type.String({ description: "一句话，业务动机" }),
				}),
				rule_ops: Type.Array(Type.Any(), {
					default: [],
					description: "规则 ops：[{block_id, op: add|modify|remove, id?, after?}]",
				}),
				api_ops: Type.Array(Type.Any(), {
					default: [],
					description: "契约 ops：[{block_id, op: upsert|remove, key, entry?, breaking?}]",
				}),
				impact: Type.Array(Type.String(), {
					default: ["backend", "frontend"],
					description: "影响面（决定任务包生成哪些主代理任务）",
				}),
				risk: Type.Any({ default: null, description: "风险说明 {text, verified_by?}，可空" }),
			}),
			async execute(_toolCallId, params) {
				const card = await api("POST", "/cards", {
					statement: params.statement,
					rule_ops: params.rule_ops ?? [],
					api_ops: params.api_ops ?? [],
					impact: params.impact ?? ["backend", "frontend"],
					risk: params.risk ?? undefined,
				});
				return {
					content: [{ type: "text", text: `卡片 ${card.card_id} 已提交（第 ${card.round} 轮，待批准）。请在工作台审批。` }],
					details: card,
				};
			},
		}),
	);

/** 通用上报：过程记录落 pi 会话条目（appendEntry，可钻取）；REST 端点待契约补录。 */
	pi.registerTool(
		defineTool({
			name: "workbench_report",
			label: "上报工作台",
			description: "向工作台上报过程信息（阶段摘要、风险提示等非卡片非回执的过程记录）。",
			parameters: Type.Object({
				kind: Type.String({ description: "报告类别，如 phase_summary / risk_note" }),
				text: Type.String({ description: "报告内容（遵守语言规范）" }),
			}),
			async execute(_toolCallId, params) {
				pi.appendEntry("workbench_report", {
					kind: params.kind,
					text: params.text,
					ts: new Date().toISOString(),
				});
				return { content: [{ type: "text", text: `已上报（${params.kind}）` }] };
			},
		}),
	);

	/** 新建任务（修复单 17/19）：用户直达请求（叫某主代理做 X）的合法入口。
	 *  带 prompt 时一步完成建单+派发——消灭「拿任务号调另一个工具」的交接
	 *  （17:50 故障的失败点正是模型在交接环节编造了任务号）。 */
	pi.registerTool(
		defineTool({
			name: "create_task",
			label: "新建任务",
			description:
				"给主代理新建任务（技术任务单通道）：登记意图/范围/验收，生成 queued 任务。" +
				"用户说「叫某主代理做某事」时调用本工具并带上 prompt 参数，一步完成建单与派发。" +
				"不传 prompt 时只建单，需再用 dispatch 派发返回的 task_id。" +
				"禁止复用或编造任务号——已终态的任务再派发只会被跳过，不存在的任务号必 404。",
			promptGuidelines: [
				"直达请求一律 create_task(intent, master, prompt) 一步完成，不要先建单再拿任务号调 dispatch。",
				"master 必须用主代理名册里的名字；名字不对会报错并列出可用名单。",
				"prompt 里禁止出现工作台仓库的绝对路径，只写「在你的工作目录下创建 …」。",
			],
			parameters: Type.Object({
				intent: Type.String({ description: "为什么动（一句话，动词开头）" }),
				scope: Type.Array(Type.String(), { description: "范围声明，如 [\"backend/\"]" }),
				acceptance: Type.Array(Type.String(), { default: [], description: "验收标准列表" }),
				master: Type.String({ description: "执行的主代理名（名册里的名字）" }),
				prompt: Type.Optional(Type.String({
					description: "给主代理的任务说明（实现范围与完成标准，结尾要求主代理输出 FILES: 文件清单）；提供即一步完成建单+派发（异步，结果由系统通知回合送达）",
				})),
			}),
			async execute(_toolCallId, p) {
				if (p.prompt && promptHasHostPath(p.prompt)) return hostPathRejection(p.prompt);
				const order = await api("POST", "/tech-orders", {
					intent: p.intent,
					scope: p.scope ?? [],
					acceptance: p.acceptance ?? [],
					master: p.master,
				});
				const created = `已建任务 ${order.task_id}（单 ${order.order_id}，包 ${order.package_id}）`;
				if (!p.prompt || !p.prompt.trim()) {
					return {
						content: [{ type: "text", text: `${created}，状态 queued。下一步用 dispatch 派发任务号 ${order.task_id}。` }],
						details: order,
					};
				}
				// 一步派发（异步）：无任务号交接；结果由系统通知回合送达
				const result = await startDispatch(order.task_id, p.prompt, 60);
				return {
					content: [{ type: "text", text: `${created}。${(result.content as any[])[0].text}` }],
					details: { order, dispatch: result.details },
				};
			},
		}),
	);

	/** 派发：spawn 被派发 harness 真实进程（NDJSON 解析，骨架参考官方 subagent 示例）。 */
	pi.registerTool(
		defineTool({
			name: "dispatch",
			label: "派发任务",
			description:
				"把任务派发给主代理：启动其 harness 真实进程执行任务说明，后台跟单。" +
				"派发是异步的：工具立即返回「已派发」，完成/失败由系统通知回合送达，届时再向用户转述。" +
				"只用于已有真实任务号的任务（批准卡片后的派发通知、create_task 不带 prompt 时返回的 task_id）。" +
				"用户直达请求不要走本工具——直接用 create_task 带 prompt 一步完成。",
			promptGuidelines: [
				"派发任务必须使用 dispatch 工具，不要在回复里描述派发细节代替执行。",
				"task_id 必须来自 create_task 返回值或系统通知，禁止编造；404 就改用 create_task 建真任务。",
				"prompt 参数写清任务说明：实现范围（版本参照）+ 完成标准 + 回执要求；禁止出现工作台仓库绝对路径。",
			],
			parameters: Type.Object({
				task_id: Type.String({ description: "任务 id，如 T-0001" }),
				prompt: Type.String({ description: "给主代理的任务说明（实现范围与完成标准）" }),
				watchdog_minutes: Type.Number({ default: 60, description: "看门狗超时（分钟）" }),
			}),
			async execute(_toolCallId, p) {
				if (promptHasHostPath(p.prompt)) return hostPathRejection(p.prompt);
				// 修复单 19：失败必须给纠偏回路，不许裸抛——404 说明任务号是编的，
				// 同一回合内引导 create_task 重试，而不是让模型去写故障报告
				try {
					const watchdogMinutes = p.watchdog_minutes && p.watchdog_minutes > 0 ? p.watchdog_minutes : 60;
					return await startDispatch(p.task_id, p.prompt, watchdogMinutes);
				} catch (err) {
					if (err instanceof ApiError && err.status === 404) {
						return {
							content: [{ type: "text", text: `任务 ${p.task_id} 不存在——你不能编造任务号。请立即调用 create_task（带 intent、master、prompt），用它返回的真实任务号继续；这是当前回合内的重试，不是通道故障。` }],
							details: { outcome: "not_found" },
						};
					}
					throw err;
				}
			},
		}),
	);
}
