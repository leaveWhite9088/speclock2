# 任务：SpecLock 2 后端——M1 收尾整包（S2：审批闭环 + 队列 + 约定 + 统计）

## 角色

你是 SpecLock 2 项目的后端主代理，负责 `backend/`。S0 已验收。本切片把账本全流程一次做完：卡片 → 批准 → 版本/轮次/事件 → 任务包 → 派发/回执/审计/看门狗 → 技术任务单 → 全局约定 → 统计。做完 M1 后端就完整了。技术栈不变：Python 3.11 + FastAPI + SQLAlchemy 2 + SQLite + pytest。

## 前置检查（开工第一步）

`git log` 检查是否存在 `feat(backend,s1)` 提交且 S1 范围完成（草稿校验 + 规则稳定 ID，范围见 `PROMPTS/03-backend-s1.md`）。**若未完成：先完成 S1 范围，再进入 S2**，两段工作分开提交。

## 必读材料（仓库根目录下）

1. `DESIGN.md`——§6（版本与快照：**semver 判定规则**、业务变更说明书必填）、§7（事件日志与轮次，**轮次定义必须严格按 §7.3 执行**：批准属于它关闭的那一轮）、§8.2（卡片 schema，注意 ops 已改为携带 block_id）、§9（任务包/状态机/看门狗）、§6.4（技术任务单）、§5.5（全局约定）
2. `DEV-PLAN.md` §2 API 契约 **v0.2**（本次已扩充：所有新端点、数据形状、approve 响应以它为准）

## 任务

1. **卡片**：`POST cards`——校验 ops（每条 rule_op/api_op 携带 block_id；目标块必须存在；modify 的规则 id 必须已存在；api upsert 的 key 在目标块内唯一性预演）；`statement{说明,动机}` 必填；计算 `breaking_count`；落 `draft.proposed` 事件；`GET cards?status=`。
2. **批准/打回**：`approve`——应用 ops 到草稿 → 生成 BlockVersion 不可变快照（含 statement、round、delta_json、delta_summary）；semver 判定（沿用 v1 规则：删 API / 删必填字段 / 类型或必填变更 → MAJOR；有新增 → MINOR；其余 PATCH；首版 1.0.0；版本号永不复用）；**关闭当前轮次、开启下一轮**；创建任务包（origin=approval，按卡片 impact 生成 backend/frontend 任务）；落 `approval.granted` + `version.published` + `package.created` 事件；`reject` → `approval.rejected`。approve 响应形状见契约。
3. **轮次与事件**：`GET rounds`（清单）、`GET rounds/{n}`（该轮 events+versions+cards 聚合，时间线渲染源）；events 表 append-only，`GET events?since=&type=` 支持增量回放；事件类型对齐 DESIGN §7.2（M1 阶段 actor 用 human/system）。
4. **任务状态机**：`dispatch`（body 可带 `watchdog_minutes`，默认 60）→ `receipt`（→reported）→ `audit`（pass→done / fail→rejected）；非法状态迁移 → 409；**看门狗**：dispatch 时设 deadline，超时未回执 → `task.timeout` 事件 + 状态 timeout（内存定时器即可；测试用短 deadline）。
5. **技术任务单**：`POST tech-orders` `{intent,scope[],baseline?,acceptance[]}` → 校验（intent/scope 非空）→ 生成 origin=tech 任务包（含一个 master 待定任务）→ 落 `tech.order` 事件（M1 创建即视为确认）。
6. **全局约定**：`GET`（当前版 + 草稿）/ `PUT draft`（content_md）/ `POST approve`（`{说明,动机}` 必填 → ConventionVersion，semver 同规则，statement 必填）→ `convention.published` 事件。
7. **统计**：`GET stats`（形状见契约 Stats：轮次/卡片/任务包/任务状态聚合）。
8. **README 更新**：新端点清单 + 全流程自检脚本（沿用现有 UTF-8 文件提交中文 JSON 的做法）。

## 验收标准（自检全过才算完成）

1. 建链 → PUT 草稿 → 建卡 → approve：目标块版本 **1.0.0**、round 1 关闭且 round 2 开启、events 完整且可按 `since` 增量回放、package 生成且含 backend+frontend 两任务；
2. 第二张卡删一个 API → **MAJOR（2.0.0）**；第三张卡只加接口 → **MINOR（2.1.0）**；改规则文案 → **PATCH**；
3. `tech-orders` → `dispatch(watchdog_minutes=1)` → 不回执等超时 → `task.timeout` 事件 + 状态 timeout；另一任务走 `receipt` → `audit(pass)` → done；
4. conventions：PUT draft → approve → 版本 1.0.0，statement 缺失 → 422；
5. 双项目隔离：a 的卡片/版本/轮次/事件在 b 中不可见；
6. pytest 全绿（S0/S1 用例不回归），新增用例覆盖以上全部路径。

## 约束

- 只在 `backend/` 内写文件；不修改 `DESIGN.md`、`DEV-PLAN.md`、`web/`、`PROMPTS/`；
- 契约以 DEV-PLAN §2 v0.2 为准，疑问记回执不自行改；不加契约外端点；
- **不做 R-M2 的内容**（pi、真实对话流、真实进程派发——M1 全部手工模拟）；
- 提交 `feat(backend,s2): <摘要>`（若补了 S1 则先有 `feat(backend,s1)`）；不要 push；UTF-8、注释中文量少而准。

## 回执模板

```markdown
## 回执（M1-S2 后端·M1 收尾整包）
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```
