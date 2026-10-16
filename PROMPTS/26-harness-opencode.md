# 修复单 26（后端）：harness 收敛为 pi、mcode、opencode

## 问题

工作台应支持的 harness 只有三个：pi、mcode、opencode。
现在的代码和配置里还留着 claude-code、codex、kimicode。
用户装好了 opencode 1.19.1。工作台不能派发任务给它。

## 目标（验收标准）

1. 添加主代理时，harness 选项只有 pi、mcode、opencode。claude-code、codex、kimicode 不出现。
2. 金路径：给 opencode 派一个 hello.txt 量级的任务。文件落在磁盘。回执记录 files_changed。
3. opencode 起不来或模型被拒时，任务秒级失败并带原因。不等看门狗。
4. mcode 不受影响：派一次小任务，行为与现在一致。
5. 测试套件全绿。

## 你来定的事

- claude-code、codex、kimicode 怎么删自己定。代码、默认映射、已装实例的 JSON、测试，都要干净。
- opencode 的命令行形态自己研究。用 `opencode --help`、官方文档、实测确认。
- 输出形态自己定：纯文本还是事件流。参考 mcode 的 `"output": "text"`。
- 会话接续做不做、怎么做，自己判断。
- 模型方言自己定：opencode 要求的模型写法，登记进「模型」。
- 已装实例的升级路径自己定：改完代码，现有 harness-map.json 不用手改。

## 背景（已查明的事实）

- 后端 harness 配置分四处。
  - backend/speclock2/harness_map.py：映射、占位符、命令发现。default_map 里有 claude-code、codex 条目。参考 mcode 条目和 resolve_mcode_command。
  - backend/data/harness-map.json：实例配置。现存条目：sl2-fake、pi、claude-code、codex、mcode。只改 default_map 不会更新它。
  - backend/speclock2/routers/model_registry.py：「模型」登记。登记表里只有 mcode 和 pi 的条目，无删除负担。
  - backend/speclock2/routers/masters.py：主代理绑定校验。
- sl2-fake 是内部替身，不在选项里。保留，不动。
- 前端有两处硬编码。
  - web/src/components/ModelPanel.vue 第 19 行：HARNESS_OPTIONS 列表含 kimicode。
  - web/src/components/Sidebar.vue 第 440 行：可派发徽标只认 harness 等于 mcode。opencode 也要有徽标。
- opencode 1.19.1 装在 npm 全局。命令名是 opencode。
- npm 全局命令在 Windows 上是 .cmd 垫片。直接 spawn 会失败。dispatcher 已有 cmd /c 包装，mcode 条目也有先例。
- MiniMax Token Plan 配额今天耗尽（429，错误码 2056）。opencode 若配同一账号会同样失败。验收前先确认 opencode 配的模型能真回话。
- 派发的任务提示词里不得出现工作台绝对路径。
- 自测不碰真实项目账本。用临时项目，或把 SPECLOCK2_DATA_DIR 指向临时目录。

## 回执

一段话：三个 harness 怎么收敛的。opencode 怎么接的。金路径怎么验的。mcode 回归怎么验的。结论。
