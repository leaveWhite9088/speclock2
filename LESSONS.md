# 踩坑记录与实测结论

这个文件记录**为什么代码长成现在这样**。每条都来自实际跑出来的现象，不是推测。

分两部分：先写三个 harness 的行为差异（事实），再写我们自己踩的坑（教训）。

---

# 一、harness 行为（实测）

## 1. dsh 不是只有 web

`dsh` 报 `--profile <name> is required` 是因为它是**多 profile 启动器**，不是缺 profile 就报错。

| profile | 用途 |
| --- | --- |
| `web` | Web UI |
| `headless` | 一次性任务 |
| **`acp`** | **ACP server over stdio** |
| `tui` | 需先 `dsh plugin --profile tui add <package>`，本机没有 |

`headless` / `acp` 是内置模板，不用预装；只有 `web` 在 `~/.dsh/profiles` 下实体存在。

验证方式：

```sh
dsh --profile headless "Reply with exactly: PONG"   # → PONG
dsh --profile acp --help                            # → Serve automation clients over ACP stdio
```

## 2. 三家都说 ACP，但能力不同

| 能力 | mcode | dsh |
| --- | --- | --- |
| `session/list` | ✓ 带 title + updatedAt | ✓ 仅 id + cwd |
| `session/resume` | ✓ | ✓ |
| `session/close` | ✓ | ✓ |
| `session/fork` | ✓ | ✗ |
| `loadSession` | ✓ | ✗ |
| `mcpCapabilities` | `http` + `sse` | `http` |

注意 `mcpCapabilities` 里**都没有 stdio**。如果将来要给 agent 注入工具（MCP server），
必须走 HTTP，不能是 stdio。

## 3. 没有任何一家提供 rename

`session/set_title`、`session/rename`、`session/update`、`session/set_metadata`
全部返回 `"Method not found"`。

`mcode` 自己会生成 title（如 `Calculate 8*9`），但那是自动的，改不了。

**结论**：标签只能存在我们这边。这也意味着它不会出现在 agent 自己的界面里。

## 4. `session/resume` 必须带 cwd

只传 `sessionId` 会报：

```
Invalid params {"cwd":{"_errors":["Invalid input: expected string, received undefined"]}}
```

两个原生 agent 都一样。

## 5. dsh 允许多个会话同时"活跃"

`session/new` 不会关闭上一个会话。对已活跃的会话再 resume 会报：

```
Invalid params: session is already active: <id>
```

这个特性有个危险的后果：如果你吞掉这个错误继续用原来的 `sessionId`，程序**不会报错，
但会答出另一个会话的内容**。第一版切换就是这么错的——切回 A 失败，指针还停在 B，
接着提问得到的答案是 B 的。

## 6. 模型值是分组嵌套的

dsh 的 `model.options` 按 provider 分组：

```json
[{ "group": "deepseek-official", "name": "DeepSeek", "options": [ {...}, {...} ] }]
```

按扁平数组取值会得到 `undefined`，于是 `set_config_option` 报 `Invalid params`。
极易误判成「这个 agent 不支持换模型」。必须递归展开，`describeModels()` 现在统一拍平。

mcode 的选项是扁平的，pi 的也是。

## 7. 模型值格式三家完全不同

| agent | 示例 |
| --- | --- |
| mcode | `m:minimax:MiniMax-M3:v:thinking` |
| dsh | `["deepseek-official","deepseek-v4-pro"]` |
| pi | `deepseek/deepseek-v4-pro` |

所以只透传不解析。任何"帮用户规范化模型名"的想法都会马上过时。

## 8. mcode 有一个模型选项自己带 bug

`m:minimax:MiniMax-M3.1-Flash-Preview:v:`（非 thinking 版）设置时返回
`Internal error`，其余 5 个选项正常。属于 harness 自身问题。

## 9. 模型持久化三家不一样

| agent | 进程重启后 |
| --- | --- |
| mcode | **保留** |
| dsh | **丢失**，回退默认 |
| pi | **丢失**，回退默认 |

所以模型选择必须在我们这边记一份并重新推送。验证脚本：
`npm run test:models`，输出 `MODELS ARE PER-SESSION AND SURVIVE RESTART`。

## 10. token 数只有 pi 能给

ACP 的 `usage_update` 只带上下文占用（`used` / `size`），有时带 `cost`，**没有 token 分解**。

试过 10 个候选方法：`session/stats`、`session/get_stats`、`session/usage`、`session/info`、
`session/inspect`、`mcode/session/usage`、`mcode/session/stats`、`session/metadata`、
`session/get_metadata`、`mcp/session/stats` —— 全部 Method not found。

pi 的 token 来自它 RPC 的 `get_session_stats`，由适配器取回附在 `usage_update` 上。

