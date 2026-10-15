# 修复单 23（后端）：核心代理↔主代理通信可见性

## 背景

通信协议边界（任务包下发 → 过程流 → 回执，不做双向对话）不变，本轮补可见性漏洞。今晚实测暴露两处：

1. **死因不可见**：T-0006 派发后 mcode 死于模型路由错误（错误文本在 stderr），过程直播显示"（等待输出…）"一小时。chief 扩展只把 stdout 增量 POST 到 /tasks/{id}/output，stderr 完全不进过程流——主代理失败时人和核心代理都看不到死因。
2. **核心代理的"已上报工作台"是空话**：workbench_report 工具只做 pi.appendEntry 写进会话文件，REST 端点从未补录（代码注释里自己写着"待契约补录"）。今晚两次 risk_note 在工作台 UI 零可见。

## 改动清单

### 1. stderr 进过程流（P1）

- chief 扩展 dispatch / create_task(prompt) 的被派发进程：stderr 增量也 POST /tasks/{id}/output，文本打标（如 `[stderr] ` 前缀），与 stdout 行交错保序或分块均可。
- 进程非零退出时：把 stderr 尾部（最后 ~500 字符）作为最后一笔 output 推入（确保 output_tail 留住死因），再调修复单 21 的 /tasks/{id}/fail。
- stdout 转发保持现状（节流策略不变）。

### 2. workbench_report 落账本（P1）

- 新端点 `POST /api/p/{slug}/reports`，body `{kind, text}`：校验非空 → 事件日志（actor=chief，type=`chief.report`，payload 含 kind/text）→ SSE 广播事件 `chief_report`。
- chief 扩展 workbench_report 改调该端点（appendEntry 可保留作会话内留痕，但主通道是 REST）。
- 前端渲染下一轮做，本轮只需事件与广播就位。

### 3. 测试

- /reports：空 text 422；正常落事件且事件可查。
- /output：带 `[stderr] ` 前缀的文本正常累积进 output_tail。

## 验收自检

1. pytest 全绿。
2. 临时实例：替身 harness 往 stderr 写错误并 exit 1 → 任务 output_tail 末尾含该错误文本、状态经 /fail 立即 timeout；POST /reports → events 里出现 chief.report。
3. 回执：一段话。
