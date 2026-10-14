"""S2 验收流程测试：卡片→批准→版本/轮次/事件→任务包→状态机/看门狗→技术单→约定→统计→隔离。"""

from __future__ import annotations

import time


def _setup_project(client, slug: str = "a") -> str:
    """建项目 + domain→document→block，返回 block id（字符串）。"""
    resp = client.post("/api/projects", json={"slug": slug, "name": "项目A"})
    assert resp.status_code == 201, resp.text
    dom = client.post(f"/api/p/{slug}/domains", json={"title": "日报业务"}).json()
    doc = client.post(f"/api/p/{slug}/documents", json={"domain_id": dom["id"], "title": "导出需求"}).json()
    blk = client.post(f"/api/p/{slug}/blocks", json={"document_id": doc["id"], "title": "导出模块"}).json()
    return blk["id"]


def _put_draft(client, blk: str, slug: str = "a"):
    resp = client.put(f"/api/p/{slug}/blocks/{blk}", json={
        "content_md": "# 背景",
        "rules": [{"name": "导出格式", "detail": "CSV"}],
        "apis": [{"name": "导出", "api": "GET /api/daily-report", "desc": "日报导出", "request": [], "response": []}],
        "nfr_md": "",
    })
    assert resp.status_code == 200, resp.text


def _card(client, rule_ops=None, api_ops=None, impact=None, statement=None, slug="a"):
    body = {
        "statement": statement or {"说明": "导出支持 Excel", "动机": "财务需要带格式月报"},
        "rule_ops": rule_ops or [],
        "api_ops": api_ops or [],
    }
    if impact is not None:
        body["impact"] = impact
    return client.post(f"/api/p/{slug}/cards", json=body)


def _events(client, slug="a", **params):
    return client.get(f"/api/p/{slug}/events", params=params).json()["items"]


# ---------- 验收 1：全流程闭环 ----------


def test_full_approval_flow(client):
    blk = _setup_project(client)
    _put_draft(client, blk)

    resp = _card(client, rule_ops=[
        {"block_id": blk, "op": "modify", "id": "R1",
         "after": {"name": "导出格式", "detail": "CSV 与 Excel"}},
    ], api_ops=[
        {"block_id": blk, "op": "upsert", "key": "GET /api/daily-report",
         "entry": {"name": "导出", "api": "GET /api/daily-report", "desc": "日报导出",
                    "request": [{"name": "format", "type": "string", "required": False}],
                    "response": []}},
    ])
    assert resp.status_code == 201, resp.text
    card = resp.json()
    assert card["card_id"] == "C-0001"
    assert card["round"] == 1
    assert card["status"] == "pending"
    assert card["breaking_count"] == 0

    resp = client.post("/api/p/a/cards/C-0001/approve")
    assert resp.status_code == 200, resp.text
    approved = resp.json()
    assert approved["versions"] == [{"block_id": blk, "version": "1.0.0", "breaking": False}]
    assert approved["closed_round"] == 1
    assert approved["package_id"] == "P-0001"

    # 块：published、版本链 1.0.0、草稿已应用
    got = client.get(f"/api/p/a/blocks/{blk}").json()
    assert got["status"] == "published"
    assert got["current_published_version"] == "1.0.0"
    assert got["versions"][0]["version"] == "1.0.0"
    assert got["versions"][0]["round"] == 1
    assert got["draft"]["rules"][0]["detail"] == "CSV 与 Excel"
    assert got["draft"]["apis"][0]["request"][0]["name"] == "format"

    # 轮次：1 关闭、2 开启
    rounds = client.get("/api/p/a/rounds").json()["items"]
    assert [r["n"] for r in rounds] == [1, 2]
    assert rounds[0]["closed_at"] is not None
    assert rounds[0]["approval_card_id"] == "C-0001"
    assert rounds[0]["versions_manifest"] == {blk: "1.0.0"}
    assert rounds[1]["closed_at"] is None

    # 事件链完整（批准及其原子后果属于被关闭的第 1 轮）
    events = _events(client)
    assert [e["type"] for e in events] == [
        "draft.proposed", "approval.granted", "version.published", "package.created",
    ]
    assert all(e["round"] == 1 for e in events)
    assert all(e["id"].startswith("E-") for e in events)

    # since 增量回放 + type 过滤
    tail = _events(client, since="E-0002")
    assert [e["id"] for e in tail] == ["E-0003", "E-0004"]
    only_pub = _events(client, type="version.published")
    assert len(only_pub) == 1 and only_pub[0]["ref"]["block"] == blk

    # 任务包：backend + frontend 两任务
    packages = client.get("/api/p/a/packages").json()["items"]
    assert len(packages) == 1
    pkg = packages[0]
    assert pkg["package_id"] == "P-0001"
    assert pkg["origin"] == "approval"
    assert pkg["round"] == 1
    assert pkg["version_refs"] == {blk: "1.0.0"}
    assert [t["master"] for t in pkg["tasks"]] == ["backend", "frontend"]
    assert all(t["status"] == "queued" for t in pkg["tasks"])

    # 项目详情：进入第 2 轮、无待批卡片
    detail = client.get("/api/p/a").json()
    assert detail["current_round"] == 2
    assert detail["open_card"] is None

    # 轮次详情聚合（时间线渲染源）
    r1 = client.get("/api/p/a/rounds/1").json()
    assert len(r1["events"]) == 4
    assert len(r1["versions"]) == 1
    assert len(r1["cards"]) == 1
    assert r1["versions"][0]["block_id"] == blk


