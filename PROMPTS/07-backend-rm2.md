# 任务：SpecLock 2 后端——R-M2 接入轮（真实核心代理 + 真实派发，分 A/B 两阶段）

## 角色

你是 SpecLock 2 项目的后端主代理，负责 `backend/`，本切片起**领地扩展到新顶层目录 `chief/`**（核心代理的 pi 扩展，Node/TS）。M1 已总验收通过（22 测试全绿 + live 全链路）。本接入轮把"人工模拟核心代理"换成真的：pi 驱动的核心代理对话、经工具起草真卡、真实派生 harness 进程干活。这是全项目机制最密集的一轮，**按 A/B 两阶段推进，A 自测通过再进 B**。

## 前置（开工第一步）

1. **先完成调整单**：`GET /api/p/{slug}/blocks/{id}/versions/{version}` 版本快照端点（DEV-PLAN §2 状态列 `S2-fix` 那行，含响应形状说明），提交 `feat(backend,fix)`；
2. 安装 pi：`npm i -g @earendil-works/pi-coding-agent`（锁 1.2.0，`pi --version` 确认；本机 npm 可直连）。

## 必读材料（仓库根目录下，全部按序读完）

1. `DESIGN.md`——§13（**运行时与派发协议：架构图、时序、提示词模板**）、§16（语言规范=核心代理宪法）、§3（角色）、§6.4（技术任务单与分诊）、§12.2（启动两件套）、§7.2（事件类型，注意 `chat.human`/`chat.chief`）
2. `PI-ASSESSMENT.md` **全文**——pi 集成的全部事实依据：RPC 模式与官方 Python 示例、**LF 二进制分帧陷阱（禁 `str.splitlines()`）**、`agent_settled` 完成判据、`get_session_stats.contextUsage.percent`、`--session-id` 幂等恢复、`--session-dir`、`--append-system-prompt`、Windows 注意事项
3. `DEV-PLAN.md` §2 契约 **v0.3**（新增 chat/agent 五个端点）

## 架构决定（按此实现，细节可自主设计）

**新增 `chief/`（pi 扩展，jiti 加载的 TS）**：
- `chief/extension/index.ts`，注册三个工具（参考 pi 仓库 `examples/extensions/subagent` 的 spawn/解析骨架）：
  - `draft_card`：结构化起草——参数即 Card 的 `{statement, rule_ops, api_ops, impact, risk}`（outputSchema 校验）→ POST 工作台 `POST /api/p/{slug}/cards` → 返回 `{card_id}`。**卡片必须经工具产出，不许在自由文本里贴 JSON**；
  - `dispatch`：派发——参数 `{task_id}` → 查任务（工作台提供的信息已在提示里）→ 按 `masters.harness` 值映射命令行（配置见下）spawn 真实 CLI 子进程 → 逐行解析其 JSON 输出 → 遥测与回执 POST 工作台 → 返回结果摘要；
  - `workbench_report`：通用上报（过程遥测）。
- `chief/constitution.md`：核心代理宪法（`--append-system-prompt` 注入），内容必须包含：语言规范五条（DESIGN §16 原文）、角色职责（唯一人机接口/分诊规则 §6.4/起草卡片走 draft_card 工具/派发走 dispatch 工具）、业务变更说明书规范（§6.2）。

**backend 侧 `speclock2/pi_runtime.py`（pi RPC 适配层）**：
- 每项目一个常驻子进程：`pi --mode rpc --session-id speclock2-{slug} --session-dir <data>/pi-sessions -e chief/extension/index.ts --append-system-prompt chief/constitution.md --model <配置>`；
- asyncio 读写：**stdin 写 JSONL 命令（带自增 id），stdout 二进制流按 `\n` 切分再 decode**（U+2028/U+2029 陷阱，PI-ASSESSMENT 有说明）；持续读防背压；
- 回合完成判据 = `agent_settled`；`message_update` 的 text_delta 转发到 SSE；
- 定期 `get_session_stats`：`context_usage_percent > 80` 时落一条告警事件（会话退化信号，DESIGN §12.3）。

