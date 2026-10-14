"""S1 验收流程测试：草稿校验、规则稳定 id 分配与永不复用、错误逐条定位、事务性。"""

from __future__ import annotations


def _setup_block(client) -> str:
    client.post("/api/projects", json={"slug": "a", "name": "项目A"})
    dom = client.post("/api/p/a/domains", json={"title": "日报业务"}).json()
    doc = client.post(
        "/api/p/a/documents", json={"domain_id": dom["id"], "title": "导出需求"}
    ).json()
    blk = client.post(
        "/api/p/a/blocks", json={"document_id": doc["id"], "title": "导出模块"}
    ).json()
    return blk["id"]


def _put(client, block_id: str, body: dict):
    return client.put(f"/api/p/a/blocks/{block_id}", json=body)


def _error_fields(resp) -> list[str]:
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "validation_error"
    return [e["field"] for e in resp.json()["details"]["errors"]]


# ---------- 规则稳定 id：分配、稳定、永不复用 ----------


def test_rule_id_assignment_and_stability(client):
    block_id = _setup_block(client)

    # 两条无 id 规则 → 服务端分配 R1、R2；GET 回读总是带 id
    resp = _put(
        client,
        block_id,
        {"rules": [
            {"name": "导出格式", "detail": "支持 CSV 与 Excel"},
            {"name": "文件命名", "detail": "带日期后缀"},
        ]},
    )
    assert resp.status_code == 200
    rules = client.get(f"/api/p/a/blocks/{block_id}").json()["draft"]["rules"]
    assert [r["id"] for r in rules] == ["R1", "R2"]

    # 带 id 修改 R1 的 detail → id 不变
    resp = _put(
        client,
        block_id,
        {"rules": [
            {"id": "R1", "name": "导出格式", "detail": "支持 CSV、Excel 与 PDF"},
            {"id": "R2", "name": "文件命名", "detail": "带日期后缀"},
        ]},
    )
    assert resp.status_code == 200
    rules = resp.json()["draft"]["rules"]
    assert [r["id"] for r in rules] == ["R1", "R2"]
    assert rules[0]["detail"] == "支持 CSV、Excel 与 PDF"

    # 删除 R1 后新增无 id 规则 → 拿 R3，不复用被删的 R1
    resp = _put(
        client,
        block_id,
        {"rules": [
            {"id": "R2", "name": "文件命名", "detail": "带日期后缀"},
            {"name": "失败兜底", "detail": "导出失败时保留上次文件"},
        ]},
    )
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()["draft"]["rules"]] == ["R2", "R3"]

    # 已删除的 R1 不可再引用（不复用）
    fields = _error_fields(
        _put(client, block_id, {"rules": [{"id": "R1", "name": "复活", "detail": "不应允许"}]})
    )
    assert "rules[0].id" in fields


# ---------- 规则校验 ----------


def test_rules_validation_errors(client):
    block_id = _setup_block(client)

    # 缺 name / 缺 detail，逐条定位
    fields = _error_fields(_put(client, block_id, {"rules": [{"detail": "缺名字"}]}))
    assert "rules[0].name" in fields
    fields = _error_fields(_put(client, block_id, {"rules": [{"name": "有名字"}]}))
    assert "rules[0].detail" in fields

    # id 格式非法
    fields = _error_fields(
        _put(client, block_id, {"rules": [{"id": "X9", "name": "n", "detail": "d"}]})
    )
    assert "rules[0].id" in fields

    # id 不存在
    fields = _error_fields(
        _put(client, block_id, {"rules": [{"id": "R9", "name": "n", "detail": "d"}]})
    )
    assert "rules[0].id" in fields

    # 同一次提交里 id 重复
    _put(client, block_id, {"rules": [{"name": "a", "detail": "d"}, {"name": "b", "detail": "d"}]})
    fields = _error_fields(
        _put(
            client,
            block_id,
            {"rules": [
                {"id": "R1", "name": "a", "detail": "d"},
                {"id": "R1", "name": "a2", "detail": "d2"},
            ]},
        )
    )
    assert "rules[1].id" in fields


# ---------- 契约校验 ----------


