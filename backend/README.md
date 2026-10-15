# SpecLock 2 后端（M1 · S0~S2 + R-M2 接入轮）

技术栈：Python 3.11+ / FastAPI / SQLAlchemy 2 / SQLite / pytest；核心代理宿主 pi 1.2.0（Node ≥ 22）。

已交付切片：

- **S0 骨架**：应用工厂、全局注册表、每项目独立账本（16 张表）、S0 端点、统一错误 envelope；
- **S1 文档系统**：草稿校验（apis 递归 / rules 稳定 id 分配永不复用）、逐条错误定位；
- **S2 M1 收尾整包**：卡片起草/批准/打回 → 版本快照（semver）→ 轮次推进 → 事件链（append-only，增量回放）→ 任务包双入口（批准卡片 / 技术任务单）→ 任务状态机（dispatch/receipt/audit + 看门狗超时）→ 全局约定 → 统计聚合。

M1 全程无 AI 参与：卡片、派发、回执、审计均由人工经这些端点模拟。

## 环境

- Windows 10/11 + Git Bash
- Python 3.11 及以上（开发机实测 3.12.9 可用）：`python --version` 确认

## 从零安装

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate     # Git Bash；PowerShell 用 .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 运行

在 `backend/` 目录、虚拟环境已激活的状态下：

```bash
python run.py
# 等价：uvicorn speclock2.app:create_app --factory --host 127.0.0.1 --port 8000
```

验证：

```bash
curl http://127.0.0.1:8000/api/health
# {"ok":true}
```

## 测试

```bash
pytest
```

测试通过环境变量 `SPECLOCK2_DATA_DIR` 把数据写入 pytest 临时目录，每个用例独立、互不污染。

## 开发约定（自测纪律）

- **禁止对真实项目账本（如 mctest / fe-selftest / a）发任何自测请求。**
  自测数据会污染用户现场：2026-10-15 曾对真实账本 curl 未提交版本的批量验收，
  把从未派发的任务扫成 done（幽灵完成）。
- 自测一律二选一：
  1. `SPECLOCK2_DATA_DIR=<临时目录>` 起独立实例（配 `sl2-fake` 替身 harness 即可全链自测）；
  2. 直接跑 `pytest`（每个用例自动用独立临时数据目录）。

## 草稿校验（S1 起）

PUT 草稿时 `rules` 与 `apis` 在落库前整体校验，任一条非法则整次 PUT 拒绝（422，草稿保持原样），`details.errors` 逐条定位字段路径（如 `"apis[0].response[0].children[0].children"`）：

- **rules**：每条 `{id?, name, detail}`，name/detail 非空。无 id 条目由服务端分配稳定 id（`R` + 模块内单调递增计数器，**永不复用**：已删除的 id 不会再分配、也不可再引用，引用不存在的 id → 422）；带 id 条目按 id 匹配当前草稿更新；GET 回读的 rules 总是带 id；
- **apis**：`api` 形如 `"METHOD /path"`（METHOD 大写且属于 GET/POST/PUT/PATCH/DELETE，path 以 `/` 开头）、`desc` 非空、name 非空；字段（request/response 递归 children）校验 name 非空、type ∈ {string, number, integer, boolean, array, object}、children 仅允许挂在 object/array 下（array 的 children 描述元素结构）；模块内 method+path 唯一。

## 核心代理接入（R-M2）

架构（DESIGN.md §13）：`backend/speclock2/pi_runtime.py` 经 **pi RPC 模式**（stdin/stdout JSONL，严格 LF 二进制分帧，回合完成判据 `agent_settled`）驱动每项目一个常驻核心代理子进程；扩展 `chief/extension/index.ts`（jiti 加载）注册 `draft_card` / `create_task` / `dispatch` / `workbench_report` 四工具（create_task 带 prompt 一步建单+派发；dispatch 404/skip 均给纠偏回路，修复单 17/19）；宪法 `chief/constitution.md` 经 `--append-system-prompt` 注入。

### 安装与配置

```bash
npm i -g @earendil-works/pi-coding-agent@1.2.0   # 锁版本；pi --version 确认
```

环境变量：

