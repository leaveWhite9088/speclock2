# 修复单 19（后端）：派发失败纠偏回路 + 建任务一步化 + 会话重建端点

## 背景（17:50 故障复盘，证据已固化）

用户再问「你叫 mcode 主代理写一个 hello.txt」，核心代理回「T-0006 未派发：404 任务不存在：6…六单累计失败…属系统性崩溃…不主动重试」。

会话 JSONL（backend/data/pi-sessions/2026-10-15T03-26-38-520Z_speclock2-mctest.jsonl）钉死的事实：

1. **新代码已加载**：当轮 pi 进程 17:50:10 启动（修复 86367d1 是 17:40:06），
   第 60 行系统提示里明确有「新建任务必须用 create_task…禁止拿历史任务号去 dispatch」。
2. **模型无视指令**：它没调 create_task，直接编造 task_id="T-0006" 调 dispatch → 404（任务从未被创建）。
3. **404 工具结果只有裸错误文本**（`POST /tasks/T-0006/dispatch -> 404: …`），没有任何纠偏指引，
   模型于是写了一封戏剧化的「系统性崩溃」报告并宣布罢工。
4. **「四次故障原因变换」是模型把全天历史串成的故事**：better-sqlite3 版本不匹配（中午 mcode
   真实报过，NODE_MODULE_VERSION 不匹配，后来已修）、409（下午真实发生，已修幂等）、
   T-0005 幽灵 done（自测污染，已清）——每个都真，但 17:50 时通道本身没有故障。
5. **一次未遂的污染**：模型给 T-0006 写的任务说明里硬编码了
   「在 D:/Project2/code-261013-speclock2/speclock2/backend/ 目录下创建文件」——
   若真跑起来，mcode 会照着提示词把文件写进工作台仓库（--cwd 是 mcodetest 也拦不住）。

结论：prompt 级指令对模型的约束力不够，**必须在工具回路层面结构性兜底**。

## 改动清单（chief/extension/index.ts + constitution.md + 路由）

### 1. dispatch 工具：失败必须给纠偏回路，不许裸抛

- `POST /tasks/{id}/dispatch` 返回 404（任务不存在）→ 工具结果写：
  「任务 {id} 不存在——你不能编造任务号。请立即调用 create_task（带 intent、master、prompt），
  用它返回的真实任务号继续；这是当前回合内的重试，不是通道故障。」
- 409/skip 已有引导（86367d1），保持。
- 目标：模型在**同一回合**内拿到可执行的下一步，而不是去写故障报告。

### 2. create_task 直达派发一步化（消灭任务号交接）

- create_task 增加可选参数 `prompt`（任务说明）。提供时：POST /tech-orders 成功后**立即执行
  完整派发链**（与 dispatch 工具同一套 spawn+解析+回执代码，抽成共享函数），返回回执结果。
- 模型只需一次工具调用，**没有"拿着任务号去调另一个工具"的交接环节**——17:50 的失败点正是这个交接。
- constitution.md 同步：「叫某主代理做 X」一步用 `create_task(intent, master, prompt)` 完成。

### 3. 任务说明的路径纪律（防工作台污染，P1）

- constitution.md 增加一条：任务说明（prompt）里**禁止出现宿主/工作台仓库的绝对路径**；
  只写「在你的工作目录下创建 …」，目录由工作台按名册解析。
- create_task / dispatch 的工具结果文本里带上解析出的工作目录
  （launch-plan 的 cwd），让模型知道主代理的真实领地。
- 扩展侧加一道廉价防御：prompt 里包含本仓库根路径（REPO_ROOT）时，
  工具结果警告并要求模型改写为相对说法后再提交（不自动放行）。

### 4. POST /api/p/{slug}/agent/reset：核心代理会话重建（A1 会话可弃）

- 行为：stop 当前会话 → 把 pi 会话 JSONL 改名归档（文件名加时间戳后缀）→ 下次 ensure
  以同 session-id 全新上下文启动（文件已归档，resume 不到旧内容）。
- 背景：被污染的长会话上下文已被证明会持续误导模型（"六单失败"叙事就是从上下文里翻出来的）。
  A1：账本是 SSOT，会话可随时弃。
- 返回 `{"ok": true, "archived": "<归档文件名>"}`。

## 验收自检

1. pytest 全绿（reset 端点补测试：调用后旧 JSONL 归档、agent 状态 running=false）。
2. 临时实例模拟：dispatch 一个不存在的任务号 → 工具结果是纠偏文案而非裸 404；
   create_task(prompt) 一步完成建单+派发+回执（替身 harness 即可）。
3. 回执：一段话，列改动文件与测试结果。