**结论**：如实输出 `not exposed by this agent`，不估算。TPS 同理，只在有真实 output
tokens 时计算。

## 11. 流式粒度完全取决于 agent

同一道题（写 12 行诗）：

| agent | chunks | 首个 chunk |
| --- | --- | --- |
| pi | 124~133 | 2.3~3.7s |
| mcode | 36 | 16.6s |
| dsh | **1** | 10.5s |

dsh 在思考阶段只发 `agent_thought_chunk`，正文只有最后一个 chunk。所以适配器把
thought chunk 也算作活动信号，否则 `tail` 会十几秒一片空白。

## 12. AGENTS.md 的加载范围不同

| agent | 自身 cwd | 父目录 |
| --- | --- | --- |
| pi | ✓ | **✓（会向上查找）** |
| mcode | ✓ | ✗ |
| dsh | ✓ | ✗ |

测试方法：父目录写 `RULE-MARKER-7788：回答最后一行写 BANANA-42`，问一句无关的话，
看回复有没有这个标记。

**后果**：规则文件对 mcode / dsh 必须放在它实际启动的那个目录，"放在上层目录一劳永逸"
对它们不成立。

另外一个副作用：规则一旦进入会话历史，**删掉文件也不会消失**——要开新会话才干净。
（调试时被这个坑过：清理了 AGENTS.md，回复里还带着 `BANANA-42`。）

## 13. ACP 一个连接一次只能跑一个 prompt

并发调用直接报：

```
Invalid params: A prompt is already active for this session.
```

必须串行。不同 agent 之间可以并行。

---

# 二、我们踩的坑

按"症状 → 根因 → 修法 → 教训"记。

## 1. stdin EOF 立刻退出，异步结果丢失

**症状**：用管道喂 JSON-RPC 时只回了 `initialize`，后面的调用全丢。

**根因**：`process.stdin.on('end')` 里直接 `process.exit(0)`。管道输入会在几条消息后
立刻 EOF，而此时 `mcode exec` 还在跑。

**修法**：用 `inflight` 计数跟踪未完成请求，EOF 时只标记，等计数归零再退出。

**教训**：stdio 服务不能把"输入结束"当成"工作结束"。

## 2. 并发调用被 ACP 拒绝

**症状**：三个并发 tool call，两个失败。

**根因**：见"harness 行为 13"。

**修法**：每个 agent 一条 promise 链做串行队列。注意 `streamedText` 这种共享可变状态
也必须由同一个队列保护，否则文本会串。

**教训**：把"一次只能一件事"建模成队列，而不是靠调用方自觉。

## 3. dsh 多会话活跃导致静默答错会话

**症状**：切回会话 A 失败，接着提问得到的却是 B 的内容。

**根因**：见"harness 行为 5"。错误被处理成"继续用当前 sessionId"，指针没变。

**修法**：维护 `live: Set`，命中时只换指针不调 resume；捕获 `already active` 视为成功。

**教训**：**静默的错误答案比报错危险得多**。凡是"操作失败但继续执行"的路径，都要重新
检查它后续依赖的状态是否还成立。

## 4. sidecar 并发写丢更新

**症状**（设计阶段就发现，未实际触发）：多个 MCP server 各自加载 `session-labels.json`，
改完整体覆盖写，后写的把先写的抹掉。

**根因**：多个进程共用一个文件，没有协调。

**修法**：daemon 成为唯一写者。这也是引入 daemon 的理由之一。

**教训**：只要状态存在磁盘上，就必须明确"谁是唯一写者"。

## 5. 相对路径在重构后失效

**症状**：pi agent 反复重启 14 次。

**根因**：`AcpClient` 从 `server/` 移到 `core/` 后，`join(dirname(import.meta.url), 'pi-acp-adapter.mjs')`
指向了不存在的位置。

**修法**：改成 `join(dirname(...), '..', 'server', 'pi-acp-adapter.mjs')`。

**教训**：移动文件时要重新检查所有基于 `import.meta.url` 的相对路径。启动失败的错误信息
也该更明确——当时只看到 spawns 飙升，日志里没有"文件不存在"。

## 6. 事件订阅晚于事件发生

**症状**：偶发整轮挂起，永远等不到结束。

**根因**：客户端先 `run()` 拿到 jobId，再 `subscribe()`。事件是即发即忘的广播，
如果任务在这两步之间结束，`done` 广播给 0 个订阅者。

**修法**：`run {subscribe: true}`，daemon 在开始运行前就把 socket 注册好。

**教训**：**发布/订阅的订阅动作必须发生在"可能发布"之前**。能放到服务端做就别放客户端。

## 7. 等事件没有超时

**症状**：和 6 一起造成永久挂起。

