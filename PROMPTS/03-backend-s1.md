# 任务：SpecLock 2 后端——文档系统充实（切片 M1-S1）

## 角色

你是 SpecLock 2 项目的后端主代理，负责 `backend/` 目录。S0 骨架已验收通过；本切片充实文档系统的草稿校验与规则稳定 ID。技术栈不变：Python 3.11 + FastAPI + SQLAlchemy 2 + SQLite + pytest。

## 必读材料（仓库根目录下）

1. `DESIGN.md` §5——重点 5.3 规则 schema（**稳定数字 ID，创建时分配，永不复用**）、5.4 契约 schema（ApiEntry/ApiField 递归、children 挂载规则）、5.6 模块契约记录原则
2. `DEV-PLAN.md` §2 API 契约 v0、§4 的 S1 行
3. **参考实现**（同一作者的 v1 仓库，可读可改造复用）：`D:\Project2\code-260911-speclock\speclock\speclock\diffing.py`——字段校验、递归 flatten、children 挂载校验的思想都在里面

## 任务（只做 S1）

1. **草稿校验**（PUT `/api/p/{slug}/blocks/{id}` 及创建路径）：
   - `rules`：每条 `{id?, name, detail}`，name/detail 非空；
     - 无 id 的条目视为新增：服务端分配稳定 id（`R` + 模块内单调递增数字，**永不复用**——已删除的 id 不再分配给新规则，用 block 级计数器实现）；
     - 带 id 的条目按 id 匹配更新；id 在本模块不存在 → 422；
   - `apis`：ApiEntry 校验——`api` 形如 `"METHOD /path"`（METHOD 大写且属于 GET/POST/PUT/PATCH/DELETE，path 以 `/` 开头）；`desc` 非空；ApiField 递归校验：name 非空、`type` ∈ {string, number, integer, boolean, array, object}、**children 仅允许挂在 object/array 下**（array 的 children 描述元素结构）；模块内 method+path 唯一，重复 → 422；
   - 422 的 envelope `details` 逐条定位：`{"field": "apis[2].response[0].children[1].type", "message": "..."}` 风格（沿用 v1"逐条缺失清单"的做法）；
2. GET `/api/p/{slug}/blocks/{id}` 返回的 rules **总是带服务端分配后的 id**；
3. 校验通过前不落库（事务性：任一条非法则整次 PUT 拒绝，草稿保持原样）；
4. **不改契约形状**（本切片只是收紧校验 + id 分配语义），不加新端点；
5. pytest 补充：合法草稿、各类非法输入（规则缺名、api 格式错、children 挂错位置、method+path 重复）、**id 分配与稳定性**（两次 PUT 后既有规则 id 不变、删除后 id 不复用）、S0 原有用例不回归。

## 验收标准（自检全过才算完成）

1. PUT 合法草稿（含无 id 规则）→ GET 回读 rules 全带 id；再次 PUT 修改某条 detail → 该条 id 不变；
2. 删除一条规则后再新增 → 新规则拿到的是更新的 id，不复用被删的；
3. 每类非法输入 → 422 + details 定位到具体字段路径；
4. pytest 全绿。

## 约束

- 只在 `backend/` 内写文件；不修改 `DESIGN.md`、`DEV-PLAN.md`、`web/`、`PROMPTS/`；
- 契约疑问记回执，不自行改；不加契约外端点；不动 `data/` 运行数据；
- 提交：`feat(backend,s1): <摘要>`；不要 push；
- 全部 UTF-8，注释文档中文、量少而准。

## 回执模板

```markdown
## 回执（M1-S1 后端·文档系统充实）
- 完成项：
- 文件清单：
- 自检结果：（逐条附命令与结果摘要）
- 契约疑问/偏离：无 ｜ 列表
- 环境问题：
```
