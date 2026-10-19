# pi agent router

在一台机器上调度多个 CLI agent，从 pi 里用自然语言调用。

```
pi  ──扩展──►  agentd（常驻单例）  ──ACP──►  mcode / dsh / pi
```

| agent | 是什么 | 启动目录 |
| --- | --- | --- |
| `mcode` | MiniMax Code | 由 `agentd.config.json` 决定 |
| `dsh` | DeepSeek Harness | 由 `agentd.config.json` 决定 |
| `pi` | 另一个 pi 实例 | 基准目录 |

架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，踩过的坑和实测数据见 [LESSONS.md](LESSONS.md)。

---

## 安装

把扩展挂到 pi 上，二选一：

```powershell
# 项目级（需要项目信任）
#   <project>/.pi/extensions/agent-router.ts 内容：
#   export { default } from "../../speclock2/extension/agent-router.ts";

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

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
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

### 团队规则文件

`contexts/base.md` 是 `AGENTS.md` 的模板，**需要你自己复制**到 agent 的工作目录。

调度器不会自动写入——这是设计选择，见 [ARCHITECTURE.md#设计守则](ARCHITECTURE.md#设计守则)。

注意加载范围不同：

| agent | 自身 cwd | 父目录 |
| --- | --- | --- |
| pi | ✓ | ✓ |
| mcode | ✓ | ✗ |
| dsh | ✓ | ✗ |

所以对 mcode / dsh，文件必须放在**它实际启动的那个目录**。

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
- pi agent 的 cwd 在进程启动时固定，改它要重启 daemon
- 切过的会话会一直留在进程内存里（没有调用 `session/close`）
