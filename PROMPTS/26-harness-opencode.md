# 修复单 26（后端）：接入 opencode harness

## 问题

工作台现在能派发的 harness 有 pi、mcode、claude-code、codex、kimicode。
用户装好了 opencode 1.19.1。工作台不能派发任务给它。

## 目标（验收标准）

1. 添加主代理时，harness 选项里有 opencode。
2. 金路径：给 opencode 派一个 hello.txt 量级的任务。文件落在磁盘。回执记录 files_changed。
3. opencode 起不来或模型被拒时，任务秒级失败并带原因。不等看门狗。
4. mcode 不受影响：派一次小任务，行为与现在一致。
5. 测试套件全绿。

## 你来定的事

- opencode 的命令行形态自己研究。用 `opencode --help`、官方文档、实测确认。
- 输出形态自己定：纯文本还是事件流。参考 mcode 的 `"output": "text"`。
- 会话接续做不做、怎么做，自己判断。
- 模型方言自己定：opencode 要求的模型写法，登记进「模型」。
- 已装实例的升级路径自己定：改完代码，现有 harness-map.json 不用手改就能用 opencode。

## 背景（已查明的事实）

- harness 配置分四处。
  - backend/speclock2/harness_map.py：映射、占位符、命令发现。参考 mcode 条目和 resolve_mcode_command。
  - backend/data/harness-map.json：实例配置。文件已存在。只改 default_map 不会更新它。
  - backend/speclock2/routers/model_registry.py：「模型」登记。provider 按 harness 分方言。
  - backend/speclock2/routers/masters.py：主代理绑定校验。
- 前端有两处硬编码。
  - web/src/components/ModelPanel.vue 第 19 行：HARNESS_OPTIONS 列表。
  - web/src/components/Sidebar.vue 第 440 行：可派发徽标只认 harness 等于 mcode。
- opencode 1.19.1 装在 npm 全局。命令名是 opencode。
- npm 全局命令在 Windows 上是 .cmd 垫片。直接 spawn 会失败。dispatcher 已有 cmd /c 包装，mcode 条目也有先例。
- MiniMax Token Plan 配额今天耗尽（429，错误码 2056）。opencode 若配同一账号会同样失败。验收前先确认 opencode 配的模型能真回话。
- 派发的任务提示词里不得出现工作台绝对路径。
- 自测不碰真实项目账本。用临时项目，或把 SPECLOCK2_DATA_DIR 指向临时目录。

## 回执

一段话：opencode 怎么接的。金路径怎么验的。mcode 回归怎么验的。结论。
