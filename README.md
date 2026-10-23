# pi agent router

在一台机器上调度多个 CLI agent，从 pi 里用自然语言调用。

```
pi  ──扩展──►  agentd（常驻单例）  ──ACP──►  mcode / dsh / opencode / claude / codex / pi
```

| agent | 是什么 | 怎么接入 | 版本（实测） | 启动目录 |
| --- | --- | --- | --- | --- |
| `mcode` | MiniMax Code | 原生 ACP | `@minimax-ai/code` 0.6.12 | 由 `agentd.config.json` 决定 |
| `dsh` | DeepSeek Harness | 原生 ACP | `@deepseek-ai/dsh` 0.1.5-rc.2 | 由 `agentd.config.json` 决定 |
| `opencode` | OpenCode | 原生 ACP（`opencode acp`） | `opencode-ai` 1.19.1 | 由 `agentd.config.json` 决定 |
| `claude` | Claude Code | 官方适配器 | `@agentclientprotocol/claude-agent-acp` 0.94.0 + `@anthropic-ai/claude-code` 2.1.295 | 由 `agentd.config.json` 决定 |
| `codex` | Codex | 官方适配器 | `@agentclientprotocol/codex-acp` 2.2.2（依赖 `@openai/codex` 0.160.1；本机另装的 codex-cli 为 0.163.0） | 由 `agentd.config.json` 决定 |
| `pi` | 另一个 pi 实例 | 自带适配器 `server/pi-acp-adapter.mjs`（走 pi 的 RPC） | `@earendil-works/pi-coding-agent` 1.3.0 | 基准目录 |

版本是 2026-10-23 在本机（Windows 11、Node v24.19.0）实测时安装的，升级后行为可能不同。
claude 的接口地址、模型和密钥读取你自己的 `~/.claude/settings.json`（cc-switch 切换后，下次启动进程时生效）。

### 各 CLI 能看到什么（实测）

一个执行者干活时，界面上能看到它的哪些内部过程。方法：每种 CLI 各让它用工具创建一个文件，读它的会话记录
（`node packages/agentd/tools/executors-activity-probe.mjs`，会调用真实模型）。

| CLI | 工具调用 | 输入 | 输出 | 思考过程 |
| --- | --- | --- | --- | --- |
| mcode | ✓ | 没有 | ✓ | 这次没有 |
| dsh | ✓ | ✓ | ✓ | ✓ |
| opencode | ✓ | ✓ | ✓ | 这次没有 |
| claude | ✓ | ✓ | ✓ | ✓ |
| codex | ✓ | ✓ | 只有退出码 | 这次没有 |
| pi | ✓ | ✓ | ✓ | ✓ |

- **mcode** 的协议不提供工具的输入，只有标题和输出。
- **codex** 的命令在终端里执行，输出不经过协议，只能拿到退出码。
- **思考过程**取决于模型有没有输出推理；任务很简单时有的模型不写，所以「这次没有」不等于「不支持」。
- opencode、claude 的参数和可读标题在工具开始之后的更新里才给，agentd 会把这些更新合并起来再写进记录。
- 只有这些改动之后的运行才有这些详情，旧的运行记录里没有。

### 给 agent 的规则怎么交进去（实测）

规则（执行者能做什么、不能做什么、怎么汇报）不写进你的项目，不碰项目自己的 `AGENTS.md` / `CLAUDE.md`，
而是启动进程或开会话时，通过各个 CLI 自己的「额外系统提示」入口交给它。规则文本放在 agentd 自己的 `data/rules/` 下。
探针：`node packages/agentd/tools/system-prompt-probe.mjs`（给每种 CLI 一条「每次回复结尾加暗号」的规则，
在空目录里问两次：新会话一次，进程停掉再恢复会话一次）。

| CLI | 入口 | 新会话 | 恢复会话后 | 项目里留下的文件 |
| --- | --- | --- | --- | --- |
| mcode | `mcode acp --append-system-prompt-file <文件>` | ✓ | ✓ | 0 |
| pi | `--append-system-prompt <文件>`（适配器加到 pi 命令行） | ✓ | ✓ | 0 |
| claude | `session/new` 的 `_meta.systemPrompt.append` | ✓ | ✓ | 0 |
| codex | `session/new` 的 `_meta.jetbrains.air.customInstructions` | ✓ | ✓ | 0 |
| opencode | 环境变量 `OPENCODE_CONFIG_CONTENT` 里的 `instructions` | ✓ | ✓ | 0 |
| dsh | 没有入口：规则放在每个会话第一条消息前面（压缩后再补一次） | ✓ | ✓ | 0 |

