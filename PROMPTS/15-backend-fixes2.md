# 任务：后端修复单——provider 校验 / 派发幂等 / 会话按目录过滤 / 遗留批量验收

## 问题背景（2026-10-15 用户实测复现）

1. **切模型报错**：核心代理 /model 列表点 pi 条目成功，点 mcode 条目报 `[502] Model not found: minimax/MiniMax-M3`。根因：模型登记里 mcode 条目的 provider 被写成 `"minimax"`（非法值，pi 的供应商名是 `minimax-cn`），登记时无校验，非法值直通 pi。
2. **派发 409**：用户让核心代理派任务，它报"409 conflict（reported → dispatched 非法迁移）"。根因：批准后工作台自动派发（rm2b）已把任务跑到 reported，核心代理按其指令再去 dispatch 同一任务，撞上状态机 409——双派发路径重叠，且 dispatch 对非 queued 任务返回硬 409，核心代理无法自行恢复。
3. **CLI 会话列表太乱**：`masters.py` 的 `cli_sessions.scan()` 不带目录过滤，添加主代理时列出该 harness 在所有目录下的历史会话。
4. **遗留任务污染徽标**：mctest 项目两个 hello 测试任务停在 reported，界面上"待验收"标签一直亮着（本次已手工 audit 清理，但机制上还会再发生）。

## 任务

1. **provider 校验 + 数据修正**：模型登记接口校验 provider ∈ pi 已知供应商集合（至少校验非空且不含 harness 名；更实用：维护一份合法 provider 清单常量，含 minimax-cn/anthropic/openai/google/deepseek 等，来源注释指向 pi 文档）；**把现存非法条目修掉**（mcode 条目 provider 改 minimax-cn，写一次性迁移或启动时修复均可）；POST /agent/model 透传 pi 的 502 时附一句"请检查模型登记的 provider"；
2. **派发幂等**：dispatch 状态迁移对非 queued 任务不再 409——返回 200 + `{skipped: true, reason: "task in state <x>"}`（进程没起来、无副作用）；chief 的宪法（chief/constitution.md）同步加一条："派发前先读任务包状态，只对 queued 任务调用 dispatch，其余跳过并向用户说明"；
3. **CLI 会话按目录过滤**：`GET /api/cli-sessions` 加 `?cwd=` 参数，scan 结果按会话所属工作目录过滤（侦察到的各 harness 会话存储都记录 cwd）；不传 cwd 保持旧行为；
4. **遗留批量验收**：`POST /api/p/{slug}/audit-all` `{result: "pass"|"fail", note?}`——把该项目全部 reported 任务一次性 audit，返回数量；供前端"一键清理"按钮使用。

## 验收自检

1. curl 重启后 GET models：mcode 条目 provider=minimax-cn；用该条目走 POST /agent/model 真机切换成功；
2. 对一个 reported 任务调 dispatch → 200 skipped；对 queued 任务正常派发（hello 级，§5.6）；
3. `GET /api/cli-sessions?cwd=<mcodetest>` 只返回该目录会话；
4. audit-all 清 reported → 数量正确；pytest 全绿不回归。

## 约束

只动 backend/ + chief/；提交 `fix(backend,ux-fixes): <摘要>`；不要 push；UTF-8。
