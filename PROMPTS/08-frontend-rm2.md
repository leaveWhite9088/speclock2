# 任务：SpecLock 2 前端——R-M2 接入轮（把对话接上真的核心代理）

## 背景与现状（重要）

后端 R-M2 已全部落地并可用（真模型 minimax-cn/MiniMax-M3 已配置）：五个新端点见 DEV-PLAN §2 契约 v0.3。**但前端输入框至今还是 M1 的本地模拟**（`web/src/App.vue` 里有写死的模拟文案"明白。如果这件事不动业务规则和契约……"，`client.ts` 里没有任何 chat 接线）——本切片就是把它换成真的。用户已实测发现此问题，这是当前最高优先级。

## 必读材料（仓库根目录下）

1. `DESIGN.md` §15（chat-first 形态）、§12.3（context_usage 退化信号）、§13.5（监控三层）
2. `DEV-PLAN.md` §2 契约 v0.3（chat/agent 五端点）
3. `backend/speclock2/routers/chat.py`——**可读**（确认 SSE 事件 payload 的确切形状），不许改

## 接口事实（以代码为准，此处为速览）

- `POST /api/p/{slug}/chat` `{message}` → 同步返回 `{ok, reply}`（同时会推 SSE）
- `GET /api/p/{slug}/chat/stream` → SSE，事件：`message_delta`（增量文本）、`message_final`（权威定稿）、`card_proposed`（核心代理起草了卡片）、`agent_error`
- `GET /api/p/{slug}/agent` → `{running, model, context_usage_percent, session_id}`
- `POST /api/p/{slug}/agent/start` / `POST /api/p/{slug}/agent/stop`
- 对话历史：事件日志里的 `chat.human` / `chat.chief` 事件（GET events 按类型查）——对话流的历史消息从这里恢复

## 任务

1. **对话接真（核心）**：
   - `client.ts` 补齐五个端点的类型与调用；
   - 输入框发消息 → `POST /chat`；回复走 SSE（`EventSource` 挂 `/chat/stream`）流式渲染：`message_delta` 增量追加（打字机），`message_final` 定稿；
   - **删除 App.vue 里的本地模拟文案与整段模拟逻辑**（那段"明白。如果这件事……"必须彻底消失）；
   - 页面加载时从事件日志恢复对话历史（按时间顺序渲染 chat.human / chat.chief）；若发现现有 events 端点无法一次取到完整对话时间线，记回执"契约疑问"，不要自行加端点；
   - `agent_error` → 对话流里错误气泡 + 重试入口。
2. **核心代理状态卡**：侧栏核心代理条目显示 `running / model / context_usage_percent`（10s 轮询 `GET /agent`；context > 80% 黄色告警——这是会话退化信号 §12.3）；未运行时给「启动」按钮（`POST /agent/start`）。
3. **卡片从对话里长出来**：`card_proposed` 事件 → 对话流当前轮次下出现一张待批准审批卡（复用现有 ApprovalCard 组件）；批准/打回接已有端点；批准后的派发消息正常按对话气泡渲染。
4. **降级兼容**：后端不可达时保持现有 MOCK 徽标降级；后端 `SPECLOCK2_CHIEF_MOCK=1` 时前端无需任何变化（接口同构，回复是后端模拟的）。
5. 清理：移除因模拟逻辑而不再需要的死代码。

## 验收标准（自检全过才算完成）

1. live：输入"你好" → SSE 流式收到**真实**回复（模拟文案彻底不存在于代码与界面）；
2. 对话中说"给导出模块加一个 Excel 表头样式选项" → 核心代理经 `draft_card` 起草 → `card_proposed` → 对话流出现待批准卡片 → 批准 → 版本/任务包联动正常（沿用现有逻辑）；
3. 核心代理状态卡显示模型名与 context_usage 实时值；stop 后出现启动按钮；
4. 刷新页面对话历史完整恢复（来自事件日志，非本地状态）；
5. `npm run build` 通过；控制台无报错；全程单页无路由。

## 约束

- 只动 `web/`；`backend/` 可读不可改；契约疑问走回执；
- 不引入新依赖（EventSource 是浏览器原生）；
- 提交 `feat(web,rm2): <摘要>`；不要 push；UTF-8、中文文案。

## 回执模板

```markdown
## 回执（R-M2 前端·对话接真）
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```