**根因**：`await new Promise(resolve => c.on('done', resolve))`，没有 `setTimeout`，
没有兜底。事件一丢就永远等。

**修法**：`waitFor(event, pred, timeout)`，超时后改用 `tail` 读取最终状态。

**教训**：**推送必须有对应的拉取兜底**。只依赖推送的等待，等于把可用性押在传输上。

## 8. 扩展里的 socket 让 pi 退不出去

**症状**：答案已经打印出来了，`pi -p` 进程却不退出。实测 wall 200 秒直到被 `timeout` 杀掉。

**根因**：从"MCP server 是独立进程"改成"扩展跑在 pi 里"之后，`net.Socket` 变成了 pi
自己事件循环里的一个 ref'd handle。只要它开着，node 就不会退出，而扩展从来没关过它。

**修法**：按监听器数量做引用计数——没人等的时候 `unref()`，有人等的时候 `ref()`。

**教训**：**进程内扩展要对宿主进程的退出负责**。任何长生命周期句柄都必须能被释放，
或者至少不能阻止退出。旧的"独立进程"架构天然没这个问题，换架构时要重新审视。

顺带一个诊断技巧：

```
看到输出但进程不走   → 保活 / 关闭问题
一直没输出卡住       → 事件丢失 / 无超时问题
```

## 9. 测试自己也有竞态

**症状**：`stream-test` 稳定失败。

**根因**：先轮询两次 `tail`，之后才注册 `done` 监听。任务在轮询期间结束，事件早丢了。

**修法**：客户端加"最近 100 条事件"的环形缓冲，`waitFor` 先查缓冲再挂监听。

**教训**：**测试代码和产品代码会犯同一个错误**。修了产品里的竞态，要回头看看测试是不是
同款写法。

## 10. 事件改名打断所有消费方

**症状**：改完事件层，测试全部超时。

**根因**：`done` 改名为 `job.done`，但 scheduler / 扩展 / 两个测试还在等旧名字。

**修法**：同步更新所有消费方。

**教训**：事件名是**契约**。改它等于改 API，要么加版本，要么一次改全。

## 11. 事件重构悄悄让系统事件不再广播

**症状**：`health-test` 收不到 `agent.exit`。

**根因**：新的投递逻辑只发给"该 job 的订阅者"，而 `agent.exit` 没有 jobId，等于发给空集合。

**修法**：无 jobId 的事件视为系统事件，发给所有连接。

**教训**：重构投递规则时，要为每种事件列一遍"谁会收到"，而不是只测主路径。

## 12. 首次运行误报「进程重启」

**症状**：第一次运行的健康检查报 `agent_restarted`（error）。

**根因**：`spawnsAtStart` 在 `_beginRun` 时记录，但首次运行本来就要 spawn。

**修法**：把记录点移到 `ensureReady` 之后——只有那之后的 spawn 才算异常。

**教训**：基线要在"准备好"之后取，不能在"准备开始"时取。

## 13. 失败回执丢掉了指标

**症状**：运行中被杀，回执里 `durationMs: null`、`health: "ok"`、`attention: []`。

**根因**：失败的路径是 `catch` → 重新抛错，而计算指标是在 `finally` 之后的正常路径里；
daemon 只能凭空造一个 `{error}` 的最小 metrics。

**修法**：在 catch 里把 `_finishRun()` 的结果挂到 error 对象上（`err.metrics`），
daemon 取用。

**教训**：**失败路径也要产出完整观测数据**，否则最需要诊断的时候恰好什么都没有。

## 14. 读取指标污染了基线

**症状**：`agent_status` 每次调用都会往耗时历史里塞一条。

**根因**：`_metrics()` 里做了副作用（push durationHistory），而 `status()` 和 `tail()`
都会调它。

**修法**：副作用移到 `_finishRun()`，只在运行结束时写一次。

**教训**：**取名 `_metrics` 的纯计算函数不应该有副作用**。读接口尤其要保证幂等。

## 15. 取消时误报「没有输出」

**症状**：取消的运行同时报 `cancelled` 和 `empty_output`。

**根因**：取消本来就不会有输出，两条 attention 是重复描述同一个事实。

**修法**：`stopReason === 'cancelled'` 时跳过 `empty_output`。

**教训**：多条健康信号之间要考虑互斥关系，否则一条真实问题会被两条噪音淹没。

## 16. 多个 shell 各拉起一个 daemon

**症状**（预判，已在设计上避免）：客户端各自从环境变量决定连接地址，A 终端连管道、
B 终端设了 `AGENTD_PORT` 连 TCP，于是出现两个 daemon，两套 agent。

**修法**：daemon 启动后把实际地址写进 `data/agentd.endpoint.json`，所有客户端先读它。

