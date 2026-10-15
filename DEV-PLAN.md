# SpecLock 2 开发计划（M1 账本核心）

- 版本：0.1　日期：2026-10-14　PM：主主代理（本会话）
- 关联：DESIGN.md v0.6（设计事实源）、PI-ASSESSMENT.md（pi 选型核查）
- 当前阶段：**M1 账本核心**——不接任何 AI，人工模拟主主代理，验证数据模型与全流程

---

## 1. 总则

**目标**：M1 结束时，无 AI 参与即可完成：创建两个项目（验证物理隔离）→ 人工编辑审批卡片 → 批准 → 版本快照/轮次/事件链全部正确 → 队列手工推进 → 界面完整渲染。

**开发策略**：

1. **契约先行**：API 契约 v0（§2）是前后端唯一的接口。契约定了，两边并行。
2. **骨架先行**：每个切片先立骨架（结构、类型、端点桩、组件占位），再逐片充实。禁止跨切片实现。
3. **切片推进**：S0 → S5，每片有明确验收标准，验收通过才派发下一片。
4. **回执制**：每个切片完成后，主代理按 §5.4 模板交回执（M1 阶段由人工转发，M2 起走工作台回执端点）。

**仓库结构**：

```
speclock2/
├── DESIGN.md          # 设计事实源（人批准后才改）
├── DEV-PLAN.md        # 本文件：计划 + API 契约（契约变更走 PM）
├── PI-ASSESSMENT.md
├── PROMPTS/           # 各切片的派发提示词存档
├── backend/           # 后端主代理领地（Python/FastAPI/SQLite）
└── web/               # 前端主代理领地（Vue3/Vite 单页）
```

---

## 2. API 契约 v0.4（新增：项目绑定目录/核心代理模型、目录浏览、派发 cwd 修复）

**通用约定**（与 DESIGN.md §5.5 全局约定的子集一致）：

- 开发期后端 `http://127.0.0.1:8000`，前端 `http://127.0.0.1:5173`（Vite 代理 `/api` → 后端）；
- 所有响应 JSON；**错误 envelope**：`{"code": "...", "message": "...", "details": {...}}`，HTTP 状态码与语义一致（404 不存在 / 409 冲突 / 422 校验失败 / 501 未实现）；
- 时间一律 ISO 8601 带时区字符串；对外 id 一律字符串；
- 列表统一 `{"items": [...]}` 包裹。

**核心数据形状**：

```jsonc
Event:   { "id": "E-0001", "ts": "...", "round": 12, "actor": "human|chief|audit|master:backend|system",
           "type": "...", "ref": {}, "payload": {} }
Card:    { "card_id": "C-0031", "round": 12, "status": "pending|approved|rejected",
           "statement": { "说明": "...", "动机": "..." },          // 必填
           "rule_ops":  [ { "block_id": "1", "op": "add|modify|remove", "id": "R3", "before": {...}, "after": {...} } ],
           "api_ops":   [ { "block_id": "1", "op": "upsert|remove", "key": "GET /export", "entry": {...}, "breaking": false } ],
           "breaking_count": 1, "impact": ["frontend","backend"],
           "risk": { "text": "...", "verified_by": null } }
Rule:    { "id": "R3", "name": "导出格式", "detail": "..." }
ApiEntry:{ "name": "...", "api": "GET /api/x", "desc": "...", "request": [...], "response": [...] }
Block:   { "id": "...", "title": "...", "status": "draft|published",
           "current_published_version": "1.3.0",
           "draft": { "content_md": "...", "rules": [Rule], "apis": [ApiEntry], "nfr_md": "..." },
           "versions": [ { "version": "1.3.0", "round": 12, "statement": {...}, "delta_summary": "2改1增" } ] }
Package: { "package_id": "P-0012", "origin": "approval|tech", "round": 12,
           "version_refs": { "block_id": "1.3.0" }, "tasks": [Task] }
Task:    { "task_id": "T-0045", "master": "backend|frontend",
           "status": "queued|dispatched|running|reported|auditing|done|rejected|timeout",
           "watchdog_deadline": "...|null", "receipt": { "files_changed": [...], "self_check": "...", "summary": "..." }|null }
TechOrder:{ "order_id": "O-0007", "intent": "...", "scope": ["web/src/"], "baseline": {...}|null,
           "acceptance": ["..."], "package_id": "P-0013" }
Convention:{ "version": "1.0.0", "content_md": "...", "draft_md": "...|null", "statement": {...} }
Stats:   { "rounds": {"count": 13, "open": 14}, "cards": {"pending":1,"approved":12,"rejected":2},
           "packages": {"done": 11, "active": 1}, "tasks": {"rejected": 3, "timeout": 1} }
approve响应: { "versions": [{"block_id":"1","version":"1.1.0","breaking":false}],
              "closed_round": 12, "package_id": "P-0012" }
```

