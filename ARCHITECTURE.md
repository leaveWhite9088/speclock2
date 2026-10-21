# 架构

一个 daemon 持有全部 agent 连接，pi 通过扩展驱动它。

```
┌──────────────────────────────────────────────────────────┐
│ pi（TUI）                                                 │
│   extension: agent-router                                │
│     · 10 个工具                                          │
│     · 3 个斜杠命令                                        │
│     · onUpdate 流式渲染（不占 context）                    │
│     · abort signal → session/cancel                      │
└──────────────────────────────────────────────────────────┘
              │ 命名管道 \\.\pipe\pi-agentd（JSONL）
              ▼
┌──────────────────────────────────────────────────────────┐
│ agentd（单例常驻，detached）                               │
│                                                          │
│   core/agent-pool.mjs                                    │
│     AcpClient × 3                                         │
│       · 活跃会话指针   · live: Set                        │
│       · 串行队列       · job 注册表 + 指标                 │
│     · 标签 / 模型（session-labels.json）                   │
│     · 回执（receipts.jsonl）                              │
│     · 事件环 + epoch/seq                                  │
│                                                          │
│   agentd.config.json → 每个 agent 的启动目录               │
└──────────────────────────────────────────────────────────┘
      │ ACP              │ ACP                 │ ACP
      ▼                  ▼                     ▼
 mcode acp         dsh --profile acp     pi-acp-adapter.mjs
 （常驻）           （常驻）                    │ RPC
                                              ▼
                                       pi --mode rpc
```

为什么是 daemon：agent 进程的寿命不应该绑在 pi 会话上。没有 daemon 时，3 个 pi 窗口
= 3 套 agent（约 2GB）、3 份互不相识的会话状态、并发写同一个 sidecar 丢更新。

**三项扩展（协议版本 2）**

- **多实例**：池里的单位是「实例」而不是「CLI 类型」。实例 id → 一个 AcpClient 进程 → 一个固定目录。
  内置实例 id 等于类型名；自建实例存 `data/instances.json`。
- **对话记录**：`core/transcripts.mjs` 把经手的每一轮追加到 `data/transcripts/<实例>/<sessionId>.jsonl`，
  `seq` 做游标。这是「补 harness 缺的」：ACP 不提供读历史的统一方式。
- **调度器就是 pi**：`core/dispatcher.mjs` 持有一个 `pi --mode rpc`（加载 agent-router 扩展），
  由它的 LLM 决定调哪个实例。池里的 `pi` agent 是 `--no-extensions` 的执行者，二者是两个进程。
  LLM 通过 `core/pi-models.mjs` 写 pi 的 `models.json` 来增删，随后重启调度器。

```
看板/客户端 ──► agentd ──► dispatcher (pi rpc + 扩展) ──agent_run──► agentd ──► 实例 × N
                  │
                  └──► transcripts/  instances.json  dispatcher-sessions/
```

**仓库是 monorepo，三层各一个包：**

```
web（React SPA）──/api──► backend（HTTP+SSE 薄网关）──agentd-client──► agentd ──► 实例 / 调度器
```

backend 只是 agentd 的又一个客户端（和测试脚本、pi 扩展同级）：路由一对一映射到 agentd 操作，
SSE 把 `subscribe('*')` 收到的事件原样转发。业务规则只在 agentd 里，换前端或网关不动核心。

---

## 分层

| 层 | 文件 | 只负责 |
| --- | --- | --- |
| 入口 | `extension/agent-router.ts` | 调度器的工具（`agent_run`、`propose_handoff` 等）+ 渲染 |
| 客户端 | `client/agentd-client.mjs` | 连接 + 订阅 + 续传 |
| 服务 | `daemon/agentd.mjs` | 操作表 + socket 协议 + 空闲回收 |
| | `daemon/events.mjs` | 事件身份（epoch/seq）、环形缓冲、投递 |
| | `daemon/guard.mjs` | 谁能调哪些操作（调度器的限制）、项目内名字解析 |
| | `daemon/receipts.mjs` | 回执（`receipts.jsonl`） |
| 核心 | `core/agent-pool.mjs` | 只做再导出，保持一个导入路径 |
| | `core/pool/config.mjs` | 常量、CLI 注册表、`agentd.config.json` |
| | `core/pool/store.mjs` | 会话旁路数据（标签、目录、模型、上下文、压缩次数） |
| | `core/pool/registry.mjs` | 池 Map、进程数上限、同类型启动锁 |
| | `core/pool/acp-client.mjs` | 一个常驻进程：会话、运行、JSON-RPC |
| | `core/pool/metrics.mjs` | 运行指标与推断的健康信号 |
| | `core/pool/compaction.mjs` | 上下文占用与自动压缩 |
| | `core/pool/instances.mjs` | 内置与自建实例 |
| | `core/projects.mjs` | 项目、执行者配置、写入 guides 与 skills |
| | `core/dispatcher.mjs` | 调度器（pi RPC） |
| | `core/handoff.mjs` | 交接：提案、生成文档、开新会话 |
| 适配 | `server/pi-acp-adapter.mjs` | ACP ↔ pi RPC（含 `/compact`） |

