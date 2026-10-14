# SpecLock 2 后端（M1-S0 骨架）

技术栈：Python 3.11+ / FastAPI / SQLAlchemy 2 / SQLite / pytest。

本切片（S0）交付：

- FastAPI 应用工厂（`speclock2/app.py::create_app`）与 uvicorn 启动入口（`run.py`）；
- 全局注册表 `data/registry.db`：`projects(slug PK, name, created_at, status)`；
- 每项目独立账本 `data/ledgers/{slug}.db`：创建项目时初始化，含 DESIGN.md §17 全部 15 张表的骨架；
- 契约 v0（DEV-PLAN §2）中标注 S0 的端点（真逻辑），其余端点全部为桩（501）；
- 统一错误 envelope、ISO 8601 带时区时间、对外 id 字符串、列表 `{"items":[...]}` 包裹。

## 环境

- Windows 10/11 + Git Bash
- Python 3.11 及以上（开发机实测 3.12.9 可用）：`python --version` 确认

## 从零安装

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate     # Git Bash；PowerShell 用 .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 运行

在 `backend/` 目录、虚拟环境已激活的状态下：

```bash
python run.py
# 等价：uvicorn speclock2.app:create_app --factory --host 127.0.0.1 --port 8000
```

验证：

```bash
curl http://127.0.0.1:8000/api/health
# {"ok":true}
```

## 测试

```bash
pytest
```

测试通过环境变量 `SPECLOCK2_DATA_DIR` 把数据写入 pytest 临时目录，每个用例独立、互不污染。

## 草稿校验（S1 起）

PUT 草稿时 `rules` 与 `apis` 在落库前整体校验，任一条非法则整次 PUT 拒绝（422，草稿保持原样），`details.errors` 逐条定位字段路径（如 `"apis[0].response[0].children[0].children"`）：

- **rules**：每条 `{id?, name, detail}`，name/detail 非空。无 id 条目由服务端分配稳定 id（`R` + 模块内单调递增计数器，**永不复用**：已删除的 id 不会再分配、也不可再引用，引用不存在的 id → 422）；带 id 条目按 id 匹配当前草稿更新；GET 回读的 rules 总是带 id；
- **apis**：`api` 形如 `"METHOD /path"`（METHOD 大写且属于 GET/POST/PUT/PATCH/DELETE，path 以 `/` 开头）、`desc` 非空、name 非空；字段（request/response 递归 children）校验 name 非空、type ∈ {string, number, integer, boolean, array, object}、children 仅允许挂在 object/array 下（array 的 children 描述元素结构）；模块内 method+path 唯一。

## 数据目录

- 默认 `backend/data/`：`registry.db`（全局注册表）+ `ledgers/{slug}.db`（每项目独立账本）；
- 设置环境变量 `SPECLOCK2_DATA_DIR`（建议绝对路径）可整体覆盖；
- 无迁移框架：应用启动建注册表，创建项目/打开账本时幂等建表（沿用 v1 做法）；
- `data/` 已被仓库根 `.gitignore` 排除，属运行时产物，可随时删除重建。

## 端点一览（契约 v0）

真实现（S0）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | `{"ok":true}` |
| GET | `/api/projects` | 项目清单 `{"items":[...]}` |
| POST | `/api/projects` | `{slug,name}`；slug 冲突 409；创建即初始化独立账本 |
| GET | `/api/p/{slug}` | `{slug,name,current_round,open_card}`，初始 `current_round=0`、`open_card=null` |
| GET | `/api/p/{slug}/tree` | 三层树 domains→documents→blocks（含 status/版本号） |
| POST | `/api/p/{slug}/domains` | `{title}` |
| POST | `/api/p/{slug}/documents` | `{domain_id,title}` |
| POST | `/api/p/{slug}/blocks` | `{document_id,title}`，草稿态 |
| GET | `/api/p/{slug}/blocks/{id}` | 草稿 + 版本列表（S0 恒为空） |
| PUT | `/api/p/{slug}/blocks/{id}` | 草稿四件套写入（只存草稿，不产生版本）；支持部分字段更新；rules/apis 走服务端校验（见下） |

桩（全部返回 501 + `{"code":"not_implemented","message":"..."}`）：

`POST /api/p/{slug}/cards`、`GET /api/p/{slug}/cards`、`POST /api/p/{slug}/cards/{id}/approve`、
`POST /api/p/{slug}/cards/{id}/reject`、`GET /api/p/{slug}/rounds`、`GET /api/p/{slug}/rounds/{n}`、
`GET /api/p/{slug}/events`、`GET /api/p/{slug}/packages`、`POST /api/p/{slug}/tasks/{id}/receipt`、
`GET /api/p/{slug}/conventions`、`PUT /api/p/{slug}/conventions/draft`、`POST /api/p/{slug}/conventions/approve`

