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

/** 调工作台 REST；非 2xx 抛错（工具结果向模型暴露失败原因）。 */
async function api(method: string, path: string, body?: unknown): Promise<any> {
	const res = await fetch(`${API}/api/p/${SLUG}${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
	}
	return data;
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

	/** 新建任务（修复单 17）：用户直达请求（叫某主代理做 X）的合法入口——
	 *  先建技术任务单拿到新任务号，再 dispatch；禁止复用历史任务号。 */
	pi.registerTool(
		defineTool({
			name: "create_task",
			label: "新建任务",
			description:
				"给主代理新建任务（技术任务单通道）：登记意图/范围/验收，生成 queued 任务。" +
				"用户说「叫某主代理做某事」时先调用本工具，再用返回的 task_id 调 dispatch。" +
				"禁止复用历史任务号——已终态的任务再派发只会被跳过。",
			promptGuidelines: [
				"新建任务必须用 create_task，从返回结果拿新 task_id，禁止拿历史任务号去 dispatch。",
				"master 必须用主代理名册里的名字；名字不对会报错并列出可用名单。",
			],
			parameters: Type.Object({
				intent: Type.String({ description: "为什么动（一句话，动词开头）" }),
				scope: Type.Array(Type.String(), { description: "范围声明，如 [\"backend/\"]" }),
				acceptance: Type.Array(Type.String(), { default: [], description: "验收标准列表" }),
				master: Type.String({ description: "执行的主代理名（名册里的名字）" }),
			}),
			async execute(_toolCallId, p) {
				const order = await api("POST", "/tech-orders", {
					intent: p.intent,
					scope: p.scope ?? [],
					acceptance: p.acceptance ?? [],
					master: p.master,
				});
				return {
					content: [{
						type: "text",
						text: `已建任务 ${order.task_id}（单 ${order.order_id}，包 ${order.package_id}，状态 queued）。` +
							`下一步用 dispatch 派发任务号 ${order.task_id}。`,
					}],
					details: order,
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
				"把任务派发给主代理：启动其 harness 真实进程执行任务说明，监控完成并上报回执。" +
				"批准卡片后收到派发通知时使用本工具。",
			promptGuidelines: [
				"派发任务必须使用 dispatch 工具，不要在回复里描述派发细节代替执行。",
				"prompt 参数写清任务说明：实现范围（版本参照）+ 完成标准 + 回执要求。",
			],
			parameters: Type.Object({
				task_id: Type.String({ description: "任务 id，如 T-0001" }),
				prompt: Type.String({ description: "给主代理的任务说明（实现范围与完成标准）" }),
				watchdog_minutes: Type.Number({ default: 60, description: "看门狗超时（分钟）" }),
			}),
			async execute(_toolCallId, p) {
				// 1. 状态机推进 + 看门狗（模型可能不传 watchdog_minutes，显式兜底）；
				//    非 queued 任务返回 skipped：不 spawn、无副作用，如实告知模型即可
				const watchdogMinutes = p.watchdog_minutes && p.watchdog_minutes > 0 ? p.watchdog_minutes : 60;
				const dispatchRes = await api("POST", `/tasks/${p.task_id}/dispatch`, { watchdog_minutes: watchdogMinutes });
				if (dispatchRes.skipped) {
					const st = dispatchRes.task?.status ?? "unknown";
					return {
						content: [{ type: "text", text: `任务 ${p.task_id} 状态为 ${st}，不可派发（只有 queued 能派发）。请新建任务（create_task）后用新任务号重试；这是状态机跳过，不是通道故障，不要上报「通道不可用」。` }],
						details: { outcome: "skipped", state: st },
					};
				}

				// 2. 唤醒计划由工作台统一计算（名册 harness×harness-map×会话接续，
				//    与 mock 执行器同一事实源）；这里只负责 spawn + 监控
				const plan = await api("POST", `/tasks/${p.task_id}/launch-plan`, { prompt: p.prompt });
				const argv: string[] = plan.argv ?? [];
				const isCmd = !!plan.wrap_cmd;
				const finalArgv = isCmd ? ["cmd", "/c", plan.command, ...argv] : argv;
				const command = isCmd ? "cmd" : plan.command;

				// 3. spawn + 逐行解析（严格按 LF 切分；聚合 assistant message_end 的 usage）
				//    过程输出每 2s 节流上报工作台（output_tail + SSE master_output）
				const started = Date.now();
				const result = await new Promise<{ exitCode: number; text: string; usage: any; stderrTail: string }>((resolve) => {
					const proc = spawn(command, finalArgv, { cwd: plan.cwd ?? REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
					let buffer = "";
					let text = "";
					let usage: any = null;
					let stderrTail = "";
					let allOutput = "";      // 全量 stdout（增量计算用）
					let reportedLen = 0;     // 已上报的字符数
					let lastOutputPost = 0;
					const postOutput = (force: boolean) => {
						if (allOutput.length <= reportedLen) return;
						const now = Date.now();
						if (!force && now - lastOutputPost < 2000) return;
						const increment = allOutput.slice(reportedLen);
						reportedLen = allOutput.length;
						lastOutputPost = now;
						// 上报失败静默忽略：过程输出是尽力而为，不影响派发主链
						api("POST", `/tasks/${p.task_id}/output`, { text: increment }).catch(() => {});
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
						stderrTail = (stderrTail + data.toString("utf-8")).slice(-500); // 尾部诊断
					});
					proc.on("close", (code) => {
						if (buffer.trim()) processLine(buffer);
						postOutput(true); // 收尾补一发增量，之后停播
						resolve({ exitCode: code ?? 1, text, usage, stderrTail });
					});
					proc.on("error", (err) => {
						resolve({ exitCode: 1, text, usage, stderrTail: String(err) });
					});
				});

				if (result.exitCode !== 0) {
					return {
						content: [{ type: "text", text: `任务 ${p.task_id} 进程异常退出（码 ${result.exitCode}）：${result.stderrTail || "无 stderr"}，未回执，等待看门狗标记 timeout` }],
						details: { outcome: "crashed", exit_code: result.exitCode, stderr: result.stderrTail },
					};
				}

				// 4. 回执 + 遥测（token 解析不到标估算，DESIGN §13.5）
				const files = (result.text.match(/FILES:\s*(.+)/)?.[1] ?? "").split(/\s+/).filter(Boolean);
				const receipt = await api("POST", `/tasks/${p.task_id}/receipt`, {
					files_changed: files,
					self_check: `主代理进程退出码 0`,
					summary: result.text.slice(0, 200),
					telemetry: {
						duration_ms: Date.now() - started,
						tokens: result.usage
							? { input: result.usage.input, output: result.usage.output }
							: null,
						token_source: result.usage ? "exact" : "estimated",
					},
				});
				return {
					content: [{ type: "text", text: `任务 ${p.task_id} 完成：${files.length} 个文件改动，已回执（${receipt.status}）` }],
					details: { outcome: "reported", files_changed: files },
				};
			},
		}),
	);
}
