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
- **调度器就是 pi**：`core/dispatcher/dispatcher.mjs` 持有一个 `pi --mode rpc`（加载 agent-router 扩展），
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
| 服务 | `daemon/agentd.mjs` | 只做组装：把下面几块接起来并启动 |
| | `daemon/ops/` | 客户端能调的 61 个操作，按领域分五个文件：`executors`、`run`、`dispatcher`（含交接）、`projects`（含模板）、`system`；`index.mjs` 合并，重名直接报错 |
| | `daemon/dispatchers.mjs` | 执行者的事件接线、每个项目一个调度器的注册表、交接提议和连续失败计数 |
| | `daemon/startup.mjs` | 启动时处理上一个守护进程没跑完的任务 |
| | `daemon/server.mjs` | socket 协议、端点文件、监听 |
| | `daemon/lifecycle.mjs` | 空闲回收、空闲退出、关闭 |
| | `daemon/events.mjs` | 事件身份（epoch/seq）、环形缓冲、投递 |
| | `daemon/guard.mjs` | 谁能调哪些操作（调度器的限制）、项目内名字解析 |
| | `daemon/receipts.mjs` | 回执（`receipts.jsonl`） |
| 核心 | `core/agent-pool.mjs` | 只做再导出，保持一个导入路径 |
| | `core/pool/config.mjs` | 常量、CLI 注册表、`agentd.config.json` |
| | `core/pool/store.mjs` | 会话旁路数据（标签、目录、模型、上下文、压缩次数） |
| | `core/pool/registry.mjs` | 池 Map、进程数上限、同类型启动锁 |
| | `core/pool/acp-client.mjs` | 一个常驻进程：会话、模型、规则注入，把下面三块组合起来，对外接口不变 |
| | `core/pool/acp-transport.mjs` | 和 ACP 进程之间的线：启动、读行、应答（含自动批准权限）、带空闲/总超时的请求、放弃进程；不知道会话和运行 |
| | `core/pool/run-tracker.mjs` | 一次运行怎么从 `session/update` 变成状态和对话记录：文字、推理、工具调用（从开始跟到结束）、分段写入、进度；不知道进程 |
| | `core/pool/prompt-queue.mjs` | 一个执行者的排队：先进先出、按任务号取消排队中的、取消后立刻回复调用方；会话操作走同一条队 |
| | `core/pool/metrics.mjs` | 运行指标与推断的健康信号 |
| | `core/pool/compaction.mjs` | 上下文占用与自动压缩 |
| | `core/pool/instances.mjs` | 内置与自建实例 |
| | `core/projects.mjs` | 项目、执行者配置（不往项目里写任何文件） |
| | `core/rules.mjs` | 调度器和执行者的规则文本（来源 `contexts/`） |
| | `core/templates.mjs` | 执行者模板：`contexts/templates/*.md`（文件头 + 系统提示词）的增删改查；执行者规则 = 通用规则 + 模板提示词，每次启动重读 |
| | `core/pool/system-prompt.mjs` | 把规则交给各 CLI 的系统提示入口 |
| | `core/pi-rpc.mjs` | 和 pi RPC 通话的唯一一份实现（调度器和 pi 适配器共用，只依赖 node 内置模块） |
| | `core/dispatcher.mjs` | 只做再导出，导入路径不变；代码在 `core/dispatcher/` |
| | `core/dispatcher/dispatcher.mjs` | 调度器：pi 进程的生命周期、接线、模型与状态、作为交接的目标；把下面三块组合起来 |
| | `core/dispatcher/sessions.mjs` | 会话文件：列表、命名、删除、每一轮的用时；只认目录，不碰 pi |
| | `core/dispatcher/turn-queue.mjs` | 一轮是否在跑、排队的消息、取消排队；只要一个 `send` 函数，不碰 pi |
| | `core/dispatcher/context.mjs` | 上下文数字（存盘）与超过阈值的压缩；规则和执行者共用 `pool/compaction.mjs` |
| | `core/handoff.mjs` | 交接：提案、生成文档、开新会话 |
| 适配 | `server/pi-acp-adapter.mjs` | ACP ↔ pi RPC（含 `/compact`） |