**教训**：**单例服务要有唯一的发现机制**，不能靠每个客户端的环境变量碰运气。

## 17. 在 WSL 里操作，误以为项目依赖 WSL

**症状**：文档里堆满 `/mnt/d/...` 和 `exec: node: not found` 之类的说明。

**根因**：操作终端在 WSL 里，而 agent 栈其实是原生 Windows 的。对照实验证明：从 WSL 和
从 PowerShell 启动的 Windows 子进程拿到完全一致的环境（`platform=win32`、
`USERPROFILE=C:\Users\wowww`、`HOME=null`、无 `WSL_INTEROP`）。

**修法**：文档和脚本改成 Windows 原生，用 `npm run` 而不是写死解释器路径。

**教训**：**区分"我是怎么敲命令的"和"系统实际怎么跑"**。开发环境的偶然性很容易被误写成
架构约束。

## 18. MCP 那层的教训（已废弃，但值得记）

- MCP 的 `notifications/progress` **只用于重置超时，不会把内容给模型**。所以"MCP 流式"
  只能靠"异步 + 轮询"，体验远不如扩展的 `onUpdate`。
- `onUpdate` 的中间更新不进转录，**不占 context**——这是扩展相对 MCP 的实质优势。
- 早期为了省事给每个会话起一套 MCP server，代价是多窗口内存翻倍。这个问题最终由 daemon
  解决，而不是靠修 MCP 层。

## 19. 调度器 pi 起不来：扩展里的换行被展开

**症状**：`dispatcher pi exited`，退出码 1，客户端只看到一句 "dispatcher pi exited"。

**根因**：扩展里模板字符串的 `\n` 在生成文件时变成了真换行，pi 加载扩展时报
`ParseError: Unterminated string constant`。这个错只在 pi 的 stderr 里。

**修法**：改回转义；并在 dispatcher 里保留 stderr 尾部（`stderrTail`）用于排查。排查时直接手动跑
`pi --mode rpc -e <扩展>`，stderr 一眼可见。

**教训**：**进程起不来时，先在命令行里手跑一遍**，不要只看包装层的报错。

## 20. 内置实例会列出自建实例的会话

**症状**：同一个 CLI 的两个实例，内置那个的会话列表里能看到自建实例的会话。

**根因**：agent 的 `session/list` 返回该 CLI 的全部会话，只有自建实例按目录过滤，内置实例没有。

**修法**：内置实例排除落在同类型自建实例目录下的会话。

**教训**：**「过滤」要对称**：一边按范围收窄，另一边也要排除对方的范围。

## 21. pi 的会话文件是惰性创建的

**现象**：`get_state` 已经给出 `sessionFile`，但磁盘上还没有这个文件，要等第一条消息才写入。
所以「列会话」时刚开的会话不在列表里，测试也不能在发 prompt 之前断言它存在。

## 22. 并行的单位是实例，不是会话（项目层实验）

- **dsh**：一个进程内可同时跑多个会话，prompt 能重叠。
- **pi 适配器**：同一时刻只有一个活跃会话，要并行必须多开实例。
- **mcode**：本环境模型路由报错（`managed_token_plan` 不可用），没能测，属环境问题。

所以统一按「一个实例一个 prompt」调度，并行靠多实例；探针在 `tools/concurrency-probe.mjs`。

## 23. 作用域要在服务端强制

调度器的 LLM 可能写出别的项目的实例名。靠提示词约束不可靠，所以 daemon 对带 `project` 的调用统一改写 agent 名、
把 `cwd` 限定在根目录内，并拒绝含分隔符 `~` 的名字——**能力边界放在入口，不放在模型的自觉里**。

---

# 三、可复用的判断

从上面这些坑里提炼出来的、以后写类似系统还会用到的几条：

1. **协议是稳定契约，内部实现不是。** 能靠协议解决就别 reverse-engineer；
   我们唯一一次读别人源码（grep mcode 的 chunks）只是为了查一个参数形状。
2. **推送必须有拉取兜底。** 事件丢失是常态，不是异常。
3. **订阅早于发布。** 能服务端做就别客户端做。
4. **状态要有唯一写者。** 否则迟早丢更新。
5. **失败路径也要有完整观测。** 最需要诊断的时候不能什么都没有。
6. **静默的错误比报错危险。** 操作失败后继续执行，必须重新验证依赖的状态。
7. **每个健康信号都要能追溯到具体数据。** 推断而不是猜测。
8. **换架构时重新审视所有隐式契约。** 进程隔离 → 同进程，socket 的语义完全变了。
9. **测量的要归因到具体环节。** "慢"要拆成外层模型 / agent / 调度器三段分别计时，
   否则会去优化错的地方（实测调度器只占 0~1ms）。