# ---------- 验收 2：semver 三级 ----------


def test_semver_major_minor_patch(client):
    blk = _setup_project(client)
    _put_draft(client, blk)

    # 首版 1.0.0
    _card(client, rule_ops=[{"block_id": blk, "op": "modify", "id": "R1",
                              "after": {"name": "导出格式", "detail": "CSV 与 Excel"}}])
    r = client.post("/api/p/a/cards/C-0001/approve").json()
    assert r["versions"][0]["version"] == "1.0.0"

    # 删 API → MAJOR 2.0.0
    _card(client, api_ops=[{"block_id": blk, "op": "remove", "key": "GET /api/daily-report"}])
    r = client.post("/api/p/a/cards/C-0002/approve").json()
    assert r["versions"][0]["version"] == "2.0.0"
    assert r["versions"][0]["breaking"] is True
    assert r["closed_round"] == 2

    # 只加接口 → MINOR 2.1.0
    _card(client, api_ops=[{"block_id": blk, "op": "upsert", "key": "POST /api/export",
                             "entry": {"name": "导出任务", "api": "POST /api/export", "desc": "创建导出任务",
                                        "request": [], "response": []}}])
    r = client.post("/api/p/a/cards/C-0003/approve").json()
    assert r["versions"][0]["version"] == "2.1.0"

    # 只改规则文案 → PATCH 2.1.1
    _card(client, rule_ops=[{"block_id": blk, "op": "modify", "id": "R1",
                              "after": {"name": "导出格式", "detail": "支持 CSV、Excel 与 PDF"}}])
    r = client.post("/api/p/a/cards/C-0004/approve").json()
    assert r["versions"][0]["version"] == "2.1.1"

    # 版本链与轮次推进
    got = client.get(f"/api/p/a/blocks/{blk}").json()
    assert [v["version"] for v in got["versions"]] == ["1.0.0", "2.0.0", "2.1.0", "2.1.1"]
    assert client.get("/api/p/a").json()["current_round"] == 5


# ---------- 卡片校验 ----------