依赖方向是单向的：入口 → 客户端 → daemon → core（`core/pool/` 内：acp-client → transport/run-tracker/prompt-queue、registry/store/metrics/compaction → config；这三块互相不引用）。`core` 不知道 HTTP、MCP、pi 扩展、
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
run_failed / timeout / forced_stop / refused / agent_restarted   → error
context_pressure / cancelled / empty_output        → warn
slow_run                                           → info
```

每次运行产出 `health` + `attention[]`，随 `job.done` 和回执一起落地。
`attention[].source` 目前恒为 `system`，这个字段是给将来「agent 主动上报」预留的。

`durationHistory` 每个 agent 保留最近 20 次，用于判断 `slow_run`（超过 p95 两倍）；
它只在运行结束时写入，读取指标不会污染基线。

### 超时、取消与强制结束

先礼貌地问一下，不行就杀掉（思路同 Celery 的软超时 / 硬超时）：

```
执行者沉默 5 分钟（`timeout`；正在跑的工具调用不算沉默）  或  总时长超过 2 小时
  → 发 session/cancel                       软超时：请它停下来
  → 等 15 秒（AGENTD_CANCEL_GRACE_MS）
  → 它结束了：任务记为 timeout
  → 还没结束：杀掉整棵进程树（Windows 用 taskkill /T /F），任务记为 timeout + forced
