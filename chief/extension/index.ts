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
import * as fs from "node:fs";
import * as path from "node:path";

const API = process.env.SPECLOCK2_API_BASE || "http://127.0.0.1:8000";
const SLUG = process.env.SPECLOCK2_SLUG || "";
const DATA_DIR = process.env.SPECLOCK2_DATA_DIR || "";
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
				// 1. 查任务（master 决定 harness）
				const pkgs = await api("GET", "/packages");
				const pkg = pkgs.items.find((x: any) => x.tasks.some((t: any) => t.task_id === p.task_id));
				const task = pkg?.tasks.find((t: any) => t.task_id === p.task_id);
				if (!task) throw new Error(`任务 ${p.task_id} 不存在`);

				// 2. 状态机推进 + 看门狗（模型可能不传 watchdog_minutes，显式兜底）
				const watchdogMinutes = p.watchdog_minutes && p.watchdog_minutes > 0 ? p.watchdog_minutes : 60;
				await api("POST", `/tasks/${p.task_id}/dispatch`, { watchdog_minutes: watchdogMinutes });

				// 3. harness 映射（与 mock 执行器共用同一配置文件）
				const map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "harness-map.json"), "utf-8"));
				const harnessName = map.masters?.[task.master ?? ""] ?? "sl2-fake";
				const harness = map.harnesses?.[harnessName] ?? map.harnesses?.["sl2-fake"];
				if (!harness) throw new Error(`harness 映射缺失：${harnessName}`);
				let argv: string[] = (harness.args ?? []).map((a: string) => a.replace("{prompt}", p.prompt));
				if ((harness.prompt_mode ?? "arg") === "arg") argv = [...argv, p.prompt];

				// 4. spawn + 逐行解析（严格按 LF 切分；聚合 assistant message_end 的 usage）
				const started = Date.now();
				const result = await new Promise<{ exitCode: number; text: string; usage: any; stderrTail: string }>((resolve) => {
					const isCmd = /\.cmd$/i.test(harness.command);
					const finalArgv = isCmd ? ["cmd", "/c", harness.command, ...argv] : argv;
					const command = isCmd ? "cmd" : harness.command;
					const proc = spawn(command, finalArgv, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
					let buffer = "";
					let text = "";
					let usage: any = null;
					let stderrTail = "";
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
						buffer += data.toString("utf-8");
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) processLine(line);
					});
					proc.stderr.on("data", (data: Buffer) => {
						stderrTail = (stderrTail + data.toString("utf-8")).slice(-500); // 尾部诊断
					});
					proc.on("close", (code) => {
						if (buffer.trim()) processLine(buffer);
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

				// 5. 回执 + 遥测（token 解析不到标估算，DESIGN §13.5）
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