| 变量 | 说明 |
|------|------|
| `SPECLOCK2_CHIEF_MOCK=1` | **降级开关**：无 provider key 时核心代理走本地模拟（含工具效果），全流程可自测 |
| `SPECLOCK2_CHIEF_PROVIDER` / `SPECLOCK2_CHIEF_MODEL` | 核心代理真模型（如 `minimax-cn` / `MiniMax-M3`）；对应 provider 的 API key 按 pi 的环境变量约定设置（如 `MINIMAX_CN_API_KEY`） |
| `SPECLOCK2_MASTER_MODEL` | 主代理模型（被派发的 pi 用）；缺省沿用核心代理配置 |
| `SPECLOCK2_PI_CMD` | 覆盖 pi 启动命令（默认自动解析 `npm root -g` 下的 node + cli.js） |

**两级代理都可直接配置**：核心代理在工作台内部经 RPC 请求（上面的 env）；主代理在派发时直接唤醒对应 CLI——`data/harness-map.json` 的 `masters` 决定每个主代理用哪个 harness。配置了真模型时默认映射自动把 backend/frontend 指向真 pi（继承 provider key 与 `SPECLOCK2_MASTER_MODEL`），未配置时落到零依赖替身 `sl2-fake`（无 key 开箱可测）。技术任务单支持可选 `master` 字段（默认 `backend`）指定执行主体。

### harness 映射（`data/harness-map.json`，首次自动生成）

```jsonc
{
  "watchdog_minutes_default": 60,
  "masters":   {"backend": "sl2-fake", "frontend": "sl2-fake"},   // 装了真 CLI 后改指 pi/claude-code/codex
  "harnesses": {
    "sl2-fake":    {"command": "<python>", "args": ["<backend>/scripts/fake_harness.py"], "prompt_mode": "arg"},
    "pi":          {"command": "node", "args": ["<cli.js>", "--mode", "json", "-p", "{prompt}", "--no-session"], "prompt_mode": "inline"},
    "claude-code": {"command": "claude", "args": ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"], "prompt_mode": "inline"},
    "codex":       {"command": "codex", "args": ["exec", "--json", "{prompt}"], "prompt_mode": "inline"}
  }
}
```

`sl2-fake` 是被派发 harness 替身（模拟 pi 的 NDJSON 输出、真实写文件、支持 `--sleep/--fail`），无 key 自测用。`prompt_mode=arg` 追加尾参、`inline` 替换 `{prompt}` 占位符（不经 shell，防注入）。

### R-M2 自检（mock 模式全流程）

```bash
SPECLOCK2_CHIEF_MOCK=1 python run.py     # 另开 Git Bash：
BASE=http://127.0.0.1:8000
# A：对话与起草
curl -s -N $BASE/api/p/a/chat/stream &                  # SSE：ready/message_delta/message_final/card_proposed
curl -s -X POST $BASE/api/p/a/chat -H "Content-Type: application/json" \
  -d '{"message":"我需要导出支持 Excel"}'                # {"ok":true,"reply":"收到需求：..."}
curl -s $BASE/api/p/a/agent                              # {"running":true,"model":"mock","context_usage_percent":0,...}
#   含 draft 的起草（中文 JSON 走 UTF-8 文件 --data-binary @file，做法同 M1 自检）
#   → 卡片出现在 /api/p/a/cards?status=pending；events?type=chat.human 可回放
# B：批准 → 自动派发（真实 fake_harness 进程）→ 回执 → 验收
curl -s -X POST $BASE/api/p/a/cards/C-0001/approve
sleep 6 && curl -s $BASE/api/p/a/packages                # 两任务 reported，receipt 含 files_changed 与 telemetry(tokens)
curl -s -X POST $BASE/api/p/a/tasks/T-0001/audit -H "Content-Type: application/json" -d '{"result":"pass"}'   # done
#   崩溃超时：harness-map.json 里 args 加 "--fail"、watchdog_minutes_default 改 0.05 →
#   进程 exit 1 不回执 → 约 3 秒后任务 timeout + events?type=task.timeout
```

真模型模式：设好 provider/model/key 环境变量后同样流程（核心代理经 `draft_card`/`dispatch` 工具真实起草与派发）；无 key 时 `agent/start` 可启动 pi 子进程，`chat` 返回 502 agent_error（降级路径）。