下一次派发：自动重启进程，回到同一个会话
```

- 只杀直接子进程不够：适配器、真正的 CLI、它启动的工具是三层进程，卡住的构建会留下来。
  `tools/forced-stop-test.mjs` 用「脱离父进程的孙进程」验证这一点。
- 强制结束不算崩溃：不发 `agent.exit`，发 `agent.forced-stop`（带次数）。
- 每个任务有明确终态 `outcome`：`done / failed / timeout / cancelled`（另有 `unstable`，见下），
  回执的 `status` 取自它；`forced` 表示是靠杀进程收尾的。
- 熔断：同一个执行者 30 分钟内被强制结束 3 次，就标记 `unstable`，之后的派发立刻失败并说明原因，
  不再启动进程，直到人点「恢复」（`POST /api/agents/:id/recover`，调度器无权调用）。
  次数和窗口在 `agentd.config.json` 的 `limits.forcedStopLimit` / `limits.forcedStopWindowMin`。
- 强制结束可能让一次文件写入停在一半；错误信息会提醒调度器先检查再重派。
- 取消按运行（`jobId`）：`cancel` 带 `jobId` 时只动那一个——还在排队的在开始前直接摘掉（结果为 `cancelled`，不会到 CLI），
  正在跑的发 `session/cancel`，已经结束的什么都不做。不带 `jobId` 还是取消该执行者当前在跑的那个。
  调度器被中止时只取消**它自己发出的**任务（包括排队的），不再误动别的任务。
- 取消也有硬收尾：CLI 在宽限期内不响应，同样结束进程（结果为 `cancelled` + `forced`）。
  pi 适配器以前根本没实现 `session/cancel`（停止对 pi 执行者是空操作），现在转成 pi 的 `abort`，以 `stopReason: cancelled` 结束。

### 守护进程中途停止：在途任务不能凭空消失

回执在任务**结束**时才写，所以守护进程在任务运行中被重启或崩溃，原本不会留下任何痕迹。
做法是先记下来，重启后对账（思路同预写日志）：

- `core/journal.mjs` 把每个任务交出去时记一条 `start`，结束时记一条 `end`（`data/journal.jsonl`，追加式）。
- 守护进程启动时读一遍：有 `start` 没有 `end` 的就是上一个进程没做完的（排队中或运行中），
  补写一条 `interrupted` 回执，发 `job.interrupted` 事件，然后清空日志，每个任务只报一次。
- 每个执行者记住自己最近一次被中断的任务（`data/journal.jsonl.interrupted.json`），直到它收到新任务才清掉；
  它出现在实例行的 `interrupted` 字段里，界面标题栏显示「上次任务因服务重启被中断」，
  调度器每一轮的系统提示里也会看到这一条，和 `unstable` 一起。
- 执行者自己的对话里也要看得到：启动对账时，在它那次任务所在的会话（按任务号在会话记录里找）末尾追加一条 `error` 条目（`interrupted: true`），网页显示为「被中断」，不带用时。
- 调度器对话里，派发那一行没有结果、而调度器此刻不在工作（`dispatcher.busy` 为假），就不可能还在进行——显示「已中断：没有收到结果」，展开有说明。
- 只记录和通知，不自动重跑：执行者可能已经写了一半的文件，重不重派由调度器或人决定。
- 尚未做：调度器自己正在进行的那一轮（对话里留下一个没有结果的工具调用）不在这套记录里。

### 长回复不能撑满调度器

调度器拿到的每一段内容都会一直留在它的对话里。执行者一次贴出几万字（整份文件、长日志），调度器就被撑满。

- `core/reply.mjs` 的 `fitReply`：回复不超过 6000 字符（`AGENTD_REPLY_CHARS`）原样给；
  超过则全文存进 `data/results/<jobId>.md`，调度器只收到开头、结尾，和「省略了多少字、全文在哪个文件」的提示。
- 只在给调度器的那一层裁剪：网页、会话记录、`run` 操作的返回仍然是全文。
- 文件夹只保留最新 200 个。
- 这也是「用文件传递大量信息」的兜底：调度器想看中间部分可以自己读那个文件。

### 任务身份与重试上限

`jobId` 是一次运行。同一件事失败后再发，要能认出它们是同一个任务，并且不能无限重试：

- `core/tasks.mjs`：每次运行归入一个任务（`taskId`），带第几次尝试（`attempt`）和重试的是哪一次运行（`retryOf`）。
  任务状态在 `data/tasks.json`，重启后仍在。
- 怎么认出是重试（不依赖调度器配合）：
  1. `agent_run` 的 `retry_of` 参数给出上一次的任务号或运行号；
  2. 或者同一个执行者在失败后 30 分钟内收到**同样的提示词**（空白不影响）。
- 只有 `failed / timeout / interrupted` 算失败；`done` 和 `cancelled` 结束任务；被熔断拒绝的（`unstable`）不算。
- 失败满 3 次（`limits.maxAttempts`）后不再发出：`run` 直接抛 `retry-limit`，
  告诉调度器「不要再重试，把情况告诉用户」，执行者不会启动。**上限只对调度器**（请求带 `caller: "dispatcher"`）；
  人直接发同样的消息，当作新任务，并关闭之前失败的那条链，不会被拦。
- 调度器每次拿到结果或失败，末尾都有一行 `[task …, attempt n of 3, job …]`，要重试时照抄这个号。
- 字段进了：回执、`job.started` / `job.done` 事件、任务日志、执行者会话记录的每一条。
- 网页：调度器对话里，派发给执行者的任务是一行（派发给谁、任务摘要、第几次尝试、状态），点开看任务全文和回复；
  执行者的会话里，重试发来的那条消息下面标「第 n 次尝试」。
- 排队：一个执行者一次只跑一个任务，后来的在它后面等（先进先出）。**调度器也一样**：它正在做一轮时再发消息，消息排队，
  这一轮结束后按顺序发下一条（先不做「插话」）；排队的消息在对话下面显示「排队中」，可以单独取消；停止当前这一轮会把排在后面的一起丢掉。
  守护进程重启，排队的消息丢失。`startPrompt` 返回 `ahead`（前面有几个），`job.started` 带 `queued / ahead`，
  真正开始时发 `job.running`。网页里排队的派发行显示「排队中（前面还有 N 个）」，用时从真正开始算；
  页面是任务中途打开的，用执行者那一行的 `waiting`（排在运行中那个后面的个数）判断：它的未完成派发里最新的 `waiting` 个是排队的。
- 尚未做：任务视图（列出所有任务和尝试链）。

### 执行者在干什么要看得见

一个任务跑几分钟，界面上不能是一片安静，否则分不清是在干活还是挂了。

- **pi 适配器**（`server/pi-acp-adapter.mjs`）原来只转发回答文字，工具调用和推理全被丢掉。现在把 pi 的
  `tool_execution_start / update / end` 转成 ACP 的 `tool_call / tool_call_update`，`thinking_delta` 转成
  `agent_thought_chunk`。下游本来就会处理它们：写进会话记录（网页里显示工具调用），也算作「有动静」，
  所以长时间跑工具的 pi 执行者不会再被沉默超时误杀。
- **进度事件** `progress` 现在带 `agent`、最近一个工具（`tool`）、工具调用次数、未结束的工具数；
  工具开始时立刻发一次，不再只在文字到来时发。
- **网页**：任务进行中只显示一件事——总用时（「进行中 · 已用时 1 分 47 秒」的形式，调度器对话里派发的那一行和执行者标题栏都是）。
  不再推断「没有新动静」「思考中」之类的状态：它们靠事件间隔猜，会猜错，反而让人慌。
  做了什么交给下面的工具调用和思考过程去看。页面是任务中途打开的，也能从执行者那一行的 `activity.startedAt` 算出用时。
- **看得到内部**：会话记录里工具调用带 `input`（给了它什么）和 `output`（它返回了什么，截断），
  推理文字存成 `thought` 条目（上限 12000 字）。网页里工具调用点开能看输入和输出，
  执行者的回复前有一个默认收起的「思考过程」。
- **用时**：调度器对话里，派发那一行结束后保留「用时 …」；一次调度器对话（用户一句话到最后一个回复）
  在回复下面标「本轮用时」，时间取自调度器会话文件里每条记录的落盘时间
  （pi 消息自带的时间是开始时间，不能用来算结束）；执行者的每个回复下面标「用时」（提示词记录到回复记录之间）。
- 工作中的圆点用呼吸动画（放大、发光、变淡，`@keyframes breathe`），减少动效偏好下改为静态光环。

### 失败：谁报的，原样告诉人

不做细分类，也不自动重试，两条规则：

- **agentd 自己产生的失败**（超时、被强制结束、被中断、进程退出、被取消、熔断、重试上限）：agentd 报，写明是 agentd 报的。
- **CLI 自己报的错**（它返回的 JSON-RPC 错误，比如额度用完、未登录、模型不存在）：**原文转发**，不改写、不猜类别，写明是 CLI 报的。
- 两者都由人来决定下一步。调度器收到失败时，规则要求它把原因和来源如实告诉用户并等待，不自己重试、不换执行者重做；
  用户明确要求重试时才重新派发（带 `retry_of`，上限 3 次仍然有效）。
- 记录：运行结果和回执里的 `failureSource` 是 `agentd` 或 `cli`（成功时为空）。

### pi 的两条通路共用一个客户端

调度器（`core/dispatcher.mjs`）和 pi 适配器（`server/pi-acp-adapter.mjs`，单独的进程）以前各自带一份和 `pi --mode rpc`
通话的代码，两份写得不一样：调度器取上下文统计时多拆了一层 `data`（占用环一直空），适配器没实现 `session/cancel`
（停止 pi 执行者是空操作），只有适配器会压缩。现在都用 `core/pi-rpc.mjs` 的 `PiRpc`：启动与停止、命令与回复按编号对应并带超时、
一轮的开始与结束、事件监听、一组带名字的命令（状态、统计、压缩、中止、新会话、换模型……）。各自特有的留在各自那边
（调度器：会话文件、排队、用时；适配器：ACP 翻译、会话编号对应）。

### 调度器的压缩与交接（和执行者同一套规则）

- **压缩**：项目设置里给调度器设一个大小（`PATCH /api/projects/:id/dispatcher`，K tokens，**默认关闭**），一轮结束、空闲时检查，
  超过就让 pi 压缩；规则和执行者共用 `compactIfNeeded`（不在忙时压、压完没变小不立刻再压、失败不记录）。
  压缩期间发来的消息排队，压完再发。压缩后 pi 会有一段时间报不出新的占用，下一轮才有数。
- **pi 的压缩有下限**：它只压缩最近约 20K tokens 之前的部分，并且不能从一条消息中间切开。会话没有那么大，或者几条超大的消息撑起来的，
  压不下来（`Nothing to compact (session too small)`）；所以设置建议不低于 50K。这条对 pi 执行者同样成立。
- **交接**：调度器也可以被系统提议换新会话（压缩满 3 次时），在交接里叫 `@dispatcher`；交接文档是它自己的回复，你确认后开新会话、
  新会话第一条消息带文档，旧会话保留。新会话由 pi 在第一条消息时才写文件，所以起名不要求文件已存在。
- 调度器不能改自己的压缩设置（和交接的生成、确认一样，只有人能做）。

### 执行者对话里的文字、推理和工具调用，按发生的顺序

- 以前一次运行的文字只在**结束时**写成一条，排在所有工具调用之后；推理也是一条。网页因此看不出"先说了什么、再调了什么"。
  现在每次**工具调用开始时**，先把之前说的话和想的东西写成一条（`assistant` 带 `piece: true`，`thought`），再写工具调用；
  运行结束时写最后一条 `assistant`（只含剩下的文字，总带着怎么结束的；最后一步是工具调用时文字为空）。每条带 `startedAt`（它开始的时刻）。
  返回给调用方的回复仍是整段文字。
- `tail` 多给 `pendingText` / `pendingThought`：还没写进记录的那一段，网页拿它画「活的末尾」。
- 网页的 bug：以前每 1.5 秒取一次「这次运行到现在的**全部**文字」，如果最后一项不是实时文字就新建一个气泡；而同一轮里工具调用的记录会排到它后面，
  所以每一轮都新建一个，里面装着完整的累计文字，看上去就是同一句话一遍遍重复。现在活的末尾只有一个位置，每次整体替换，只放还没进记录的那一段。
- 进入一个正在工作的执行者，活的末尾马上就有，不用等第一次刷新。
- 每条消息显示开始的时刻（调度器的取 pi 消息自带的开始时间，执行者的取这一段的 `startedAt`）；你发出的消息还会标「已收到」。
- 对话末尾有一行状态：调度器是它自己报的事件（思考中、正在回复、等待某执行者的结果、正在使用某工具），执行者是「处理中」，都带从发消息起的用时。
- 往上翻页时出现「回到最新」按钮。

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
  确认，才会开新会话。交接文档由执行者直接作为回复交出（提示词在 `contexts/handoff-write.md`，开新会话那条在 `handoff-start.md`，
  都只在交接那一步发出、每次现读；不再用 skill 文件，也不写进执行者目录），
  副本留在 `data/handoffs/`；新会话的第一条消息里带着这份文档。
- **支持的 CLI**：mcode、dsh、pi、opencode（原生 ACP）、claude 和 codex（经官方适配器 `@agentclientprotocol/claude-agent-acp`、`codex-acp`，全局安装在 Node 目录）。注册表在 `core/pool/config.mjs`；claude 用 `CLAUDE.md`、技能放 `.claude/skills`，opencode 技能放 `.opencode/skills`，codex 与 dsh、pi 一样用 `.agents/skills`。opencode 的 `/compact` 虽不在 ACP 的命令列表里，但可用（实测占用 8512→806）。
- **规则**：不写进项目（没有 AGENTS.md、CLAUDE.md、skills），通过各 CLI 的额外系统提示入口交：mcode 启动参数、pi 启动参数、
  claude / codex 的 `session/new` `_meta`、opencode 的配置环境变量，dsh 没有入口，放在每个会话第一条消息前面（压缩后再补一次）。
  六种都实测过：新会话、恢复会话后都生效（`tools/system-prompt-probe.mjs`、`tools/rules-live-test.mjs`）。

---

## 设计守则

四条，用来防止项目从「调度器」漂成「harness」。

**1. 只观测，不改写**

不写 agent 的工作区，不替换它的系统提示，不改写对话内容。
这条排除了：往项目里写 AGENTS.md / CLAUDE.md / skills、覆写（替换）system prompt、改写对话内容。
**唯一的例外**是规则：启动时给 agent **追加**一段额外系统提示（只加不换，agent 自己的提示和项目自己的 AGENTS.md 照旧生效）。
这是 2026-10-23 决定的：写文件会干涉项目，而且项目已有 AGENTS.md 时我们的规则根本不生效。

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
