# 任务：SpecLock 2 后端——mcode 接入为主代理 harness + 核心代理 /model 切换

## 前提（依赖单）

依赖 `PROMPTS/09-backend-project-binding.md`（项目绑定目录/派发 cwd 修复/看门狗落库恢复）。**若该单未完成，先完成它再做本单**，分开提交。

## 背景

产品要接入第二个真实 harness：**mcode（Minimax Code CLI v0.6.8）**，作为可派发的主代理运行时，与 pi 并列。侦察事实已录入 `DEV-PLAN.md` §5.7（必读）：headless = `mcode exec`（**纯文本 stdout**、无事件流）、`--cwd`、`--session <id>` / `-c`、`--model <provider/model>`、`--permission`（headless 用 `full`）、`--timeout`、`--append-system-prompt`；token 不暴露。另：产品要在工作台对话里支持 `/model` 切核心代理模型，后端需提供切换端点（pi RPC `set_model`，PI-ASSESSMENT 已核实存在）。

## 任务 A：mcode 接入（在 D:\Project2\code-261013-speclock2\mcodetest 下做全部真机实验）

1. **侦察补全**（实验后把结论写进 backend/README 的"mcode 接入"一节）：
   - `mcode exec` 的会话行为：默认是否产生会话？`--session <id>` 的 id 从哪来（找到 mcode 的会话存储位置，如 ~/.minimax*，说明格式）；
   - `--permission full` 下 exec 是否完全无人值守（用最小任务验证：`mcode exec "只回复一个词：hello" --permission full --cwd <mcodetest>`）；
   - 退出码语义（成功/模型错误/超时各是什么）。
2. **harness-map 加 `mcode` 条目**：command=mcode（解析到 PATH 或写绝对路径），args 模板 = `["exec", "{prompt}", "--permission", "full", "--cwd", "{cwd}"]`，可选 `["--session", "{session_id}"]` 接续、`["--model", "{model}"]` 注入；`{model}` 解析顺序沿用现有模板变量机制；
3. **输出解析适配**：mcode exec 是纯文本输出（非 NDJSON）——dispatch 解析器按 harness 区分：pi 走 NDJSON `message_end` 提取，mcode 直接把**全部 stdout 文本**当作回复文本（FILES: 约定照旧）；token 恒为 `estimated`；
4. **会话发现**：扩展 `cli_sessions.py` 支持 mcode——按侦察到的存储位置列出该项目目录下的历史会话（id + 时间），供"主代理绑定 CLI 会话"复用（绑定后派发自动带 `--session` 接续，接续文件丢失则优雅降级为新会话，同 pi 逻辑）；
5. **登记与派发测试（最小任务，协作规则 §5.6）**：创建一个 master 绑定 mcode → 派发 hello 级任务 → 验证：真实 mcode 进程、回执到达、files/summary 来自 stdout、duration 正确、token 标 estimated；再验证一次带 `--session` 接续的派发。

## 任务 B：/model 切换端点

`POST /api/p/{slug}/agent/model` `{provider?, model}` → 经 pi RPC `set_model` 切换该项目核心代理当前会话模型（会话内持久，pi 原生行为）；响应 `{ok, model}`；会话未运行 → 409；模型名非法由 pi 报错透传 502。`GET /agent` 的 model 字段切换后应反映新值。pytest：mock 模式下端点状态机（未运行 409、正常切换、GET 反映）。

## 约束

- 只动 `backend/` + `chief/`；不改 web/、DESIGN.md、DEV-PLAN.md、PROMPTS/；
- **测试派发一律最小任务（hello）**，一律在 mcodetest 目录或绑定的测试项目目录，禁止碰工作台仓库（§5.6）；
- mcode 集成面收缩在其 CLI 公开参数上，不解析其内部文件格式（会话发现只读 id 与时间）；
- 提交 `feat(backend,mcode): <摘要>`（侦察结论可先单独提交 `docs(backend): mcode 侦察`）；不要 push；UTF-8。

## 回执模板

```markdown
## 回执（后端·mcode 接入 + /model）
- 完成项：
- mcode 侦察结论摘要：（会话存储位置/权限行为/退出码）
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```