这只验证了「规则能送到、重启后还在」，用的是一条很简单的规则；复杂规则（比如「不要 git push」）遵不遵守，
取决于模型，而且规则始终是提示词层面的约束，不是强制。

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，踩过的坑和实测数据见 [LESSONS.md](LESSONS.md)。

## 仓库结构（npm workspaces）

| 包 | 作用 |
| --- | --- |
| `packages/agentd` | 调度器：daemon、agent 池、pi 扩展、调度器 pi、测试。以下大部分内容都在讲它 |
| `packages/backend` | 薄网关：HTTP + SSE，每个路由对应 agentd 的一个操作，自己不存状态 |
| `packages/web` | 看板：React + TypeScript + Vite（Tailwind、Radix/shadcn 风格组件、TanStack Query、Zustand）；开发服务器把 `/api` 代理到 backend，`npm run build -w @speclock/web` 构建 |

```powershell
npm install            # 仅用于建立 workspace 链接，没有第三方依赖
npm run backend        # http://127.0.0.1:8787（`BACKEND_PORT` 可改），首次请求时自动拉起 agentd
npm run web            # http://127.0.0.1:5234，打开这个（环境变量 `WEB_PORT` 可改）
npm test               # agentd 全部回归
npm test -w @speclock/backend   # 网关测试
```

backend 只监听 `127.0.0.1`，并拒绝非本机的 Host / 跨站 Origin：它能运行 agent、改 pi 的 `models.json`，不要对外暴露。
命令中的路径（`tools/`、`data/`、`agentd.config.json` 等）都相对 `packages/agentd`。

---

## 安装

把扩展挂到 pi 上，二选一：

```powershell
# 项目级（需要项目信任）
#   <project>/.pi/extensions/agent-router.ts 内容：
#   export { default } from "../../speclock2/packages/agentd/extension/agent-router.ts";

# 用户级（所有项目生效）
copy speclock2\extension\agent-router.ts $env:USERPROFILE\.pi\agent\extensions\
```

启动 pi 即可。daemon 由客户端按需拉起，不需要手动起服务。

前置条件：`node` 在 PATH 上；mcode / dsh / pi 三个 CLI 已安装并能独立运行。

---

## 怎么用

直接用自然语言，不需要提工具名：

```
让 mcode 看一下这个文件有没有问题
用 dsh 解释一下这段代码
分别问一下 mcode 和 dsh：1 加 1 等于几，然后比较耗时
开个新会话，然后问 mcode 这个项目用了什么框架
切回刚才那个会话，继续问 dsh
把 mcode 的模型换成 M3，再问一遍
```

pi 会自己决定调哪个工具、哪个 agent。你也可以显式说：

```
用 agent_run 问 dsh：……（agent=dsh）
```

### 斜杠命令

```
/agents        选 agent → 选会话 → 切换
/agent-model   选模型
/agent-usage   看上次运行的指标
```

> 交互式 UI，只在真 TUI 里可用，`pi -p` 下没有。

---

## 工具

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `agent_run` | 发 prompt 给某个 agent | `agent`、`prompt`、`sessionId`、`model`、`reset`、`timeout` |
| `agent_sessions` | 列会话（标签 / 标题 / cwd / 时间），`*` 标活跃 | `agent`、`limit` |
| `agent_use` | 切到已有会话 | `sessionId`、`agent` |
| `agent_new` | 开新会话 | `agent`、`cwd` |
| `agent_rename` | 给会话设本地标签 | `label`、`sessionId` |
| `agent_models` | 列模型 / 推理强度 / 权限选项 | `agent`、`sessionId` |
| `agent_set_model` | 为会话设模型 | `value`、`configId` |
| `agent_status` | 存活、健康、会话、模型、spawns、pid、cwd | `agent` |
| `agent_instances` | 列出所有实例（内置 + 自建）及可创建的类型 | — |
| `agent_instance_create` | 为同一个 CLI 再建一个实例，绑定自己的目录 | `id`、`type`、`cwd` |

`agent` 参数现在是**实例 id**：内置实例的 id 就是类型名（`mcode`、`dsh`、`pi`），自建实例用自己的 id。

几个约定：

