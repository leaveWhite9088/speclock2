# 修复单 17（后端）：核心代理建任务工具 + 派发跳过引导 + 验收防御 + 自测纪律

## 背景（三个用户实测故障，根因已查实）

用户对 mctest 项目的核心代理说「你叫 mcode 主代理写一个 hello.txt」，核心代理回复
「T-0005 未派发：调度账本已显示 done，但文件不存在，属幽灵完成。任务五单连续异常，当前 mcode 通道不可用」。
复盘账本（mctest.db）后的真相：

1. **mcode 通道本身是通的**：中午 T-0004 真实跑通过，回执 FILES: hello-mcode.txt，
   文件至今在 `D:\Project2\code-261013-speclock2\mcodetest\hello-mcode.txt`。
2. **T-0005 是幽灵 done**：从未派发（dispatched_at 为空、无回执），17:04:26 同一秒被批量验收标成 done
   ——这是提交 fb01ebc 前 14 秒、开发中间版本对**真实项目账本**自测造成的污染
   （终版 audit-all 只碰 reported，但当时跑的是未提交版本）。数据已由 PM 清理（改回 rejected）。
3. **结构性缺陷（本单核心）**：核心代理扩展只有 draft_card / dispatch / workbench_report 三个工具，
   **没有任何建任务的通道**。用户提直达请求时，核心代理只能去翻历史任务号：
   下午它反复对已终态的 T-0001~T-0004 调 dispatch，全部 skip/409，最后得出「通道不可用」的错误结论。
   它甚至无法核实文件（凭空猜了个 backend/hello.txt 路径）。

## 改动清单

### 1. chief 扩展新增 `create_task` 工具（chief/extension/index.ts）

- 参数：`{ intent: string, scope: string[], acceptance: string[], master: string }`
  （语义同 POST /tech-orders；master 是主代理名册里的名字）。
- 执行：POST `/tech-orders`，成功返回 `{order_id, package_id, task_id}`（task_id 形如 T-0006）。
- master 名不存在/不在名册 → 后端或工具侧报错时，把当前名册可用的 master 名单附在错误文本里，
  让模型能自行纠正。
- 同步更新 `chief/constitution.md`：收到「叫某主代理做 X」这类直达请求时，标准动作是
  **create_task（建技术任务单）→ dispatch（用返回的 task_id）→ 按回执回报结果**；
  明确禁止复用历史任务号、禁止把 dispatch 的 skipped 当作通道故障上报。

### 2. dispatch 工具的 skipped 语义修正（同文件）

- POST /tasks/{id}/dispatch 返回 `{skipped: true, reason: "task in state X"}` 时，
  工具输出文本要写成**引导**而不是故障：「任务 T-xxxx 状态为 X，不可派发。请新建任务（create_task）后重试。」
- 现状是核心代理把它解读成「mcode 通道不可用」并直接向用户宣告失败。

### 3. audit-all 防御回归测试

- 已上线的实现（只迁移 status=="reported"）补一个 pytest：账本同时存在
  queued / dispatched / done / rejected 任务时调 audit-all，断言这些任务原状态不变、只有 reported 被迁移。
- 背景：中间版本曾把从未派发的 queued 任务扫成 done。用测试把行为锁死。

### 4. 自测纪律（流程要求，写进 backend/README.md 开发约定一节）

- **禁止对真实项目账本（mctest / fe-selftest 等）发任何自测请求。**
  自测一律 `SPECLOCK2_DATA_DIR=<临时目录>` 起独立实例，或直接用 pytest。
- 本次幽灵 done 的直接成因就是提交前 14 秒对真实账本 curl 了未提交版本的代码。

## 验收自检

1. pytest 全绿（含新增回归测试）。
2. 临时实例（临时数据目录 + sl2-fake 或假名册即可，不要求真跑 mcode）：
   模拟「create_task → dispatch」链路，确认新任务从 queued 真实推进、skipped 场景的引导文案正确。
3. 回执：一段话，列出改动文件与测试结果即可。
