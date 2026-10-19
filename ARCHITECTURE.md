# 架构

一个 daemon 持有全部 agent 连接，pi 通过扩展驱动它。

```
┌──────────────────────────────────────────────────────────┐
│ pi（TUI）                                                 │
│   extension: agent-router                                │
│     · 8 个工具                                           │
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

---

## 分层

| 层 | 文件 | 行数 | 只负责 |
| --- | --- | --- | --- |
| 入口 | `extension/agent-router.ts` | ~506 | 渲染 + 路由 |
| 客户端 | `client/agentd-client.mjs` | ~281 | 连接 + 订阅 + 续传 |
| 服务 | `daemon/agentd.mjs` | ~469 | 持有 pool + 事件身份与广播 |
| 核心 | `core/agent-pool.mjs` | ~1024 | agent 生命周期 + 会话 + 指标 |
| 适配 | `server/pi-acp-adapter.mjs` | ~530 | ACP ↔ pi RPC |

依赖方向是单向的：入口 → 客户端 → daemon → core。`core` 不知道 HTTP、MCP、pi 扩展、
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
| 活跃会话指针 | 我们（连接内） | 持有 |
| 标签 / 模型选择 | 我们（sidecar） | 补 harness 的缺口 |
| job / 进度 / 回执 | 我们 | 生成、持久化、广播 |
| agent 进程 | 我们 | 起、重启、关闭 |
| 工作区文件 | **用户** | 不写（见守则） |

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
- **未做 Web**：事件层已经具备条件（id + 重放 + 回执），但还没有 HTTP 出口
