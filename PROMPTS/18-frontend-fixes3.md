# 修复单 18（前端）：删除项目 405 + LLM 选择器语义 + 主代理视图直播数据

## 背景（三个用户实测故障，根因已查实，均在前端）

### 1. 删除项目报 405

用户点删除项目，确认弹层后报 `[405] method_not_allowed`。
根因：`web/src/api/client.ts:685` `deleteProject` 调的是 `DELETE /api/p/{slug}`——
该路径只注册了 GET/PATCH，所以 FastAPI 回 405。后端实现明确在
`DELETE /api/projects/{slug}`（backend/speclock2/routers/projects.py:42，契约 v0.4）。
**修复：改成 `/api/projects/${slug}`，mock.ts 同步。**

### 2. 项目设置「核心代理 LLM」切换不生效

`ProjectFormModal.vue` 把登记条目的 **harness 名写进了 chief_provider 字段**：
- 创建：154 行 `body.chief_provider = picked.harness`；
- 编辑：166-168 行同样按 harness 赋值；回显匹配 42 行也按 `e.harness === chief_provider`。

核心代理永远由 pi 承载，chief_provider 必须是**供应商名**（如 minimax-cn）。
现在选「mcode · MiniMax-M3」会把 provider 存成 "mcode"，pi 启动参数变成
`--model mcode/MiniMax-M3`，直接失败——这就是「切换核心代理 LLM 没法成功」。
（项目 a 已被此 bug 存脏，PM 已改为 minimax-cn。）
**修复：**
- 选择器只列 `harness === 'pi'` 的登记条目（现有 id=4：pi/minimax-cn/MiniMax-M3），
  标签用 `provider · model`；mcode 等主代理 harness 条目不出现（那是主代理绑定的事）。
- 提交 `picked.provider` + `picked.model`；回显匹配改按 provider+model。
- 没有 pi 条目时保留「默认（跟随全局）」并提示到模型登记处添加。
- **编辑保存后立即生效**：PATCH 成功且模型变化、核心代理运行中 → 自动调 setAgentModel
  （409 就提示先启动），否则用户保存后顶栏纹丝不动，看起来仍是「没成功」。

### 3. 顶栏模型面板怎么切都是 MiniMax-M3

核心代理切换面板把**全部登记条目**都列出来了（含 mcode 条目）。登记里仅有的两条都是
MiniMax-M3，用户点谁都得到「模型已切换为 minimax-cn/MiniMax-M3」，无从辨别也没东西可切。
**修复：核心代理切换面板只列 `harness === 'pi'` 条目**，条目标签 `provider · model`；
与修复 2 同一过滤口径。

### 4. mcode 主代理界面什么都没有

`App.vue:487` masterActivity 在 live 模式返回的是 `getMockActivity()`——按 mock 主代理 id
取值，真实主代理永远命中不了，所以视图空白。
**修复：live 模式改为真实数据（全部现成，无需后端改动）：**
- `/packages` 里该 master 名下任务的 时间线：任务号、状态、回执 summary 与 FILES；
- `task.output_tail`（task_out 已输出该字段）作为过程输出尾部；
- 已有的 SSE masterLive 实时行照旧合并展示；
- 无任何记录时给「暂无派发记录」占位，不再返回 mock。

## 验收自检

1. `npm run build` 通过；mock 模式删除项目成功（列表移除、无 405）。
2. mock 模式项目设置：选 pi 条目保存，PATCH body 的 chief_provider 是 `minimax-cn`。
3. live 模式（mctest）：mcode 主代理视图能看到 T-0004 的回执（FILES: hello-mcode.txt）与输出尾部。
4. 顶栏模型面板不再出现 mcode 条目。
5. 回执：一段话即可。