依赖方向是单向的：入口 → 客户端 → daemon → core（`core/pool/` 内：acp-client → registry/store/metrics/compaction → config）。`core` 不知道 HTTP、MCP、pi 扩展、
命名管道的存在，所以能被任何前端复用（测试脚本就通过同样的 socket 驱动它）。

---

## 一次运行的时序

```
extension          daemon              AcpClient            agent
    │                 │                    │                  │
    ├─ run(async) ───►│                    │                  │
    │                 ├─ startPrompt ─────►│                  │
    │                 ├─ subscribe(sock)   │                  │
    │                 ├─ publish job.started│                  │
    │◄── {jobId} ─────┤                    │                  │
    │                 │                    ├─ session/prompt ►│
    │                 │◄─ progress(500ms) ─┤                  │
    │◄─ progress ─────┤                    │                  │
    │                 │                    │◄─ stopReason ────┤
    │                 ├─ receipt = append()│                  │
    │                 ├─ publish job.done  │                  │
    │◄── job.done ────┤                    │                  │
    ├─ renderResult   │                    │                  │
```

关键点：

- **订阅在运行开始之前**：`run {subscribe: true}` 让 daemon 在返回 jobId 前就注册好 socket，
  避免「跑完了才订阅」丢事件。
- **回执先写盘再广播**：`job.done` 事件里的 `receipt` 已经带着自己的 `eventId`。
- **每个 agent 一个串行队列**：ACP 一个连接一次只能跑一个 prompt，不同 agent 可以并行。

---

## 事件模型

### 身份

```
{"id":"094fab8e-2","seq":2,"epoch":"094fab8e","event":"job.done", ...}
```

- `epoch`：daemon 启动时生成，重启即变 → 旧 id 会被识别为过期
- `seq`：单次生命期内单调递增

### 持久 vs 瞬时

| 事件 | 有 id | 进环（可重放） | 说明 |
| --- | --- | --- | --- |
| `job.started` | ✓ | ✓ | 任务开始 |
| `job.done` | ✓ | ✓ | 正常结束或失败（带 `result` 或 `error`） |
| `agent.exit` | ✓ | ✓ | 进程异常退出（无 jobId，广播给所有连接） |
| `progress` | ✗ | ✗ | 累计字符数快照，重放无意义 |

正文的持久形态是 `data/runs/<jobId>.log`，不是进度事件。

### 投递规则

```
有 jobId  → 该 job 的订阅者 + 订阅了 '*' 的连接
无 jobId  → 所有连接（系统事件）
```

### 续传

```json
{"op":"events.since","args":{"afterId":"094fab8e-1","limit":50}}
→ {"reset":false,"epoch":"094fab8e","events":[...],"hasMore":false}
```

`reset: true` + `reason: "epoch-mismatch"` 表示 daemon 重启过，调用方应改为读
`receipts.jsonl`。环上限 2000 条，更早的历史同样从 receipts 读。

历史（receipts）、缺口（环）、增量（实时推送）三段各管一件事，互不重叠。将来做 Web
看板时，SSE 的 `id:` 直接映射事件 id，`Last-Event-ID` 直接传给 `events.since`。

---

## 会话模型

每个 agent 维护：

| 状态 | 作用 |
| --- | --- |
| `sessionId` | 当前活跃会话 |
| `live: Set` | 本进程内已存活的会话 |
| `sessionConfig: Map` | 每个会话的 configOptions 缓存 |
| `queue` | 串行闸门 |

### 切换的三条路径