## 验收自检脚本（对应 S0 验收标准）

后端启动后，在 Git Bash 中依次执行。

注意：Git Bash 里 curl 的 `-d '...中文...'` 会按本地代码页编码导致 422，**含中文的 JSON 必须写成 UTF-8 文件再用 `--data-binary @文件` 提交**（下面脚本用 python 生成，保证 UTF-8）：

```bash
BASE=http://127.0.0.1:8000

# 1. 健康检查
curl -s $BASE/api/health                                   # {"ok":true}

# 2. 创建两个项目 -> data/ledgers/ 下出现 a.db、b.db（纯 ASCII 可直接 -d）
curl -s -X POST $BASE/api/projects -H "Content-Type: application/json" -d '{"slug":"a","name":"ProjectA"}'
curl -s -X POST $BASE/api/projects -H "Content-Type: application/json" -d '{"slug":"b","name":"ProjectB"}'
curl -s -X POST $BASE/api/projects -H "Content-Type: application/json" -d '{"slug":"a","name":"dup"}'   # 409
ls backend/data/ledgers                                     # a.db  b.db（若设过 SPECLOCK2_DATA_DIR 则看对应目录）
curl -s $BASE/api/projects                                  # 两条

# 3. a 中 domain -> document -> block，PUT 草稿后 GET 回读一致；b 的 tree 为空
python - <<'PY'
import json, pathlib
d = pathlib.Path("backend/.selfcheck")
d.mkdir(exist_ok=True)
files = {
    "dom.json": {"title": "日报业务"},
    "doc.json": {"domain_id": "1", "title": "导出需求"},
    "blk.json": {"document_id": "1", "title": "导出模块"},
    "draft.json": {
        "content_md": "# 背景\n日报导出",
        "rules": [{"name": "导出格式", "detail": "支持 CSV 与 Excel"}],
        "apis": [{"name": "导出", "api": "GET /api/daily-report", "desc": "日报导出", "request": [], "response": []}],
        "nfr_md": "导出 1 秒内完成",
    },
}
for name, obj in files.items():
    (d / name).write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
PY
curl -s -X POST $BASE/api/p/a/domains   -H "Content-Type: application/json" --data-binary @backend/.selfcheck/dom.json
curl -s -X POST $BASE/api/p/a/documents -H "Content-Type: application/json" --data-binary @backend/.selfcheck/doc.json
curl -s -X POST $BASE/api/p/a/blocks    -H "Content-Type: application/json" --data-binary @backend/.selfcheck/blk.json
curl -s -X PUT  $BASE/api/p/a/blocks/1  -H "Content-Type: application/json" --data-binary @backend/.selfcheck/draft.json
curl -s $BASE/api/p/a/blocks/1                               # 回读一致：rules 已带服务端分配的 id（R1），versions 为空
curl -s $BASE/api/p/a/tree                                  # 三层树：日报业务 -> 导出需求 -> 导出模块
curl -s $BASE/api/p/b/tree                                  # {"items":[]}（隔离雏形）
rm -rf backend/.selfcheck

# 4. 桩端点
curl -s -X POST $BASE/api/p/a/cards -w " [HTTP %{http_code}]"
# 501，{"code":"not_implemented","message":"POST /api/p/{slug}/cards（卡片起草，S2） 尚未实现，将在后续切片提供"}
```

## 目录结构

```
backend/
├── README.md
├── requirements.txt        # 依赖（fastapi/uvicorn/sqlalchemy/pytest/httpx）
├── pyproject.toml          # pytest 配置
├── run.py                  # uvicorn 启动入口
├── speclock2/
│   ├── app.py              # 应用工厂
│   ├── config.py           # 数据目录（SPECLOCK2_DATA_DIR 可覆盖）
│   ├── db.py               # 注册表引擎 + 账本引擎缓存
│   ├── models.py           # 注册表 1 张表 + 账本 15 张表（DESIGN.md §17）
│   ├── schemas.py          # 请求体模型
│   ├── serialize.py        # 对外 JSON（id 字符串化等）
│   ├── errors.py           # 统一错误 envelope + 异常处理
│   ├── utils.py            # 时间/id 工具
│   └── routers/
│       ├── health.py       # GET /api/health
│       ├── projects.py     # /api/projects
│       └── project.py      # /api/p/{slug}/...
└── tests/
    ├── conftest.py         # 临时数据目录 + TestClient 夹具
    └── test_s0.py          # S0 验收流程测试
```