def test_card_validation_errors(client):
    blk = _setup_project(client)
    _put_draft(client, blk)

    def fields(resp):
        assert resp.status_code == 422, resp.text
        return [e["field"] for e in resp.json()["details"]["errors"]]

    # statement 缺说明
    assert "statement.说明" in fields(_card(client, statement={"动机": "x"}))
    # 缺 block_id
    assert "rule_ops[0].block_id" in fields(
        _card(client, rule_ops=[{"op": "modify", "id": "R1", "after": {"name": "n", "detail": "d"}}])
    )
    # modify 的 id 不存在
    assert "rule_ops[0].id" in fields(
        _card(client, rule_ops=[{"block_id": blk, "op": "modify", "id": "R99",
                                  "after": {"name": "n", "detail": "d"}}])
    )
    # add 的 after.name 空
    assert "rule_ops[0].after.name" in fields(
        _card(client, rule_ops=[{"block_id": blk, "op": "add", "after": {"name": "", "detail": "d"}}])
    )
    # 目标块不存在 → 404
    resp = _card(client, rule_ops=[{"block_id": "999", "op": "add", "after": {"name": "n", "detail": "d"}}])
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"
    # remove 不存在的 key
    assert "api_ops[0].key" in fields(
        _card(client, api_ops=[{"block_id": blk, "op": "remove", "key": "GET /api/none"}])
    )
    # upsert entry 字段非法（定位映射到 api_ops[i].entry）
    assert "api_ops[0].entry.request[0].type" in fields(
        _card(client, api_ops=[{"block_id": blk, "op": "upsert", "key": "GET /api/x",
                                 "entry": {"name": "x", "api": "GET /api/x", "desc": "d",
                                            "request": [{"name": "a", "type": "text"}], "response": []}}])
    )
    # key 格式非法
    assert "api_ops[0].key" in fields(
        _card(client, api_ops=[{"block_id": blk, "op": "upsert", "key": "get /api/x",
                                 "entry": {"name": "x", "api": "get /api/x", "desc": "d",
                                            "request": [], "response": []}}])
    )
    # 卡片创建失败不落事件
    assert _events(client) == []


# ---------- 打回 ----------


def test_reject_flow(client):
    blk = _setup_project(client)
    _put_draft(client, blk)
    _card(client)
    resp = client.post("/api/p/a/cards/C-0001/reject", json={"reason": "动机不充分"})
    assert resp.status_code == 200
    card = resp.json()
    assert card["status"] == "rejected"
    assert card["decision"]["result"] == "rejected"
    assert card["decision"]["reason"] == "动机不充分"

    # 轮次不推进（打回不关闭轮次）
    assert client.get("/api/p/a").json()["current_round"] == 1
    assert [t for t in [e["type"] for e in _events(client)]] == ["draft.proposed", "approval.rejected"]

    # 已打回的卡不能再批准
    resp = client.post("/api/p/a/cards/C-0001/approve")
    assert resp.status_code == 409
    # pending 过滤
    assert client.get("/api/p/a/cards", params={"status": "pending"}).json()["items"] == []


# ---------- 验收 3：任务状态机与看门狗 ----------


