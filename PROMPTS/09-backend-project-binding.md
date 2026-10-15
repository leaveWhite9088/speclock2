# 任务：SpecLock 2 后端——项目绑定目录 + 核心代理模型 + 派发 cwd 修复

## 背景（2026-10-15 端到端验收事故）

派发链路已验证可用，但 `dispatcher.py::plan_task_launch` 把 cwd 硬编码为工作台仓库根，导致被派发 agent 把演示业务代码写进了工作台自己的仓库（已清理）。根因：项目没有"目标仓库"概念。本任务补上项目绑定，同时满足"添加项目时选目录和核心代理 LLM"的产品需求。

## 必读

`DEV-PLAN.md` §2 契约 **v0.4**（本次新增行：POST /api/projects 扩字段、PATCH /api/p/{slug}、GET /api/fs/dirs）；`backend/speclock2/models.py` 的 `Project`（注册表，现仅 slug/name）与 `Master`（已有 working_dir 字段）。

## 任务

1. **Project 注册表加三列**：`working_dir`、`chief_provider`、`chief_model`（均可空；后两者空 = 跟随全局 env `SPECLOCK2_CHIEF_PROVIDER/MODEL`）；
2. **POST /api/projects 扩字段**：接受 `working_dir?/chief_provider?/chief_model?`；working_dir 若提供必须存在且为目录（否则 422 + envelope）；GET projects / GET /api/p/{slug} 返回新字段；
3. **PATCH /api/p/{slug}**：更新上述三字段，校验同上；
4. **GET /api/fs/dirs?path=**：列出该绝对路径下的子目录 `{"items":[{name,path}]}`；path 不存在或不是目录 → 422；仅本机单用户工具，README 注明；
5. **派发 cwd 修复（核心）**：`plan_task_launch` 的 cwd 解析顺序 = `masters.working_dir` → `projects.working_dir` → **都无则 422 `"项目未绑定目标仓库，拒绝派发"`**。删除 REPO_ROOT 兜底——工作台仓库永不被派发写入。launch-plan 端点同步此语义（前端/core 收到 422 要能看见报错）；
6. **核心代理模型按项目生效**：pi_runtime 启动/唤醒会话时用项目的 chief_provider/chief_model，空则回退 env；`GET /agent` 返回**生效值**（含来源：project|env）；harness 启动模板支持 `{model}` 变量，主代理名册登记了模型则注入，否则用项目核心代理模型兜底（修"被派发 pi 落默认 M2.7"的漂移）；
7. pytest：新字段校验（422 路径）、PATCH、fs/dirs、**cwd 三级解析与 422 拒派**、模型注入模板；既有测试不回归（现 47 个）。

## 约束

- 只动 `backend/`；不改 web/、DESIGN.md、DEV-PLAN.md、PROMPTS/；
- **测试派发一律最小任务**（如"只回复一个词：hello"），禁止真实业务任务（协作规则 §5.6）；
- 提交 `feat(backend,project-binding): <摘要>`；不要 push；UTF-8。

## 回执模板

```markdown
## 回执（后端·项目绑定与派发 cwd 修复）
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```
