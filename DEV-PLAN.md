# SpecLock 2 开发计划（M1 账本核心）

- 版本：0.1　日期：2026-10-14　PM：主主代理（本会话）
- 关联：DESIGN.md v0.4（设计事实源）、PI-ASSESSMENT.md（pi 选型核查）
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

## 2. API 契约 v0

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
           "statement": { "说明": "...", "动机": "..." },
           "rule_ops":  [ { "op": "add|modify|remove", "id": "R3", "before": {...}, "after": {...} } ],
           "api_ops":   [ { "op": "upsert|remove", "key": "GET /export", "entry": {...}, "breaking": false } ],
           "breaking_count": 1, "impact": ["frontend","backend"],
           "risk": { "text": "...", "verified_by": null } }
Rule:    { "id": "R3", "name": "导出格式", "detail": "..." }
ApiEntry:{ "name": "...", "api": "GET /api/x", "desc": "...", "request": [...], "response": [...] }
Block:   { "id": "...", "title": "...", "status": "draft|published",
           "current_published_version": "1.3.0",
           "draft": { "content_md": "...", "rules": [Rule], "apis": [ApiEntry], "nfr_md": "..." },
           "versions": [ { "version": "1.3.0", "round": 12, "statement": {...}, "delta_summary": "2改1增" } ] }
```

**端点表**（状态列：`S0`=骨架切片实现真逻辑；`桩`=S0 注册但返回 501；`S1`~`S5`=后续切片实现）：

| 方法 | 路径 | 说明 | 状态 |
|------|------|------|------|
| GET | `/api/health` | 健康检查 `{ok:true}` | S0 |
| GET | `/api/projects` | 项目清单（全局注册表） | S0 |
| POST | `/api/projects` | `{slug,name}` 创建；slug 冲突 409；创建即初始化独立账本 | S0 |
| GET | `/api/p/{slug}` | 项目详情：`{slug,name,current_round,open_card}` | S0 |
| GET | `/api/p/{slug}/tree` | 三层树 domains→documents→blocks（含 status/版本号） | S0 |
| POST | `/api/p/{slug}/domains` | `{title}` | S0 |
| POST | `/api/p/{slug}/documents` | `{domain_id,title}` | S0 |
| POST | `/api/p/{slug}/blocks` | `{document_id,title}`，草稿态 | S0 |
| GET | `/api/p/{slug}/blocks/{id}` | 草稿 + 版本列表 | S0 |
| PUT | `/api/p/{slug}/blocks/{id}` | 草稿四件套读写（**不产生版本**） | S0 |
| POST | `/api/p/{slug}/cards` | 人工模拟"主主代理起草"：提交 Card | 桩 |
| GET | `/api/p/{slug}/cards` | `?status=` 筛选 | 桩 |
| POST | `/api/p/{slug}/cards/{id}/approve` | 应用 ops→快照→轮次推进→建任务包 | S3 |
| POST | `/api/p/{slug}/cards/{id}/reject` | `{reason?}` | S3 |
| GET | `/api/p/{slug}/rounds` | 轮次清单 | S3 |
| GET | `/api/p/{slug}/rounds/{n}` | 时间线渲染源（events+versions+cards） | S3 |
| GET | `/api/p/{slug}/events` | `?since=&type=` | S3 |
| GET | `/api/p/{slug}/packages` | 任务包与任务状态 | S4 |
| POST | `/api/p/{slug}/tasks/{id}/receipt` | `{files_changed,self_check,summary}`（M1 手工模拟） | S4 |
| POST | `/api/p/{slug}/tech-orders` | 技术任务单（DESIGN §6.4）：`{intent,scope[],baseline?,acceptance[]}` → 确认后生成 origin=tech 任务包 | S4 |
| GET | `/api/p/{slug}/conventions` | 全局约定当前版 | S5 |
| PUT | `/api/p/{slug}/conventions/draft` | 草稿 | S5 |
| POST | `/api/p/{slug}/conventions/approve` | 产生 ConventionVersion | S5 |

---

## 3. 数据落库（S0 建表骨架，字段最小化）

- **全局注册表** `backend/data/registry.db`：`projects(slug PK, name, created_at, status)`
- **每项目账本** `backend/data/ledgers/{slug}.db`，S0 建全部表的骨架（表名对齐 DESIGN.md §17）：
  `domains, documents, blocks, block_versions, conventions, convention_versions, rounds, events, approval_cards, task_packages, tasks, complaints, audit_runs, receipts, masters`
- 数据目录可用环境变量 `SPECLOCK2_DATA_DIR` 覆盖；启动时 init 建表（无迁移框架，沿用 v1 做法）。

---

## 4. 切片计划

| 切片 | 主题 | 后端 | 前端 | 验收 |
|------|------|------|------|------|
| **S0** | 骨架 | 工程/注册表/账本建库/S0 端点/桩/测试/README | 单页壳三栏布局/API client+mock/组件骨架/README | 两端可跑；FE live 模式列出 BE 建的项目 |
| **S1** | 文档系统 | 树/草稿端点充实（rules/apis 校验，复用 v1 diffing 思路） | 左栏模块全景树 + 草稿查看 | 建 domain→document→block，草稿四件套往返一致 |
| **S2** | 草稿编辑与卡片预览 | 卡片 ops 校验、draft.proposed 事件 | 卡片起草表单（人工编辑 ops）+ 卡片预览渲染 | 人工构造一张卡，卡片渲染与 §8.1 示意一致 |
| **S3** | 批准闭环 | approve/reject、快照、semver、轮次、事件日志 | 时间线（轮次卡）、批准/打回按钮、版本链视图 | 批准后：版本链+1、轮次关闭开启、events 可回放 |
| **S4** | 队列 | 任务包/任务状态机（**双入口**：批准卡片 / 技术任务单 `POST /tech-orders`）、回执端点、看门狗（内存定时） | 右栏任务包面板、回执手工提交、技术任务单建单表单、超时标红 | 手工回执推进状态机；技术单建单→派发→回执走通；超时事件可见 |
| **S5** | 约定与仪表盘 | conventions 三端点、统计聚合 | 全局约定编辑、仪表盘（时长/打回/违反榜） | **M1 总验收**（见 §6） |

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

---

## 6. M1 总验收（S5 完成时执行）

1. 创建项目 A、B，各建文档与模块；A 的任何数据在 B 中不可见（物理隔离）；
2. A 中人工起草卡片 → 批准 → 版本 1.0.0 产生、轮次 1 关闭、事件链完整；
3. 连续三轮变更（含一次破坏性 → MAJOR），版本链、时间线、版本 diff 正确；
4. 任务包手工回执与超时路径可走通；
5. 全程界面单页完成，无路由跳转；切到 B 再切回 A，状态原样。