**对话入库**：`POST /chat` 落 `chat.human` 事件；核心代理每条完成的消息落 `chat.chief` 事件——对话是对话流渲染源，也是账本的一部分（A5）。

**派发链（B 阶段）**：卡片 approve 后，工作台向核心代理发一条消息"任务包 P-xxxx 已批准，请派发"；核心代理调 `dispatch` 工具；真实进程结束后回执 `POST /tasks/{id}/receipt`，状态机推进（复用 S2 的 dispatch/receipt/audit 端点，看门狗 deadline 接真实时间）。

**配置（env + README 写清楚）**：
- `SPECLOCK2_CHIEF_PROVIDER` / `SPECLOCK2_CHIEF_MODEL` / 对应 provider 的 API key env；
- harness 命令映射（JSON 配置文件，放 data 目录）：`{"claude-code": "claude -p --output-format stream-json --verbose", "codex": "codex exec --json", "pi": "pi --mode json"}`——被派发 CLI 优先用 `pi` 自身（本机必有），claude/codex 装了就用；
- **降级开关 `SPECLOCK2_CHIEF_MOCK=1`**：无 provider key 时核心代理走本地模拟（沿用 M1 的模拟文案与行为），保证 A/B 链路无 key 也能全流程自测。

## 阶段 A：对话与起草闭环

pi_runtime + 五个新端点 + SSE + 对话入库 + `draft_card` 工具链路。
自测：`SPECLOCK2_CHIEF_MOCK=1` 下 POST chat → SSE 收到 `message_delta`/`message_final`；对话触发起草 → 卡片出现在 `GET cards?status=pending`；`GET events?type=chat.human` 可回放；有 key 时同流程用真模型跑一遍。

## 阶段 B：派发与回执闭环

`dispatch` 工具 + harness 映射 + 真实进程监控 + 遥测/回执 + 看门狗接真实 deadline。
自测：批准一张卡 → 核心代理派发 → pi 子进程真实执行（任务用"在 backend/ 下写一个 hello 文件后回执"这类自指派小任务）→ 回执到达 → 任务 done；强杀被派发进程 → 看门狗 timeout 事件；receipts 里有时长与 token（能解析到就精确，解析不到标"估算"）。

## 验收标准（自检全过才算完成）

1. 调整单端点工作（草稿与历史版本都能读）；
2. A：SSE 流式对话（mock 与真模型两种模式）；核心代理经 `draft_card` 产出结构化卡片（不是自由文本）；对话事件入库可回放；
3. B：批准 → 真实 harness 进程启动并完成 → 回执 → done；杀进程 → timeout；遥测落在 receipts；
4. `get_session_stats` 的 context_usage_percent 能从 `GET /agent` 读到；
5. pytest 全绿（含：pi_runtime 分帧单测——用一个假 pi 脚本输出带 U+2028 的行验证不炸；对话入库；映射配置解析；S0/S1/S2 不回归）；
6. README 更新：pi 安装、所需 env 清单、harness 映射配置、mock 模式说明、全流程自检脚本。

## 约束

- 领地：`backend/` + `chief/`；不改 `web/`、`DESIGN.md`、`DEV-PLAN.md`、`PROMPTS/`；
- 不做前端工作（SSE 由前端下一轮接）；契约以 v0.3 为准，疑问走回执；
- pi 集成面收缩在三件稳定物上：RPC 线协议、CLI flags、session JSONL——不 import pi 的内部包、不依赖 pi-durable；
- 提交：A 阶段 `feat(backend,rm2a)`、B 阶段 `feat(backend,rm2b)`（调整单 `feat(backend,fix)`）；不要 push；UTF-8、注释中文量少而准。

## 回执模板

```markdown
## 回执（R-M2 后端·接入轮）
- 阶段完成情况：A ｜ B ｜ 调整单
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要；注明 mock/真模型）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：（pi 版本、node 版本、provider key 状态）
```
