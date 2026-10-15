# 修复单 22（后端）：主代理会话绑定改为可选

## 背景

用户在主代理表单选「开始新对话（不绑定 CLI 会话）」提交，报
`[422] validation_error: 请选择要绑定的 CLI 会话`。

根因：`backend/speclock2/routers/masters.py` 的 `_validate_session` 把会话当必填（空值即 422），
与前端契约冲突（Sidebar.vue:184「会话空 = 开始新对话（不绑定 CLI 会话），不拦提交」，531 行空值选项）。
按设计会话绑定是可选的：dispatcher 的 plan_task_launch 对未绑定会话的主代理本来就走"每次新会话"，
绑定仅用于启用会话接续。这条必填是主代理编辑端点初版遗留，后被前端「开始新对话」选项越过。

## 改动清单

1. `_validate_session`：入参为空 → 返回 `None`（不绑定、不校验）；只有提供了会话 id 才校验它存在于
   `cli_sessions.scan()`（不存在仍 422 提示刷新）。
2. 创建/编辑主代理两处调用随之适配：`session_title` 为 None 时 `session_policy` 落 `{}`
   （不含 cli_session 键），`master_out` 的 `session` 自然为 null——与前端展示一致。
3. `web/src/api/mock.ts:1098` 的同款必填校验同步放松（mock 与真实行为一致）。
4. 测试：不绑会话创建主代理 → 201，`session_policy` 无 cli_session；绑定不存在会话 → 仍 422；
   绑定存在会话 → 正常落 title。

## 验收自检

1. pytest 全绿（含新增测试）。
2. 回执：一段话，列改动文件即可。