| 路径 | 触发 | 相对成本 |
| --- | --- | --- |
| live switch | 会话在 `live` 里 | 纯指针替换，不发 RPC |
| disk resume | 会话来自别的进程 | 一次 `session/resume` |
| 冷启动 | 进程还没起 | spawn + initialize + `session/new` |

`session/resume` 必须带 `cwd`，两个原生 agent 都一样。

### 为什么需要 `live: Set`

dsh 新建会话时不会关闭上一个，多个会话可同时处于「活跃」状态；对它再 resume 会报
`session is already active`。如果不处理，`sessionId` 还指向旧的，会**静默地答错会话**。
`live` 命中时只换指针，不调 resume。

### 标签

三个 agent 都没有 rename API（`session/set_title`、`session/rename` 等均 Method not found），
所以标签是本地 sidecar：`data/session-labels.json`，展示时与 agent 自带的 title 合并，
标签优先。

---

## 模型

ACP 没有 `session/set_model`（也没有 `set_mode`）。实际接口是：

```
session/set_config_option { sessionId, configId, value }
```

| agent | configId | 值格式 |
| --- | --- | --- |
| mcode | `model` / `thinkingEffort` / `permissionMode` | `m:provider:model:v:variant` |
| dsh | `model` / `reasoning_effort` | JSON 数组字符串 |
| pi | `model` / `thinking` | `provider/modelId` |

值格式完全不同，所以只透传不解析。`describeModels()` 统一把嵌套/分组的 options 拍平，
上层只看到扁平的 `{value, name}`。

### 持久化补偿

mcode 原生保留模型选择；dsh 和 pi 重启后回退默认。所以 pool 在 sidecar 里记一份，
`_attach` 时对比差异并重新推送。

---

## 健康信号

agent 不参与，全部由调度器推断：协议结果、自己的计时器、agent 上报的上下文占用。

```
run_failed / timeout / refused / agent_restarted   → error
context_pressure / cancelled / empty_output        → warn
slow_run                                           → info
```

每次运行产出 `health` + `attention[]`，随 `job.done` 和回执一起落地。
`attention[].source` 目前恒为 `system`，这个字段是给将来「agent 主动上报」预留的。

`durationHistory` 每个 agent 保留最近 20 次，用于判断 `slow_run`（超过 p95 两倍）；
它只在运行结束时写入，读取指标不会污染基线。

---

## 协议映射

### 对 agent（ACP）

用到的方法：`initialize`、`session/new`、`session/list`、`session/resume`、
`session/prompt`、`session/set_config_option`、`session/cancel`（通知）。

接收的通知：`agent_message_chunk`、`agent_thought_chunk`（只计入活动信号，不进正文）、
`usage_update`、`config_option_update`。

### pi 适配器（ACP ↔ RPC）

pi 没有 ACP，官方集成方式是 `pi --mode rpc`。适配器负责翻译：

| ACP | pi RPC |
| --- | --- |
| `session/new` | `new_session` + `get_state` |
| `session/list` | 本地注册表（pi 无 list 命令） |
| `session/resume` | `switch_session {sessionPath}` |
| `session/prompt` | `prompt` → 等 `agent_settled` |
| `session/set_config_option` | `set_model` / `set_thinking_level` |
| `session/update` 通知 | `message_update` 的 `text_delta` |
| token 指标 | `get_session_stats` |

两个必须的设计：

- **`--no-mcp --no-extensions`**：内层 pi 若加载同一个项目配置，会连回调度器形成递归；
  `--no-extensions` 还避免它发出本适配器无法渲染的 UI 请求。
- **session id 用文件名**：pi 的 `get_state.sessionId` 是进程级的（换进程就变），
  只有 session 文件名稳定。

---

## 状态归属

| 东西 | 归谁 | 我们做什么 |
| --- | --- | --- |
| 对话历史 | 各 harness 的磁盘 | 不碰，只要求 resume |
| 会话 id | harness 生成 | 记录 + 映射 |
| 对话内容（经 agentd 的） | 我们（`data/transcripts/`） | 追加记录 |
| 调度器对话历史 | pi（`data/dispatcher-sessions/`） | 不复制，按需读取 |
| 自建实例清单 | 我们（`data/instances.json`） | 持久化 + 启动时恢复 |
| 项目清单（根目录、实例、角色） | 我们（`data/projects.json`） | 持久化 + 启动时恢复；项目调度器会话在 `data/dispatcher-sessions/<项目>/` |
| pi 的 LLM 清单 | pi（`models.json`） | 显式命令才写，写前备份 |
| 活跃会话指针 | 我们（连接内） | 持有 |
| 标签 / 模型选择 | 我们（sidecar） | 补 harness 的缺口 |
| job / 进度 / 回执 | 我们 | 生成、持久化、广播 |
| agent 进程 | 我们 | 起、重启、关闭 |
| 工作区文件 | **用户** | 不写（见守则） |