**端点表**（`S0 ✅` 已实现并验收；`S2` = M1 收尾整包轮实现）：

| 方法 | 路径 | 说明 | 状态 |
|------|------|------|------|
| GET | `/api/health` | 健康检查 `{ok:true}` | S0 ✅ |
| GET | `/api/projects` | 项目清单（含 working_dir、chief_provider/model） | S0→v0.4 扩 |
| POST | `/api/projects` | `{slug,name,working_dir?,chief_provider?,chief_model?}`；**working_dir 必须存在且为目录（422）**；创建即初始化独立账本 | S0→v0.4 扩 |
| PATCH | `/api/p/{slug}` | 更新 working_dir / chief_provider / chief_model（校验同上） | v0.4 |
| GET | `/api/fs/dirs?path=` | 列出目录的子目录 `[{name,path}]`（本机单用户工具，供目录选择器；path 不存在 422） | v0.4 |
| GET | `/api/p/{slug}` | 项目详情：`{slug,name,current_round,open_card}` | S0 ✅ |
| GET | `/api/p/{slug}/tree` | 三层树 domains→documents→blocks（含 status/版本号） | S0 ✅ |
| POST | `/api/p/{slug}/domains` | `{title}` | S0 ✅ |
| POST | `/api/p/{slug}/documents` | `{domain_id,title}` | S0 ✅ |
| POST | `/api/p/{slug}/blocks` | `{document_id,title}`，草稿态 | S0 ✅ |
| GET | `/api/p/{slug}/blocks/{id}` | 草稿 + 版本列表 | S0 ✅ |
| GET | `/api/p/{slug}/blocks/{id}/versions/{version}` | **某版本四件套快照**（`version=draft` 返回当前草稿）；响应含 content_md/rules/apis/nfr_md + statement/round/delta_summary。形状对齐 `web/src/api/client.ts` 的 `VersionDetail`（前端已按此调用，2026-10-14 验收发现契约缺口，补录） | S2-fix |
| PUT | `/api/p/{slug}/blocks/{id}` | 草稿四件套读写（**不产生版本**）；rules/apis 校验、规则稳定 ID | S1 |
| POST | `/api/p/{slug}/cards` | 人工模拟"主主代理起草"：提交 Card（校验 ops 与 block 存在性，statement 必填） | S2 |
| GET | `/api/p/{slug}/cards` | `?status=` 筛选 | S2 |
| POST | `/api/p/{slug}/cards/{id}/approve` | 应用 ops→快照→轮次关闭/开启→建任务包（origin=approval） | S2 |
| POST | `/api/p/{slug}/cards/{id}/reject` | `{reason?}` | S2 |
| GET | `/api/p/{slug}/rounds` | 轮次清单 | S2 |
| GET | `/api/p/{slug}/rounds/{n}` | 时间线渲染源（events+versions+cards） | S2 |
| GET | `/api/p/{slug}/events` | `?since=&type=`（append-only，回放） | S2 |
| GET | `/api/p/{slug}/packages` | 任务包与任务状态 | S2 |
| POST | `/api/p/{slug}/tasks/{id}/dispatch` | `{watchdog_minutes?}`（默认60）：queued→dispatched，启动看门狗 | S2 |
| POST | `/api/p/{slug}/tasks/{id}/receipt` | `{files_changed,self_check,summary}`：→reported（M1 手工模拟） | S2 |
| POST | `/api/p/{slug}/tasks/{id}/audit` | `{result:"pass"\|"fail",note?}`：auditing→done/rejected（M1 人工模拟审计） | S2 |
| POST | `/api/p/{slug}/tech-orders` | 技术任务单（DESIGN §6.4）：`{intent,scope[],baseline?,acceptance[]}` → 生成 origin=tech 任务包 | S2 |
| GET | `/api/p/{slug}/conventions` | 全局约定当前版 + 草稿 | S2 |
| PUT | `/api/p/{slug}/conventions/draft` | 草稿 `content_md` | S2 |
| POST | `/api/p/{slug}/conventions/approve` | `{说明,动机}` → 产生 ConventionVersion | S2 |
| GET | `/api/p/{slug}/stats` | 仪表盘聚合（形状见 Stats） | S2 |
| POST | `/api/p/{slug}/chat` | `{message}` 发给核心代理（pi）；回复经 SSE 推送；人消息与代理回复分别落 `chat.human` / `chat.chief` 事件 | R-M2 |
| GET | `/api/p/{slug}/chat/stream` | SSE 流：`message_delta` / `message_final` / `card_proposed` / `agent_error` | R-M2 |
| GET | `/api/p/{slug}/agent` | 核心代理状态：`{running, model, context_usage_percent, session_id}` | R-M2 |
| POST | `/api/p/{slug}/agent/start` | `{model?}` 启动/唤醒核心代理会话（幂等） | R-M2 |
| POST | `/api/p/{slug}/agent/stop` | 停止会话（pi 会话持久化，可再唤醒） | R-M2 |

