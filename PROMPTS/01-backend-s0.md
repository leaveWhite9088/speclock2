# 任务：SpecLock 2 后端骨架（切片 M1-S0）

## 角色

你是 SpecLock 2 项目的后端主代理，负责 `backend/` 目录。产品是"需求到文档到代码的门禁工作台"，当前阶段 M1（账本核心）：不接 AI，先把数据模型和 API 立起来。技术栈：Python 3.11 + FastAPI + SQLAlchemy 2 + SQLite + pytest。

## 必读材料（开工前按顺序读完，仓库根目录下）

1. `DESIGN.md`——重点：§2 设计公理、§5 文档系统（5.2~5.6）、§7 事件日志与轮次、§8.2 卡片数据 schema、§14 多项目与隔离（一项目一账本，物理隔离）、§17 数据模型总表
2. `DEV-PLAN.md`——全文，尤其是 §2 API 契约 v0、§3 数据落库、§4 的 S0 行、§5 协作规则

## 任务（只做 S0，禁止超范围实现 S1+ 的功能）

1. 在 `backend/` 初始化工程：FastAPI 应用工厂、配置模块（数据目录默认 `backend/data/`，支持环境变量 `SPECLOCK2_DATA_DIR` 覆盖）、uvicorn 启动入口、pytest 骨架；
2. 全局注册表 `data/registry.db`（SQLite）：`projects(slug PK, name, created_at, status)`；
3. 每项目独立账本 `data/ledgers/{slug}.db`：创建项目时初始化，按 DEV-PLAN §3 建 **全部 15 张表**的骨架（表名严格对齐 DESIGN.md §17；S0 字段最小化，主键/外键关系正确即可，后续切片充实）；
4. 实现 DEV-PLAN §2 中标注 **S0** 的端点（真实逻辑）：
   - `GET /api/health`
   - `GET/POST /api/projects`（slug 冲突返回 409；创建即初始化独立账本文件）
   - `GET /api/p/{slug}`（current_round 初始为 0，open_card 为 null）
   - `GET /api/p/{slug}/tree`（三层树）
   - `POST /api/p/{slug}/domains`、`/documents`、`/blocks`（草稿态创建）
   - `GET/PUT /api/p/{slug}/blocks/{id}`（草稿四件套读写；PUT 只存草稿，**不产生任何版本**）
5. 契约 v0 其余端点全部注册为**桩**：返回 501 + 统一错误 envelope `{"code":"not_implemented","message":"..."}`；
6. 全局中间件：统一错误 envelope、ISO 8601 带时区时间、对外 id 一律字符串、列表 `{"items":[...]}` 包裹；
7. `backend/README.md`：从零安装、运行、测试的完整步骤（Windows + Git Bash 环境）。

## 验收标准（自检，全部满足才算完成）

1. uvicorn 启动无报错，`curl http://127.0.0.1:8000/api/health` 返回 `{"ok":true}`；
2. 创建 slug=a、slug=b 两个项目 → `data/ledgers/` 下出现两个独立 .db 文件；`GET /api/projects` 返回两条；
3. 在 a 中依次创建 domain → document → block，PUT 草稿后 GET 回读一致；b 的 tree 为空（隔离雏形）；
4. 任一桩端点（如 `POST /api/p/a/cards`）返回 501 + envelope；
5. pytest 全绿（至少覆盖上述全部流程）；
6. 按 README 从零执行可复现以上结果。

## 约束

- 只在 `backend/` 目录内写文件（含 `backend/README.md`）；
- 不修改 `DESIGN.md`、`DEV-PLAN.md`、`web/`、`PROMPTS/`；
- 对契约有疑问或发现矛盾：**不要自行改动**，记录到回执"契约疑问"栏，由 PM 裁决；
- 不加契约之外的端点；不引入数据库迁移框架（启动时 init 建表）；依赖最小化；
- 全部文件 UTF-8；代码注释和文档用中文，量少而准；
- git：仓库已初始化。完成后以 `feat(backend,s0): <摘要>` 提交；不要 push。

## 完成后按此模板交回执

```markdown
## 回执（M1-S0 后端骨架）
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```
