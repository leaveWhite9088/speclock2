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

const API = process.env.SPECLOCK2_API_BASE || "http://127.0.0.1:8000";
const SLUG = process.env.SPECLOCK2_SLUG || "";

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
}