## 数据目录

- 默认 `backend/data/`：`registry.db`（全局注册表）+ `ledgers/{slug}.db`（每项目独立账本）；
- 设置环境变量 `SPECLOCK2_DATA_DIR`（建议绝对路径）可整体覆盖；
- 无迁移框架：应用启动建注册表，创建项目/打开账本时幂等建表（沿用 v1 做法）；
- `data/` 已被仓库根 `.gitignore` 排除，属运行时产物，可随时删除重建。

## 端点一览（契约 v0.3，全部真实现）

在 v0.2 基础上新增：`GET /blocks/{id}/versions/{version}`（版本快照，`version=draft` 为当前草稿）、
`POST /chat`、`GET /chat/stream`（SSE：message_delta / message_final / card_proposed / agent_error / ready）、
`GET /agent`（含 context_usage_percent，>80 落 chief.context_warning 事件）、`POST /agent/start`（幂等）、
`POST /agent/stop`、`POST /agent/reset`（修复单 19：stop + 归档 pi 会话 JSONL（文件名加时间戳后缀），下次启动全新上下文，A1 会话可弃）；
`receipt` 支持可选 `telemetry` 字段（时长/token，token_source: exact|estimated）。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | `{"ok":true}` |
| GET | `/api/projects` | 项目清单 `{"items":[...]}` |
| POST | `/api/projects` | `{slug,name}`；slug 冲突 409；创建即初始化独立账本 |
| GET | `/api/p/{slug}` | `{slug,name,current_round,open_card,working_dir,chief_provider,chief_model}` |
| PATCH | `/api/p/{slug}` | 更新绑定（契约 v0.4）：`{working_dir?,chief_provider?,chief_model?}`，只动显式传入的字段（显式 `""` 清空）；working_dir 必须存在且为目录（422） |
| DELETE | `/api/projects/{slug}` | 删除项目：注册表删行、核心代理会话停止；账本**不物理删除**，改名 `{slug}.db.deleted` 可手工恢复 |
| PATCH/DELETE | `/api/p/{slug}/masters/{id}` | 编辑主代理（name/duty/dir/harness/model/provider/session，校验同创建；改名查重 409）；删除在有 dispatched/running 任务时 409（先处理在跑的任务） |
| POST | `/api/p/{slug}/tasks/{id}/output` | 派发方上报过程输出增量（真实 chief 的 dispatch 工具 2s 节流调用）：滚动写 task.output_tail（保留最后 4KB）并广播 SSE `master_output` {task_id,master,text} |
| GET | `/api/fs/dirs?path=` | 列出绝对路径下的子目录 `{"items":[{name,path}]}`；path 不存在/不是目录 422。**仅本机单用户工具（无鉴权只读），不要暴露到公网** |
| GET | `/api/p/{slug}/tree` | 三层树 domains→documents→blocks |
| POST | `/api/p/{slug}/domains` `/documents` `/blocks` | 草稿态创建 |
| GET/PUT | `/api/p/{slug}/blocks/{id}` | 草稿四件套读写（PUT 只存草稿不产生版本；校验见 S1 节） |
| POST | `/api/p/{slug}/cards` | 卡片起草：statement{说明,动机} 必填；ops 逐条校验（block_id 存在性、modify id 匹配、upsert 唯一性预演）；落 `draft.proposed` |
| GET | `/api/p/{slug}/cards` | `?status=` 筛选 |
| POST | `/api/p/{slug}/cards/{id}/approve` | 应用 ops → BlockVersion 快照（semver：破坏 MAJOR/新增 MINOR/其余 PATCH/首版 1.0.0）→ 关闭当前轮开启下一轮（批准属于它关闭的那一轮）→ 建任务包（origin=approval，按 impact）→ `approval.granted`+`version.published`+`package.created` |
| POST | `/api/p/{slug}/cards/{id}/reject` | `{reason?}` → `approval.rejected`，轮次不动 |
| GET | `/api/p/{slug}/rounds`、`/rounds/{n}` | 轮次清单；轮次详情（events+versions+cards 聚合，时间线渲染源） |
| GET | `/api/p/{slug}/events` | `?since=&type=`：append-only，增量回放 |
| GET | `/api/p/{slug}/packages` | 任务包与任务状态 |
| POST | `/api/p/{slug}/tasks/{id}/dispatch` | `{watchdog_minutes?=60}`：queued→dispatched，启动看门狗；超时未回执 → timeout + `task.timeout` |
| POST | `/api/p/{slug}/tasks/{id}/receipt` | `{files_changed,self_check,summary}`：→reported |
| POST | `/api/p/{slug}/tasks/{id}/audit` | `{result:"pass"\|"fail",note?}`：→done/rejected；非法迁移 409 |
| POST | `/api/p/{slug}/tech-orders` | 技术任务单 `{intent,scope[],baseline?,acceptance[]}` → origin=tech 任务包（不进版本链）→ `tech.order` |
| GET/PUT/POST | `/api/p/{slug}/conventions`、`/conventions/draft`、`/conventions/approve` | 全局约定：当前版+草稿 / 草稿写入 / `{说明,动机}` 产生 ConventionVersion（首版 1.0.0，后续 PATCH） |
| GET | `/api/p/{slug}/stats` | 仪表盘聚合（轮次/卡片/任务包/任务状态） |
| GET/POST | `/api/models`、`DELETE /api/models/{id}` | Harness×模型**登记**（全局，不挂项目）：纯信息记录，重复登记 409；工作台不替 Harness 配置模型，派发不注入 `--model` |
| GET | `/api/cli-sessions` | **探测** pi CLI 自己的会话目录（`~/.pi/agent/sessions/**`，可用 `PI_CODING_AGENT_SESSION_DIR`/`SPECLOCK2_PI_SESSIONS_DIR` 覆盖）：`{id,title,updated_at}`，标题规则与 pi 会话选择器一致（session_info 命名优先，否则首条用户消息） |
| GET/POST | `/api/p/{slug}/masters` | 主代理名册：`{name,duty,dir,harness,model,session}`；harness×model 必须来自登记（422）、session 必须探测得到（422）、同名 409 |
| POST | `/api/p/{slug}/tasks/{id}/launch-plan` | **唤醒计划**：统一计算「怎么启动该任务的 harness」（名册 harness × harness-map × 会话接续 `--session-id/--session-dir`），真实 chief 的 dispatch 工具与 mock 执行器共用；响应 `{harness,command,argv,cwd,wrap_cmd,watchdog_minutes}` |