---

## 3. 数据落库（S0 建表骨架，字段最小化）

- **全局注册表** `backend/data/registry.db`：`projects(slug PK, name, created_at, status)`
- **每项目账本** `backend/data/ledgers/{slug}.db`，S0 建全部表的骨架（表名对齐 DESIGN.md §17）：
  `domains, documents, blocks, block_versions, conventions, convention_versions, rounds, events, approval_cards, task_packages, tasks, complaints, audit_runs, receipts, masters`
- 数据目录可用环境变量 `SPECLOCK2_DATA_DIR` 覆盖；启动时 init 建表（无迁移框架，沿用 v1 做法）。

---

## 4. 切片计划

| 轮次 | 主题 | 后端 | 前端 | 验收 |
|------|------|------|------|------|
| **S0** ✅ 已验收 | 骨架 | 工程/注册表/账本建库/S0 端点/桩/测试/README | 单页壳三栏布局/API client+mock/组件骨架/README | 两端可跑；FE live 模式列出 BE 建的项目 |
| **S1** ✅ 已验收 | 文档系统 | 树/草稿端点充实（rules/apis 校验，复用 v1 diffing 思路） | 左栏模块全景树 + 草稿查看 | 建 domain→document→block，草稿四件套往返一致 |
| **S2** ✅ 已验收 | 账本全流程 | 卡片/批准/快照/semver/轮次/事件链/任务包双入口/回执/看门狗/约定/统计 | chat-first 重构 + M1 全部界面（含用户十余轮直达迭代） | **M1 总验收通过（2026-10-14：pytest 22 绿 + live 实测全链路）**；遗留版本快照端点 → R-M2 前置 |
| **R-M2** 接入轮 | 主主代理上线 | **A 阶段**：pi RPC 适配层、一项目一会话、SSE 对话流、对话入库（chat.* 事件）、核心代理经 `draft_card` 工具起草真卡；**B 阶段**：`dispatch` 工具真实派生 harness、遥测/回执、看门狗接真实进程 | （前端 R-M2 提示词待后端契约落地后另发） | A：SSE 流式回复 + 工具起草卡片出现；B：批准→真实进程→回执→done/timeout |
| 调整清单 | M3/M4 不预排轮次，大差不差再调整 | 契约测试生成、审计代理、投诉回流、看门狗细化 | 规则违反榜、仪表盘打磨、跨项目徽标、可视化 | 随做随派（工作台自身派发或人工转发），按张派发 |

> 粒度调整记录（2026-10-14）：原拆六片（S0~S5）→ 四片 → 现为 **2 个整包轮 + 调整模式**。原因：派发靠人工中继、往返成本高；S0 证明主代理可承载大任务；M3/M4 属打磨性质，适合"整包→大差不差→调整"的循环。
> **M2 前保留一次 M1 总验收**：主主代理站在账本 API 上工作，账本错误返工成本不对称——地基先验收再盖楼（即产品自身的理念）。
> 排序：S1 → S2（M1 收尾+总验收）→ R-M2。若 chat-first 设计稿在 S2 前就绪，可先派重设计技术单，S2 前端直接长在新形态上；否则重设计并入 R-M2 前端。

---

## 5. 协作规则

1. **目录所有权**：后端主代理只写 `backend/`；前端主代理只写 `web/`；`DESIGN.md`/`DEV-PLAN.md`/`PROMPTS/` 归 PM。
2. **契约变更流程**：发现契约有疑问/矛盾 → 不许自行改 → 记入回执"契约疑问"栏 → PM 裁决 → 更新本文件 §2 并在派发下一片时同步。
3. **提交规范**：`feat(backend,s0): 摘要` / `feat(web,s0): 摘要`；不 push。
4. **回执模板**（每片完成必交）：

```markdown
## 回执（<切片号> <主题>）
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```

5. **环境**：Windows 10 + Git Bash；Python 3.11；Node ≥ 22；pip/npm 可直连，GitHub 直连不通（需要时走镜像）；全部文件 UTF-8；中文文案。
6. **测试派发最小化**：开发期验证派发链路一律用最小任务（如"只回复一个词：hello"），**禁止派发真实业务任务**——派发 cwd 未绑定目标仓库前，真实任务会写坏工作台仓库（2026-10-15 事故）。

---

## 6. M1 总验收（S2 整包轮完成时执行）

1. 创建项目 A、B，各建文档与模块；A 的任何数据在 B 中不可见（物理隔离）；
2. A 中人工起草卡片 → 批准 → 版本 1.0.0 产生、轮次 1 关闭、事件链完整；
3. 连续三轮变更（含一次破坏性 → MAJOR），版本链、时间线、版本 diff 正确；
4. 任务包手工回执与超时路径可走通；
5. 全程界面单页完成，无路由跳转；切到 B 再切回 A，状态原样。