def test_apis_validation_errors(client):
    block_id = _setup_block(client)

    def put_apis(apis):
        return _put(client, block_id, {"apis": apis})

    ok_entry = {"name": "导出", "api": "GET /api/x", "desc": "语义", "request": [], "response": []}

    # 方法小写 → 必须大写
    fields = _error_fields(put_apis([{**ok_entry, "api": "get /api/x"}]))
    assert "apis[0].api" in fields
    # 非法方法
    fields = _error_fields(put_apis([{**ok_entry, "api": "FETCH /api/x"}]))
    assert "apis[0].api" in fields
    # 路径不以 / 开头
    fields = _error_fields(put_apis([{**ok_entry, "api": "GET api/x"}]))
    assert "apis[0].api" in fields
    # desc 缺失
    entry = {k: v for k, v in ok_entry.items() if k != "desc"}
    fields = _error_fields(put_apis([entry]))
    assert "apis[0].desc" in fields
    # desc 空串
    fields = _error_fields(put_apis([{**ok_entry, "desc": "  "}]))
    assert "apis[0].desc" in fields

    # 字段 type 非法（深层定位）
    bad_field = {"name": "date", "type": "datetime", "required": False}
    fields = _error_fields(put_apis([{**ok_entry, "request": [bad_field]}]))
    assert "apis[0].request[0].type" in fields

    # children 挂在 string 下（递归深层）
    deep = {
        "name": "data", "type": "object", "required": True,
        "children": [
            {"name": "items", "type": "string", "required": False,
             "children": [{"name": "id", "type": "integer", "required": True}]},
        ],
    }
    fields = _error_fields(put_apis([{**ok_entry, "response": [deep]}]))
    assert "apis[0].response[0].children[0].children" in fields

    # 递归深处 type 非法
    deep_bad = {
        "name": "data", "type": "object", "required": True,
        "children": [
            {"name": "items", "type": "array", "required": False,
             "children": [{"name": "id", "type": "text", "required": True}]},
        ],
    }
    fields = _error_fields(put_apis([{**ok_entry, "response": [deep_bad]}]))
    assert "apis[0].response[0].children[0].children[0].type" in fields

    # 字段名缺失
    fields = _error_fields(
        put_apis([{**ok_entry, "request": [{"type": "string", "required": False}]}])
    )
    assert "apis[0].request[0].name" in fields

    # method+path 模块内重复
    fields = _error_fields(put_apis([ok_entry, {**ok_entry, "name": "重复条目"}]))
    assert "apis[1].api" in fields


def test_valid_apis_with_recursive_children(client):
    block_id = _setup_block(client)
    apis = [
        {
            "name": "导出",
            "api": "GET /api/daily-report",
            "desc": "前端日报页调用，只读无副作用",
            "request": [{"name": "date", "type": "string", "required": True, "description": "查询日期"}],
            "response": [
                {
                    "name": "data", "type": "object", "required": True,
                    "children": [
                        {
                            "name": "items", "type": "array", "required": True,
                            "children": [{"name": "id", "type": "integer", "required": True}],
                        },
                    ],
                }
            ],
        }
    ]
    resp = _put(client, block_id, {"apis": apis})
    assert resp.status_code == 200, resp.text
    got = client.get(f"/api/p/a/blocks/{block_id}").json()["draft"]["apis"]
    assert got == apis  # 合法结构原样回读

    # object/array 可以不带 children（空数组容忍）；标量带空数组同样容忍
    minimal = [
        {
            "name": "创建", "api": "POST /api/daily-report", "desc": "生成导出任务",
            "request": [{"name": "fmt", "type": "string", "required": True, "children": []}],
            "response": [],
        }
    ]
    resp = _put(client, block_id, {"apis": [*apis, *minimal]})
    assert resp.status_code == 200


# ---------- 事务性：非法提交整次拒绝，草稿保持原样 ----------


def test_atomic_put_keeps_previous_draft(client):
    block_id = _setup_block(client)
    ok = _put(client, block_id, {
        "content_md": "# 背景",
        "rules": [{"name": "r1", "detail": "d1"}],
        "apis": [{"name": "a", "api": "GET /api/x", "desc": "语义", "request": [], "response": []}],
    })
    assert ok.status_code == 200

    # 混合提交：一条规则缺 name + 一条契约缺 desc → 错误清单合并返回
    bad = _put(client, block_id, {
        "rules": [{"name": "", "detail": "d"}, {"name": "ok", "detail": "d"}],
        "apis": [{"name": "b", "api": "GET /api/y", "request": [], "response": []}],
    })
    fields = _error_fields(bad)
    assert "rules[0].name" in fields
    assert "apis[0].desc" in fields

    # 草稿保持原样：无 id 分配泄漏、内容未被部分覆盖
    got = client.get(f"/api/p/a/blocks/{block_id}").json()["draft"]
    assert got["content_md"] == "# 背景"
    assert got["rules"] == [{"id": "R1", "name": "r1", "detail": "d1"}]
    assert got["apis"] == [{"name": "a", "api": "GET /api/x", "desc": "语义", "request": [], "response": []}]

    # 失败后再次合法新增 → id 从 R1 继续到 R2（失败提交不消耗计数器）
    resp = _put(client, block_id, {"rules": [{"name": "r2", "detail": "d2"}]})
    assert resp.status_code == 200
    # 注意：上面的 rules 只传了一条，是全量替换——r1 被删了。r2 拿到 R2。
    assert resp.json()["draft"]["rules"] == [{"id": "R2", "name": "r2", "detail": "d2"}]