对外 id 格式：`E-0001`（事件）/ `C-0001`（卡片）/ `P-0001`（任务包）/ `T-0001`（任务）/ `O-0001`（技术单）/ `mdl-N`（模型登记）；block/domain/document/master id 为纯数字字符串。

## mcode 接入（第二真实 harness，2026-10-15 真机侦察）

mcode = Minimax Code CLI v0.6.8（`~/.minimax-code/`，认证在 `~/.minimax/`）。

- **headless**：`mcode exec "<prompt>" --permission full --cwd <dir>`——**纯文本 stdout**（无事件流），
  全部 stdout 即回复文本；`FILES:` 约定照旧；token 不暴露 → 遥测恒 `estimated`；
- **启动命令**：必须用 mcode 自带 Node 运行时（`~/.minimax-code/runtime/node-*/node.exe` +
  `node_modules/@minimax-ai/code/cli.js`）——其 better-sqlite3 按自带版本编译，系统 Node 会报
  NODE_MODULE_VERSION 不匹配（127 vs 137 实测）；`SPECLOCK2_MCODE_CMD` 可整体覆盖；
- **会话**：默认每次 exec 新建会话；`--session <id>` 原地接续（不新建目录，记忆延续，实测跨进程派发
  回忆暗号成功）；id 形如 `mvs_<32hex>`，只存于 `~/.minimax/v2/sessions/<yyyy>/<mm>/<dd>/…/manifest.json`
  的 `sessionId`（目录名里是编码 id，不可直接用）；会话发现（`/api/cli-sessions`）只读 manifest 的
  id 与时间；接续目标丢失 → 优雅降级为新会话（同 pi）；
- **模型**：`--model` 须 `provider/model` 全名（实测 `minimax/MiniMax-M3` 可用、`minimax-cn/MiniMax-M3`
  不可用、裸 `MiniMax-M3` 参数错误）；无 `--model` 时用 mcode 自身默认（受其账号 token plan 影响）；
