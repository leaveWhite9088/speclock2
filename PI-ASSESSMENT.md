# pi 能力核查报告（面向 SpecLock 2 主主代理宿主选型）

- 核查对象：badlogic/pi-mono（earendil-works），版本 1.2.0（2026-10-12 发布），克隆于 `D:\Project2\code-261013-speclock2\pi-mono`
- 核查方式：源码级探索（两轮）+ 关键集成事实抽查
- 日期：2026-10-14
- **总结论：覆盖成立。** 设计文档 §13 对 pi 的全部需求都有官方支持路径，其中"派生其他 harness"有官方参考实现。需要我们自己写的只有适配层，无结构性缺口。

---

## 一、需求覆盖对照表

| # | 我们的需求（DESIGN.md） | pi 能力 | 证据（相对 pi-mono 根） | 结论 |
|---|--------------------------|---------|--------------------------|------|
| 1 | Python(FastAPI) 后端程序化驱动（发消息/收结果） | **RPC 模式**：`pi --mode rpc`，stdin/stdout JSONL 双向协议；官方定位"跨语言集成"，文档自带 Python 客户端示例（subprocess.Popen + LF 分帧） | `packages/coding-agent/docs/rpc.md:99-130`、`docs/cli-integration.md:11-17` | ✅ 官方一等支持 |
| 2 | 每项目独立会话、按需恢复/唤醒 | `--session-id <id>` 幂等：存在则恢复、不存在则创建；`--session-dir` 自定义目录；`--name` 命名；会话 = JSONL 文件 | `docs/cli.md:86-102`、`docs/sessions.md:50`、`src/main.ts:436-448` | ✅ 与"一项目一会话、空闲不驻留"直接对齐 |
| 3 | 宪法/上下文注入（语言规范常驻） | `--append-system-prompt <text\|path>`（可重复）；AGENTS.md/APPEND_SYSTEM.md 自动发现；扩展可在 `before_agent_start` 段级改写系统提示 | `docs/cli.md:229-232`、`docs/configuration.md:19-47`、`src/core/system-prompt.ts` | ✅ |
| 4 | token 遥测 | 每回合 `message_end.message.usage`（input/output/cache/cost）；会话级 `get_session_stats` 含 `contextUsage.percent`（上下文窗口占用） | `docs/json.md:95-99`、`docs/rpc-commands.md:526-567`、`packages/ai/src/types.ts:446-467` | ✅ 主主代理自身用量精确 |
| 5 | 强模型 + 中国可用 provider | 80+ provider：Anthropic/OpenAI/Google 原生 + ZAI_CODING_CN / Moonshot / Qwen(含CN) / MiniMax(含CN) / DeepSeek / OpenRouter；`models.json` 支持自定义 OpenAI 兼容 `baseUrl`；`--model` 按会话选且随会话持久化 | `docs/providers.md:31-65`、`docs/models.md:45-67` | ✅ |
| 6 | 派生并监控其他 harness（claude/codex CLI） | 无内建编排（README 明示刻意不做），但**官方 subagent 扩展示例 = 完整蓝图**：`spawn` 子进程 + NDJSON 逐行解析 + usage 聚合 + abort（SIGTERM→5s→SIGKILL）+ 并发上限 + parallel/chain 模式 | `packages/coding-agent/examples/extensions/subagent/index.ts:344-420` | ✅ 换命令即适配各家 CLI |
| 7 | 上报工作台 REST（遥测/回执登记） | 扩展 `registerTool`：execute 里直接 fetch；`structuredContent` + `outputSchema` 给程序调用方；`promptGuidelines` 注入系统提示成为硬规则 | `src/core/extensions/types.ts:579-668`、`examples/extensions/structured-output.ts` | ✅ |
| 8 | 交接 Skill（跨基座可用） | Skills 在 headless（JSON/RPC/SDK）同样生效，`/skill:` 展开在核心 `AgentSession` 不是 TUI 专属；官方 handoff 示例含 `newSession({parentSession})` 会话链 | `src/core/agent-session.ts:2177-2201`、`examples/extensions/handoff.ts:80-190` | ✅ |
| 9 | MCP（可选路径） | 完整 MCP 客户端（stdio + HTTP + OAuth）；扩展可动态 `registerMcpServer`；工具以 `mcp__<server>__<tool>` 暴露 | `packages/mcp/README.md`、`docs/mcp.md` | ✅ |
| 10 | Windows 一等公民 | 专门文档；bash 工具依赖 Git Bash（或 settings `shellPath`），另有 powershell 工具；JSONL 分帧接受 CRLF | `docs/windows.md` | ✅ 本机已有 Git Bash |

抽查复核（一手验证）：`docs/cli.md:92`（--session-id 存在且语义如上）、`docs/rpc.md:99-130`（Python 示例原文）、`docs/sessions.md:50`（--session-dir）。

## 二、意外的加分项

1. **`contextUsage.percent`**：把"会话退化该重建"从主观信号（打回率上升）升级为可直读的量化信号 → 已写入 DESIGN.md §12.3。
2. **会话 JSONL 格式完全文档化**（`docs/session-format.md`，含解析示例）且目录可控（`--session-dir`）→ 钻取（DESIGN.md §15.3）渲染原始会话零障碍，工作台可直接解析归档。
3. **中国 provider 原生齐全**，模型层不用绕。
4. 官方示例库（subagent / handoff / plan-mode / structured-output / bash-spawn-hook）几乎覆盖我们要写的扩展的所有构件。

## 三、需要我们自己写的（pi 不提供）

| # | 组件 | 说明 |
|---|------|------|
| 1 | **chief 扩展** | `dispatch` 工具（spawn 各家 CLI、解析输出、上报遥测）+ `report` 工具（POST 工作台）；骨架抄 subagent 示例 |
| 2 | **多 CLI 适配层** | `claude -p --output-format …` / `codex exec …` 各自的参数与 JSON schema → 统一派发遥测事件的映射器 |
| 3 | **Python RPC 客户端封装** | asyncio 子进程管理；严格 LF 二进制分帧（禁 `str.splitlines()`，U+2028/U+2029 陷阱）；`agent_settled` 为回合完成判据；`get_session_stats` 轮询 |
| 4 | 子 harness 的 token | pi 只见自家进程用量；子 CLI 用量从其 stdout 解析，解析不到标"估算"（与设计一致） |

## 四、集成边界（风险控制）

- pi 迭代快：1.2.0 CHANGELOG 含 breaking changes；**pi-durable 明示"Experimental, API changes without notice"**。
- 因此集成面收缩到三层**有文档与版本化承诺的稳定面**：**RPC 线协议 + CLI flags + session JSONL 格式**。
- 不依赖：pi-durable、packages/agent 内部 API、TypeScript SDK（除非未来确实需要 Node sidecar 的独占能力）。
- 锁版本（1.2.0），CI 里跑一次协议冒烟测试再升级。

## 五、结论

pi 的两个核心定位能力——**跟模型对话**（RPC 官方跨语言通道 + 80 余 provider + 会话幂等恢复）与**调用其他 harness**（扩展 spawn 子进程 + 官方 subagent 参考实现）——均经过源码验证成立，且对 Windows、中国网络环境、token 计量、上下文监控都有超出预期的支持。选型确认，DESIGN.md §13 已按核查结果具体化（v0.3）。