---

## 会话与权限规则

- **执行者的目录创建后只读**：要换目录就新建执行者（`projects.updateInstance` 拒绝改目录）。
- **调度器只能派任务**：切换、新建、重命名、删除会话，重置会话、改目录，都只有人能做。`daemon/guard.mjs`
  对带 `caller: "dispatcher"` 的请求拒绝这些操作，调度器的扩展里也没有对应工具。
- **压缩**：每个执行者可设阈值（`compactAt`），由 agentd 在一个回合结束、执行者空闲时检查，超过就让 CLI 自己压缩
  （`/compact`；mcode、pi 支持，dsh 没有）。同一个会话内进行，不换会话。
- **交接**：换新会话，和压缩是两回事，上下文占比本身不触发。调度器只能 `propose_handoff`；系统也会在客观信号
  （同一会话压缩 ≥3 次、连续失败 ≥3 次）出现时自动提出。之后必须由人：生成交接文档 → 查看并可修改 →
  确认，才会开新会话。交接文档由内置 `handoff` skill 写到 `<执行者目录>/.agentd/HANDOFF.md`。
- **支持的 CLI**：mcode、dsh、pi、opencode（原生 ACP）、claude 和 codex（经官方适配器 `@agentclientprotocol/claude-agent-acp`、`codex-acp`，全局安装在 Node 目录）。注册表在 `core/pool/config.mjs`；claude 用 `CLAUDE.md`、技能放 `.claude/skills`，opencode 技能放 `.opencode/skills`，codex 与 dsh、pi 一样用 `.agents/skills`。opencode 的 `/compact` 虽不在 ACP 的命令列表里，但可用（实测占用 8512→806）。
- **skills**：随执行者目录写入（mcode 为 `.minimax/skills`，其他为 `.agents/skills`），来源 `packages/agentd/skills/`。

---

## 设计守则

四条，用来防止项目从「调度器」漂成「harness」。

**1. 只观测，不改写**

不写 agent 的工作区，不改它的 prompt、系统提示、上下文。
这条排除了：自动注入 AGENTS.md、system prompt 覆写、改写对话内容。

**2. 只补它没有的**

harness 自己能做好的，我们不做。每项状态都必须对应某个 harness 的缺失：

| 我们持有的 | 因为谁缺 |
| --- | --- |
| 会话标签 | 三家都没有 rename API |
| 模型持久化 | dsh / pi 重启后回退默认 |
| `live: Set` | dsh 多会话同时活跃 |
| 回执 / attention | ACP 不给 token、不给运行记录 |
| 每 agent 的 cwd | 没有统一的启动目录概念 |

哪天某个 harness 自己做了，我们这份就该删。

**3. 不替它做事**

能靠 prompt 让 agent 完成的，不在 hub 里实现。不解析/改写 agent 的输出，
不替它做文件操作，不替它做决策。

**4. 对工作区的写入必须是显式命令**

任何改动磁盘的操作都要人显式触发，**永不在运行路径上**。
运行路径只有：起进程、发 prompt、取消、读写我们自己的 `data/`。

---

## 边界与限制

- **同 agent 串行**：协议限制，不是实现选择
- **流式粒度取决于 agent**：dsh 只发一个 chunk
- **token 只有 pi 有**：另外两家的协议不提供
- **标签只在本地**：不写回 harness
- **pi 适配器 cwd 固定**：工作目录在进程启动时确定
- **无 `session/close`**：切过的会话会留在进程内存里
- **对话记录不含 agentd 之外的会话**：直接在 CLI 里聊的内容我们看不到
- **改 models.json 要重启调度器**：pi 只在启动时读取该文件；调度器忙时拒绝修改
- **未做 Web**：事件层已经具备条件（id + 重放 + 回执），但还没有 HTTP 出口