- **退出码**：0 成功；2 参数错误（如 --timeout 格式）；4 运行失败（模型不可用 / 会话不存在，错误行在
  stdout：`mcode exec failed: …`）；6 超时（`mcode exec timeout: …`）。非零退出 → 派发器记 crashed
  （结果带 stdout 尾部），不回执，看门狗兜底 timeout；
- **`--permission full` 完全无人值守**（hello 级任务实测无任何交互）；`--timeout` 是上限不是下限
  （5s 内完成则正常返回）；
- **升级路径（本轮不用）**：`mcode exec --output-format json|stream-json` 存在，将来要结构化事件时再上；
- **已知限制**：老会话可能因 mcode 内部迁移失效（实测报 "Canonical history target is missing after
  migration"，exit 4）——此时按接续丢失降级为新会话即可；模型服务慢时单回合可达 10+ 分钟，看门狗
  默认 60 分钟够用。

## 唤醒与探测边界（用户原则）

工作台**只做两件事**：启动 Harness（launch-plan + spawn）与监控/探测（会话扫描、看门狗、遥测解析）。
不替 Harness 做模型选择——`--model` 只来自登记/绑定信息的引用：默认映射的 pi 模板含
`--model {model}` 占位，派发时按「主代理名册登记的模型 → 项目核心代理模型（chief_provider/chief_model，
空则回退全局 env）」注入，都没有就摘除占位；模板本身不烤任何具体模型名。
「某 Harness 有哪些模型」只是 `/api/models` 里的登记信息，主代理名册引用它（创建时强校验），
派发时按名册 harness 唤醒 CLI，绑定了会话则带 `--session-id/--session-dir` 接续（pi 形态，其余 harness 在 harness-map.json 配 `resume_args` 模板）。

## 派发 cwd 与项目绑定（契约 v0.4）

- 项目可绑定目标仓库目录（`working_dir`，POST/PATCH 设置，必须存在且为目录）；
- **派发 cwd 解析**：`masters.working_dir`（相对路径按项目目录拼）→ `projects.working_dir` →
  都无则 **422 `project_unbound`「项目未绑定目标仓库，拒绝派发」**。工作台仓库永远不是候选——
  被派发 agent 不可能把文件写进工作台自己（2026-10-15 事故修复）；
- 项目核心代理模型：`chief_provider/chief_model` 按项目生效，空回退全局 env；
  `GET /api/p/{slug}/agent` 返回生效值与来源（`chief.source: project|env`）；
- registry.db 无迁移框架：启动时对缺列做幂等 `ALTER TABLE ADD COLUMN`（老库自动补齐）；
- **看门狗重启重建**：派发时 `dispatched_at`/`watchdog_minutes` 落库（定时器本身是内存态，
  进程重启即丢）；应用启动扫描全部账本里 dispatched/running 的僵尸任务，按落库
  watchdog_deadline 重武装，已过期（或无 deadline）的立即收尸标 timeout + `task.timeout` 事件。

## 账本表

16 张（DESIGN.md §17 的 15 张 + `tech_orders` 技术任务单表，见 S2 回执说明）。

## 验收自检脚本（M1 全流程）

后端启动后，在 Git Bash 中依次执行。

注意：Git Bash 里 curl 的 `-d '...中文...'` 会按本地代码页编码导致 422，**含中文的 JSON 必须写成 UTF-8 文件再用 `--data-binary @文件` 提交**（下面脚本用 python 生成，保证 UTF-8）。脚本在仓库根目录执行（`ls backend/data` 才对得上）：

