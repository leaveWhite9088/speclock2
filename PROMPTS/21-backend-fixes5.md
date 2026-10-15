# 修复单 21（后端）：provider 按 harness 分治 + 派发快速失败收尸

## 背景（19:14 T-0006 故障复盘，含实证）

修复单 19 生效后核心代理正确走了 create_task 一步派发（O-0003 / T-0006），但 mcode 在
**模型路由层**拒绝了 `minimax-cn/MiniMax-M3`，进程快速失败、无回执，任务干等看门狗一小时。

实证（PM 已在 mcodetest 用 mcode 自带运行时验证）：

1. mcode cn-prod 路由表（bundle 内 `jJe` 常量）是**裸模型名清单**：
   `["MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.7"]`；
2. `--model` 参数**必须**是 `provider/model` 形态（裸名报
   "--model must use provider/model or provider/model#variant"）；
3. 合法 provider 名是 **`minimax`**：`--model minimax/MiniMax-M3` 实测通过并秒回；
   `minimax-cn/MiniMax-M3` 被路由层拒绝。
4. **同一个模型家族，两个 harness 两套方言**：pi 叫 `minimax-cn`，mcode 叫 `minimax`。
   dispatcher.py 里"两 harness 各用各的供应商名"的注释一直是对的。

破坏源：fb01ebc 的启动迁移「自动修存量坏值 provider=minimax → minimax-cn」是 provider 盲的——
它为修 chief 切模型的 502，把 pi 词表刷进了 mcode 主代理绑定。中午 T-0003/T-0004 能跑通，
正是因为当时还没被这次迁移污染。

**PM 已把数据修回**（mctest masters 与 registry 的 mcode 条目 provider=minimax），
**但现行启动迁移会在下次重启时把它再刷坏——本单第一优先级是拆除这颗雷。**

## 改动清单

### 1. 迁移与校验按 harness 分治（P0）

- 启动迁移只修 `harness=="pi"` 的存量条目；其他 harness 的 provider 是各自方言，一律不动。
- KNOWN_PROVIDERS（pi 供应商词表）校验只约束 pi 条目（chief 切换消费的就是它们）；
  非 pi 条目的 provider 原样接受（仅要求非空、不含 `/`）。
- masters / model_entries 的 provider 字段语义注释写清楚：**pi 方言（minimax-cn）只对
  pi 生效；mcode 方言是 minimax；登记界面按 harness 呈现各自 provider**。

### 2. 回归测试

- mcode 主代理（provider=minimax, model=MiniMax-M3）→ launch-plan 的 argv 必含
  `--model minimax/MiniMax-M3`。
- 迁移测试：存量含 pi 条目 provider=minimax 与 mcode 条目 provider=minimax，
  重启迁移后 pi 条目被修成 minimax-cn，**mcode 条目保持 minimax 不变**。

### 3. 派发快速失败收尸（P1）

- 新端点 `POST /api/p/{slug}/tasks/{id}/fail`，body `{reason, exit_code?, stderr?}`：
  仅 dispatched/running 可调 → 立即标 timeout、取消对应看门狗定时器、
  事件 task.timeout 的 payload 附 reason/exit_code/stderr 尾部。
- chief 扩展的 dispatch 与 create_task(prompt) 在被派发进程**非零退出**时调用它
  （现状：不回执干等看门狗，今晚 T-0006 等了一整小时）；工具结果照旧把 stderrTail 呈给模型。
- 状态语义说明（写进端点 docstring）：timeout 涵盖"超时"与"进程崩溃"两种未回执终局。

## 验收自检

1. pytest 全绿（含上述两个新测试）。
2. 临时实例：mcode 绑定 provider=minimax → launch-plan 吐出 `--model minimax/MiniMax-M3`；
   用替身 harness 非零退出 → /fail 立即 timeout，无看门狗等待。
3. 回执：一段话，列改动文件与测试结果。