def test_task_lifecycle_and_watchdog(client):
    blk = _setup_project(client)
    _put_draft(client, blk)
    _card(client)
    client.post("/api/p/a/cards/C-0001/approve")
    tasks = client.get("/api/p/a/packages").json()["items"][0]["tasks"]
    t1, t2 = tasks[0]["task_id"], tasks[1]["task_id"]

    # T1 正常链：dispatch → receipt → audit(pass) → done
    r = client.post(f"/api/p/a/tasks/{t1}/dispatch", json={"watchdog_minutes": 30})
    assert r.status_code == 200
    assert r.json()["status"] == "dispatched"
    assert r.json()["watchdog_deadline"] is not None
    r = client.post(f"/api/p/a/tasks/{t1}/receipt",
                     json={"files_changed": ["backend/x.py"], "self_check": "通过", "summary": "完成导出"})
    assert r.status_code == 200
    assert r.json()["status"] == "reported"
    assert r.json()["receipt"]["files_changed"] == ["backend/x.py"]
    r = client.post(f"/api/p/a/tasks/{t1}/audit", json={"result": "pass", "note": "契约测试通过"})
    assert r.status_code == 200
    assert r.json()["status"] == "done"

    # done 后再 receipt → 409 非法迁移
    r = client.post(f"/api/p/a/tasks/{t1}/receipt", json={"self_check": "x", "summary": "y"})
    assert r.status_code == 409
    # audit result 非法值 → 422
    r = client.post(f"/api/p/a/tasks/{t1}/audit", json={"result": "maybe"})
    assert r.status_code == 422

    # T2 看门狗：短 deadline 不回执 → timeout + task.timeout 事件
    r = client.post(f"/api/p/a/tasks/{t2}/dispatch", json={"watchdog_minutes": 0.03})  # ≈1.8s
    assert r.status_code == 200
    time.sleep(2.5)
    tasks_after = client.get("/api/p/a/packages").json()["items"][0]["tasks"]
    assert tasks_after[1]["status"] == "timeout"
    timeouts = _events(client, type="task.timeout")
    assert len(timeouts) == 1
    assert timeouts[0]["actor"] == "system"
    assert timeouts[0]["ref"]["task"] == t2
    # timeout 后不能再回执
    r = client.post(f"/api/p/a/tasks/{t2}/receipt", json={"self_check": "x", "summary": "y"})
    assert r.status_code == 409

    # audit(fail) → rejected（另走一个任务：技术单任务）
    order = client.post("/api/p/a/tech-orders", json={
        "intent": "重构导出内部实现", "scope": ["backend/"], "acceptance": ["pytest 通过"]}).json()
    ot = client.get("/api/p/a/packages").json()["items"][-1]["tasks"][0]["task_id"]
    client.post(f"/api/p/a/tasks/{ot}/dispatch", json={"watchdog_minutes": 30})
    client.post(f"/api/p/a/tasks/{ot}/receipt", json={"self_check": "自检通过", "summary": "重构完成"})
    r = client.post(f"/api/p/a/tasks/{ot}/audit", json={"result": "fail", "note": "范围越界"})
    assert r.json()["status"] == "rejected"

    # 事件类型齐全
    types = {e["type"] for e in _events(client)}
    assert {"task.dispatched", "task.receipt", "audit.machine.passed", "audit.machine.failed",
            "task.timeout", "tech.order"} <= types


# ---------- 验收 3b：技术任务单 ----------


def test_tech_order_flow(client):
    _setup_project(client)
    # 校验：缺 intent / scope → 422
    r = client.post("/api/p/a/tech-orders", json={"scope": ["web/src/"], "acceptance": []})
    assert r.status_code == 422
    assert "intent" in [e["field"] for e in r.json()["details"]["errors"]]
    r = client.post("/api/p/a/tech-orders", json={"intent": "x", "acceptance": []})
    assert r.status_code == 422

    r = client.post("/api/p/a/tech-orders", json={
        "intent": "前端视觉重设计，按新设计稿",
        "scope": ["web/src/"],
        "baseline": {"设计稿": "mocks/v2.png"},
        "acceptance": ["build 通过", "人工目验"],
    })
    assert r.status_code == 201, r.text
    order = r.json()
    assert order["order_id"] == "O-0001"
    assert order["package_id"].startswith("P-")

    packages = client.get("/api/p/a/packages").json()["items"]
    tech_pkg = [p for p in packages if p["package_id"] == order["package_id"]][0]
    assert tech_pkg["origin"] == "tech"
    assert tech_pkg["version_refs"] == {}
    assert len(tech_pkg["tasks"]) == 1
    assert tech_pkg["tasks"][0]["master"] == "backend"  # 技术单默认执行主体（可传 master 覆盖）

    ev = _events(client, type="tech.order")
    assert ev[0]["ref"]["order"] == "O-0001"
    assert ev[0]["payload"]["order"]["intent"] == "前端视觉重设计，按新设计稿"


# ---------- 验收 4：全局约定 ----------