- **会话是延续的**：不加 `reset` 就接着上次聊。要干净起一轮，说「开个新会话」。
- **模型是会话级的**：每个会话独立，切换后下一轮生效。
- **标签只在本地**：agent 自己没有 rename 接口，所以标签存在 `data/session-labels.json`，在 agent 自己的界面里看不到。
- **流式进度**：长任务运行时 TUI 会显示 `mcode: 123 chars · 4.2s`。
- **中断**：Ctrl+C 会触发 `session/cancel`。

### 返回的指标

```
model:       DeepSeek V4.1 Flash
duration:    4589ms   first token: 3668ms
tokens:      in 2441 / out 147 / cache-read 0 / total 2588
tps:         32 tok/s (output)
throughput:  108.7 chars/s, 499 chars in 124 chunks
context:     2588 / 1000000 (0.3%)
cost:        0.000909 USD
log:         data/runs/pi-xxx.log
```

`tokens` 只有 pi agent 能给——mcode 和 dsh 的协议不暴露 token 数，会如实显示
`not exposed by this agent`。

---

## 配置

### 每个 agent 的启动目录

`agentd.config.json`：

```json
{
  "agents": {
    "mcode": { "cwd": "D:/work/project-a" },
    "dsh":   { "cwd": "D:/work/project-b" }
  }
}
```

优先级：请求里的 `cwd` > `AGENTD_CWD_MCODE` / `AGENTD_CWD_DSH` / `AGENTD_CWD_PI` > 配置文件 > 基准目录。

目录不存在会自动创建。改配置后需要重启 daemon（`npm run daemon:stop`，下次调用自动拉起）。

调度器 pi（见下）的启动目录用 `"dispatcher": { "cwd": "..." }`，也可用 `AGENTD_CWD_DISPATCHER`。

### 多实例：同一个 CLI 跑多份

一个 CLI 类型可以有多个实例，每个实例是独立进程、固定在自己的目录里，会话列表互不混。
实例记录在 `data/instances.json`，重启 daemon 后自动恢复。

```
agentd 操作：instances | instance.create {id,type,cwd} | instance.remove {id}
```

- id 以字母开头，只含 `a-z 0-9 - _`，最长 32；不能和已有实例重名
- 内置实例不能删除；内置实例的会话列表不包含自建实例目录下的会话

### 对话记录

agentd 把它经手的每一轮对话记在 `data/transcripts/<实例>/<sessionId>.jsonl`（user / assistant 两类条目，
带递增 `seq`、`jobId`、`stopReason`），看板读它即可，不必向 agent 要历史。

```
agentd 操作：transcript {agent, sessionId?, afterSeq?, limit?, tail?}
```

不传 `sessionId` 取活跃会话；`afterSeq` 用来增量拉取；agentd 没经手过的会话返回 `recorded:false`。

### 调度器：由 pi（及其 LLM）决定调哪个 agent

调度器是 agentd 持有的一个 `pi --mode rpc` 进程，加载了 agent-router 扩展，由它的 LLM（例如 DeepSeek）
读用户请求并调用 `agent_run` 等工具。注意它和池里的 `pi` agent 不是一回事：后者带 `--no-extensions`，只是执行者。

| 操作 | 作用 |
| --- | --- |
| `dispatcher.state` / `models` / `setModel {value}` / `setThinking {level}` | 状态、可用模型、切换模型（`provider/modelId`） |
| `dispatcher.prompt {message}` / `abort` | 发请求 / 中断；进度以 `dispatcher.event` 推给订阅 `*` 的连接 |
| `dispatcher.new` / `sessions` / `use {sessionFile}` / `messages` | 会话管理与历史（历史由 pi 自己保存） |
| `dispatcher.customModels` / `addModel` / `removeModel` | 增删 pi 的 LLM（写 `models.json`，然后重启调度器） |
| `dispatcher.restart` | 重启调度器进程，会话自动恢复 |

添加 LLM 示例（参数名与 pi 的 `models.json` 一致）：

```json
{ "provider": "my-llm", "baseUrl": "https://example.com/v1", "apiKey": "$MY_LLM_KEY",
  "models": [{ "id": "my-model", "name": "My Model", "reasoning": false }] }
```