```bash
BASE=http://127.0.0.1:8000

# 0. 准备：清空运行数据、重启后端，然后健康检查
curl -s $BASE/api/health                                   # {"ok":true}

# 1. 建链 + 草稿
python - <<'PY'
import json, pathlib
d = pathlib.Path("backend/.selfcheck")
d.mkdir(exist_ok=True)
files = {
    "dom.json": {"title": "日报业务"},
    "doc.json": {"domain_id": "1", "title": "导出需求"},
    "blk.json": {"document_id": "1", "title": "导出模块"},
    "draft.json": {
        "content_md": "# 背景\n日报导出",
        "rules": [{"name": "导出格式", "detail": "CSV"}],
        "apis": [{"name": "导出", "api": "GET /api/daily-report", "desc": "日报导出", "request": [], "response": []}],
        "nfr_md": "",
    },
    # 卡片1：改规则 + 契约加 format 参数（首版 1.0.0）
    "card1.json": {
        "statement": {"说明": "导出支持 Excel", "动机": "财务需要带格式月报"},
        "rule_ops": [{"block_id": "1", "op": "modify", "id": "R1",
                       "after": {"name": "导出格式", "detail": "CSV 与 Excel"}}],
        "api_ops": [{"block_id": "1", "op": "upsert", "key": "GET /api/daily-report",
                      "entry": {"name": "导出", "api": "GET /api/daily-report", "desc": "日报导出",
                                 "request": [{"name": "format", "type": "string", "required": False}],
                                 "response": []}}],
        "impact": ["backend", "frontend"],
    },
    # 卡片2：删 API → MAJOR
    "card2.json": {
        "statement": {"说明": "下线旧导出接口", "动机": "已被新接口替代"},
        "api_ops": [{"block_id": "1", "op": "remove", "key": "GET /api/daily-report"}],
    },
    # 卡片3：只加接口 → MINOR
    "card3.json": {
        "statement": {"说明": "新增导出任务创建接口", "动机": "大数据量导出改异步"},
        "api_ops": [{"block_id": "1", "op": "upsert", "key": "POST /api/export",
                      "entry": {"name": "创建导出", "api": "POST /api/export", "desc": "创建异步导出任务",
                                 "request": [], "response": []}}],
    },
    # 卡片4：只改规则文案 → PATCH
    "card4.json": {
        "statement": {"说明": "明确导出格式清单", "动机": "口径统一"},
        "rule_ops": [{"block_id": "1", "op": "modify", "id": "R1",
                       "after": {"name": "导出格式", "detail": "支持 CSV、Excel 与 PDF"}}],
    },
    "tech.json": {"intent": "重构导出内部实现", "scope": ["backend/"], "acceptance": ["pytest 通过"]},
    "conv_draft.json": {"content_md": "# 全局约定\n时间 ISO 8601 带时区；对外 id 一律字符串"},
    "conv_approve.json": {"statement": {"说明": "确立全局约定", "动机": "前后端并行需要共同约定"}},
}
for name, obj in files.items():
    (d / name).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
PY
curl -s -X POST $BASE/api/projects -H "Content-Type: application/json" -d '{"slug":"a","name":"ProjectA"}'
curl -s -X POST $BASE/api/p/a/domains   -H "Content-Type: application/json" --data-binary @backend/.selfcheck/dom.json
curl -s -X POST $BASE/api/p/a/documents -H "Content-Type: application/json" --data-binary @backend/.selfcheck/doc.json
curl -s -X POST $BASE/api/p/a/blocks    -H "Content-Type: application/json" --data-binary @backend/.selfcheck/blk.json
curl -s -X PUT  $BASE/api/p/a/blocks/1  -H "Content-Type: application/json" --data-binary @backend/.selfcheck/draft.json
J='-H Content-Type:application/json'

# 2. 卡片 → 批准：首版 1.0.0、round 1 关闭 round 2 开启、事件链、任务包
curl -s -X POST $BASE/api/p/a/cards $J --data-binary @backend/.selfcheck/card1.json   # C-0001
curl -s -X POST $BASE/api/p/a/cards/C-0001/approve
# {"versions":[{"block_id":"1","version":"1.0.0","breaking":false}],"closed_round":1,"package_id":"P-0001"}
curl -s $BASE/api/p/a/blocks/1        # versions: [1.0.0]，status published
curl -s $BASE/api/p/a/rounds          # round1 closed(approval_card_id C-0001) + round2 open
curl -s $BASE/api/p/a/events          # draft.proposed → approval.granted → version.published → package.created，全属 round 1
curl -s "$BASE/api/p/a/events?since=E-0002"   # 增量回放：E-0003、E-0004
curl -s $BASE/api/p/a/packages        # P-0001：backend+frontend 两任务 queued

# 3. semver 三级
curl -s -X POST $BASE/api/p/a/cards $J --data-binary @backend/.selfcheck/card2.json   # C-0002
curl -s -X POST $BASE/api/p/a/cards/C-0002/approve    # 2.0.0，breaking true
curl -s -X POST $BASE/api/p/a/cards $J --data-binary @backend/.selfcheck/card3.json   # C-0003
curl -s -X POST $BASE/api/p/a/cards/C-0003/approve    # 2.1.0
curl -s -X POST $BASE/api/p/a/cards $J --data-binary @backend/.selfcheck/card4.json   # C-0004
curl -s -X POST $BASE/api/p/a/cards/C-0004/approve    # 2.1.1
curl -s $BASE/api/p/a/blocks/1 | python -c "import sys,json;print([v['version'] for v in json.load(sys.stdin)['versions']])"
# ['1.0.0', '2.0.0', '2.1.0', '2.1.1']

# 4. 技术任务单 + 看门狗 + 状态机
curl -s -X POST $BASE/api/p/a/tech-orders $J --data-binary @backend/.selfcheck/tech.json  # O-0001 → P-0005
TASK=$(curl -s $BASE/api/p/a/packages | python -c "import sys,json;print(json.load(sys.stdin)['items'][-1]['tasks'][0]['task_id'])")
curl -s -X POST $BASE/api/p/a/tasks/$TASK/dispatch $J -d '{"watchdog_minutes":1}'   # dispatched（1 分钟看门狗）
sleep 70                                                                            # 不回执等超时
curl -s $BASE/api/p/a/packages | python -c "import sys,json;print([t['status'] for p in json.load(sys.stdin)['items'] for t in p['tasks']])"
# 技术单任务 timeout；"$BASE/api/p/a/events?type=task.timeout" 有 system 事件
# 另一任务（P-0001 的 backend 任务）正常链：
TASK2=$(curl -s $BASE/api/p/a/packages | python -c "import sys,json;print(json.load(sys.stdin)['items'][0]['tasks'][0]['task_id'])")
curl -s -X POST $BASE/api/p/a/tasks/$TASK2/dispatch $J -d '{"watchdog_minutes":60}'
curl -s -X POST $BASE/api/p/a/tasks/$TASK2/receipt $J -d '{"files_changed":["backend/x.py"],"self_check":"通过","summary":"完成"}'
curl -s -X POST $BASE/api/p/a/tasks/$TASK2/audit $J -d '{"result":"pass","note":"契约测试通过"}'   # done

# 5. 全局约定
curl -s -X PUT  $BASE/api/p/a/conventions/draft $J --data-binary @backend/.selfcheck/conv_draft.json
curl -s -X POST $BASE/api/p/a/conventions/approve $J --data-binary @backend/.selfcheck/conv_approve.json  # 1.0.0

# 6. 统计与隔离
curl -s $BASE/api/p/a/stats
curl -s -X POST $BASE/api/projects -H "Content-Type: application/json" -d '{"slug":"b","name":"ProjectB"}'
curl -s $BASE/api/p/b/events           # {"items":[]}：a 的一切在 b 不可见
curl -s $BASE/api/p/b/stats
rm -rf backend/.selfcheck
```

## 目录结构

```
backend/
├── README.md
├── requirements.txt        # 依赖（fastapi/uvicorn/sqlalchemy/pytest/httpx）
├── pyproject.toml          # pytest 配置
├── run.py                  # uvicorn 启动入口
├── speclock2/
│   ├── app.py              # 应用工厂
│   ├── config.py           # 数据目录（SPECLOCK2_DATA_DIR 可覆盖）
│   ├── db.py               # 注册表引擎 + 账本引擎缓存
│   ├── models.py           # 注册表 1 张表 + 账本 15 张表（DESIGN.md §17）
│   ├── schemas.py          # 请求体模型
│   ├── serialize.py        # 对外 JSON（id 字符串化等）
│   ├── errors.py           # 统一错误 envelope + 异常处理
│   ├── utils.py            # 时间/id 工具
│   └── routers/
│       ├── health.py       # GET /api/health
│       ├── projects.py     # /api/projects
│       └── project.py      # /api/p/{slug}/...
└── tests/
    ├── conftest.py         # 临时数据目录 + TestClient 夹具
    └── test_s0.py          # S0 验收流程测试
```