def test_conventions_flow(client):
    _setup_project(client)
    # 初始无版本
    assert client.get("/api/p/a/conventions").json() == {
        "version": None, "content_md": None, "draft_md": None, "statement": None,
    }
    # PUT draft
    r = client.put("/api/p/a/conventions/draft", json={"content_md": "# 约定\n时间 ISO 8601 带时区"})
    assert r.status_code == 200
    assert r.json()["draft_md"].startswith("# 约定")
    # 空 content_md → 422
    assert client.put("/api/p/a/conventions/draft", json={"content_md": "  "}).status_code == 422
    # statement 缺失 → 422
    r = client.post("/api/p/a/conventions/approve", json={"statement": {"说明": "初版"}})
    assert r.status_code == 422
    assert "statement.动机" in [e["field"] for e in r.json()["details"]["errors"]]

    # approve → 1.0.0，草稿清空
    r = client.post("/api/p/a/conventions/approve", json={
        "statement": {"说明": "确立全局约定", "动机": "前后端并行需要共同约定"}})
    assert r.status_code == 200
    assert r.json()["version"] == "1.0.0"
    assert r.json()["draft_md"] is None

    # 再次改稿批准 → 1.0.1（PATCH，见回执说明）
    client.put("/api/p/a/conventions/draft", json={"content_md": "# 约定 v2\nID 一律字符串"})
    r = client.post("/api/p/a/conventions/approve", json={
        "statement": {"说明": "补充 ID 约定", "动机": "对外形状统一"}})
    assert r.json()["version"] == "1.0.1"

    # 事件
    pubs = _events(client, type="convention.published")
    assert [e["ref"]["version"] for e in pubs] == ["1.0.0", "1.0.1"]
    # 没有约定草稿时 approve → 422
    r = client.post("/api/p/a/conventions/approve", json={"statement": {"说明": "x", "动机": "y"}})
    assert r.status_code == 422


# ---------- 统计 ----------


def test_stats(client):
    blk = _setup_project(client)
    # 无活动：全 0
    assert client.get("/api/p/a/stats").json() == {
        "rounds": {"count": 0, "open": 0},
        "cards": {"pending": 0, "approved": 0, "rejected": 0},
        "packages": {"done": 0, "active": 0},
        "tasks": {"queued": 0, "dispatched": 0, "reported": 0, "done": 0, "rejected": 0, "timeout": 0},
    }

    _put_draft(client, blk)
    _card(client)
    stats = client.get("/api/p/a/stats").json()
    assert stats["rounds"] == {"count": 0, "open": 1}
    assert stats["cards"]["pending"] == 1

    client.post("/api/p/a/cards/C-0001/approve")
    stats = client.get("/api/p/a/stats").json()
    assert stats["rounds"] == {"count": 1, "open": 2}
    assert stats["cards"]["approved"] == 1
    assert stats["packages"] == {"done": 0, "active": 1}
    assert stats["tasks"]["queued"] == 2

    tasks = client.get("/api/p/a/packages").json()["items"][0]["tasks"]
    for t in tasks:
        client.post(f"/api/p/a/tasks/{t['task_id']}/dispatch", json={"watchdog_minutes": 30})
        client.post(f"/api/p/a/tasks/{t['task_id']}/receipt", json={"self_check": "ok", "summary": "done"})
        client.post(f"/api/p/a/tasks/{t['task_id']}/audit", json={"result": "pass"})
    stats = client.get("/api/p/a/stats").json()
    assert stats["packages"] == {"done": 1, "active": 0}
    assert stats["tasks"]["done"] == 2


# ---------- 验收 5：双项目隔离 ----------


def test_isolation_between_projects(client):
    blk = _setup_project(client, "a")
    _put_draft(client, blk, "a")
    _card(client, slug="a")
    client.post("/api/p/a/cards/C-0001/approve")

    client.post("/api/projects", json={"slug": "b", "name": "项目B"})
    # a 的卡片/版本/轮次/事件/包在 b 中不可见
    assert client.get("/api/p/b/cards").json()["items"] == []
    assert client.get("/api/p/b/rounds").json()["items"] == []
    assert client.get("/api/p/b/events").json()["items"] == []
    assert client.get("/api/p/b/packages").json()["items"] == []
    assert client.get("/api/p/b/stats").json()["cards"]["approved"] == 0
    assert client.get("/api/p/a/blocks/{b}".format(b=blk)).status_code == 200
    assert client.get(f"/api/p/b/blocks/{blk}").status_code == 404