- `apiKey` 写环境变量引用（`$NAME`）或字面值；以 `!` 开头会被拒绝（pi 会把它当 shell 命令执行）
- 文件在 `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）下，写入前备份为 `models.json.bak`
- 调度器正在处理请求时拒绝修改，先 `dispatcher.abort`

### 项目：配置单元

项目 = 一个根目录 + 一个调度器（pi，cwd 就是根目录）+ 一组实例（`id`、`type`、相对根目录的 `dir`、`role`）。
实例只属于一个项目、不共享，池里的键是 `<项目>~<实例>`；不同项目可以有同名实例，各自是独立进程。
配置存在 `data/projects.json`，重启 daemon 后恢复。

- **切项目只是切视图**：其它项目的进程继续跑，不卸载。
- **没有「全局」视图**：看板里一切都挂在项目下；空闲回收对所有实例生效（含项目外的内置实例）。
- **懒启动**：创建实例只写配置，第一次用才拉起进程；空闲超过 `limits.idleMinutes`（默认 15）自动回收，下次用到再起。
- **启动重试**：执行者进程启动时退出（如 mcode 偶发起不来），最多重试 3 次（间隔递增）；同一种 CLI 的启动串行化（并发启动 mcode 会互相打架）；最终失败的错误带上进程 stderr 末尾几行，界面上显示「启动失败：…」，下次使用会重新尝试。
- **进程总数上限** `limits.maxProcesses`（默认 12，或 `AGENTD_MAX_PROCESSES`），超了拒绝拉起。
- **隔离**：`dir` 必须落在根目录内（拒绝 `..`、根外绝对路径、指向根外的符号链接/junction）。
  项目调度器的所有工具调用都被限定在本项目内（环境变量 `AGENTD_PROJECT`，daemon 端改写 agent 名并拒绝含 `~` 的名字）。
- **创建实例时可选模型和会话**：`model`（不填则用 `agentd.config.json` 的 `defaultModels.<类型>`，mcode 默认 M3）；`sessionId` 填已有会话即接着用，不填或 `new` 就在首次使用时新建。
  实例会记住最后用的会话，进程被回收或 daemon 重启后回到同一个会话。可选项由 `project.models {type}` 和 `project.sessions {project,type,dir}` 提供（用临时进程探测，已被别的实例占用的会话不会列出）。
- **设置抽屉**：看板主界面只放对话；每个成员（调度器、执行者）右上的「设置」里改用途、模型、会话（切换/新建）。
  对应操作 `project.updateInstance {project,id,role?,model?}`、`use`/`new`（执行者会话）、`dispatcher.use`/`new`/`sessions`（调度器会话，带标题）。
  调度器重启后回到最新的会话。
- **角色**：`role` 是给调度器看的用途说明（`agent_instances` 会列出）。没写则取 `agentd.config.json` 的 `roles.<类型>`。
- **确认**：关闭/删除项目、删除实例时若还有任务在跑，会返回 `still running: …`，带 `force` 重发才会中断它们（看板会弹确认）。
- 调度器模型列表只显示有凭据的模型（`auth.json`、`models.json` 里带 apiKey 的 provider、`<NAME>_API_KEY` 环境变量）。

```
agentd 操作：projects | project.create {id,name?,root,instances?} | project.addInstance {project,id,type,dir,role?}
            project.removeInstance {project,id,force?} | project.stop {project,force?} | project.remove {project,force?}
            agents/instances/dispatcher.* 均可带 {project}；带 {project, short:true} 时名字不带前缀
```

协议版本 3。后端对应 `/api/projects…`，调度器路由加 `?project=<id>`。

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `AGENTD_CWD_DISPATCHER` | 基准目录 | 调度器 pi 的工作目录 |
| `PI_CLI` / `PI_NODE_BIN` | 本机安装路径 | 调度器启动 pi 用的入口 / node |
| `DISPATCHER_SESSION_DIR` | `./data/dispatcher-sessions` | 调度器会话文件目录 |
| `AGENTD_BASE_CWD` | `D:/Project2/.../speclock2` | 没配置时的默认工作区 |
| `AGENTD_CWD_<AGENT>` | — | 覆盖某个 agent 的目录 |
| `AGENTD_DEFAULT_AGENT` | `mcode` | 不指定 agent 时的默认值 |
| `AGENTD_PIPE` | `\\.\pipe\pi-agentd` | 命名管道地址 |
| `AGENTD_PORT` | — | 改用 TCP `127.0.0.1:<port>` |
| `AGENTD_IDLE_MIN` | `30` | 空闲多少分钟自动退出 |
| `AGENTD_CONFIG` | `./agentd.config.json` | 配置文件位置 |
| `AGENTD_LABELS_FILE` | `./data/session-labels.json` | 标签文件位置 |
| `AGENTD_RUNS_DIR` | `./data/runs` | 运行日志目录 |
| `MCODE_NODE_BIN` | `D:/Environment/nodejs/node.exe` | node 可执行文件 |

### 团队规则

调度器和执行者各有一段规则（能做什么、不能做什么、怎么汇报），来源是 `packages/agentd/contexts/project.md`（项目的调度器）和
`contexts/executor.md`（每个执行者）。它们在启动进程或开会话时，通过各个 CLI 自己的「额外系统提示」入口交给 agent，
**不写进你的项目**，项目自己的 `AGENTS.md` / `CLAUDE.md` 也不会被碰，两边同时生效。入口见上面的表。

- 改这两个文件后重启 daemon；已经在跑的进程要等下次启动才会拿到新规则（dsh 是新会话的第一条消息）。
- 项目里不再生成 `AGENTS.md`、`CLAUDE.md` 或技能目录。以前版本生成的文件（第一行有 `speclock:managed` 标记）还在，
  不影响使用，想清理可以自己删。
- 交接不再用技能文件：执行者直接把交接文档作为回复交出来，agentd 保存副本在 `data/handoffs/`，项目里不留文件。

---

## 运维

```powershell
npm test              # 七组回归
npm run test:events   # 事件 id / 重放 / 重启检测
npm run test:switch   # 会话切换 + 标签
npm run test:models   # 模型隔离 + 跨重启持久化
npm run test:health   # 健康信号 + 回执 + 崩溃恢复
npm run test:stream   # 流式 + 指标
npm run test:daemon   # 单 daemon / 单套 agent
npm run test:cwd      # 每个 agent 的启动目录
npm run test:models-json  # models.json 编辑器（纯单元，不调 LLM）
npm run test:instances    # 多实例
npm run test:transcript   # 对话记录
npm run test:dispatcher   # 调度器（加 -- --prompt 会真的调一次 LLM）
npm run bench         # 切换开销基准

npm run daemon        # 前台启动（调试用）
npm run daemon:log    # 跟踪日志
npm run daemon:stop   # 停掉
```

### 状态文件

都在 `data/`，可以安全删除（除了 `session-labels.json` 会丢标签）：

| 文件 | 内容 |
| --- | --- |
| `agentd.endpoint.json` | daemon 实际监听地址，跨 shell 共享的关键 |
| `agentd.log` | daemon 日志 |
| `session-labels.json` | 会话标签 + 模型选择 |
| `receipts.jsonl` | 每次运行的回执，追加式 |
| `runs/<jobId>.log` | 单次运行的流式正文 |
| `pi-sessions/` | pi agent 自己的会话文件 |
| `instances.json` | 自建实例（id / 类型 / 目录） |
| `transcripts/` | 按实例、会话分文件的对话记录 |
| `dispatcher-sessions/` | 调度器 pi 的会话文件 |

### 排查

| 现象 | 先看 |
| --- | --- |
| 调用没反应 | `data/agentd.log` |
| 回答很慢 | 用 `agent_status` 看是 agent 慢还是外层模型慢 |
| agent 反复重启 | `spawns` 是否持续增长；看 `agent.exit` 事件 |
| 上下文快满 | 回执里的 `attention` 有 `context_pressure` |
| 切不过去会话 | 会话 id 和 cwd 都要对；跨进程恢复必须带 cwd |
| 修改配置不生效 | 重启 daemon |

---

## 范围

**做**：进程寿命、会话路由、模型选择、健康观测、运行回执。

**不做**：执行、上下文管理、工具调用、修改 agent 的输入或工作区。

## 已知限制

- 同一个 agent 内串行：ACP 一个连接一次只能跑一个 prompt；不同 agent 可并行
- 流式粒度取决于 agent：dsh 只发 1 个 chunk（整段返回）
- mcode / dsh 不暴露 token 数
- 会话标签只在本地，agent 自己的界面看不到
- 对话记录只含经 agentd 的轮次；在 agentd 之外直接用 CLI 产生的会话没有记录
- 新增 LLM 要重启调度器 pi 才生效（agentd 自动做，但会打断空闲前的进程内状态）
- 协议版本为 2；旧版 daemon 需先 `npm run daemon:stop`
- pi agent 的 cwd 在进程启动时固定，改它要重启 daemon
- 切过的会话会一直留在进程内存里（没有调用 `session/close`）
