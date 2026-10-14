"""S0 验收流程测试：健康检查、注册表、独立账本、草稿往返、物理隔离、桩端点、错误 envelope。"""

from __future__ import annotations

import re

from speclock2.utils import is_iso


def _make_project(client, slug: str, name: str) -> dict:
    resp = client.post("/api/projects", json={"slug": slug, "name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _make_document_chain(client, slug: str) -> dict:
    """在项目中创建 domain → document → block，返回三层对象。"""
    dom = client.post(f"/api/p/{slug}/domains", json={"title": "日报业务"}).json()
    doc = client.post(
        f"/api/p/{slug}/documents", json={"domain_id": dom["id"], "title": "导出需求"}
    ).json()
    blk = client.post(
        f"/api/p/{slug}/blocks", json={"document_id": doc["id"], "title": "导出模块"}
    ).json()
    return {"domain": dom, "document": doc, "block": blk}


def test_health(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_create_projects_makes_isolated_ledger_files(client, data_dir):
    _make_project(client, "a", "项目A")
    _make_project(client, "b", "项目B")
    ledgers = data_dir / "ledgers"
    assert (ledgers / "a.db").exists()
    assert (ledgers / "b.db").exists()
    assert (data_dir / "registry.db").exists()

    items = client.get("/api/projects").json()["items"]
    assert [p["slug"] for p in items] == ["a", "b"]
    assert all(p["status"] == "active" for p in items)
    assert all(is_iso(p["created_at"]) for p in items)  # ISO 8601 带时区


def test_slug_conflict_409(client):
    _make_project(client, "a", "项目A")
    resp = client.post("/api/projects", json={"slug": "a", "name": "又一个A"})
    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "conflict"
    assert "message" in body


def test_project_detail_initial_state(client):
    _make_project(client, "a", "项目A")
    resp = client.get("/api/p/a")
    assert resp.status_code == 200
    body = resp.json()
    assert body["slug"] == "a"
    assert body["name"] == "项目A"
    assert body["current_round"] == 0
    assert body["open_card"] is None


def test_document_chain_and_draft_roundtrip(client):
    _make_project(client, "a", "项目A")
    chain = _make_document_chain(client, "a")

    blk = chain["block"]
    assert isinstance(chain["domain"]["id"], str)  # 对外 id 一律字符串
    assert blk["status"] == "draft"
    assert blk["current_published_version"] is None
    assert blk["versions"] == []
    assert blk["draft"] == {"content_md": "", "rules": [], "apis": [], "nfr_md": ""}

    draft = {
        "content_md": "# 背景\n日报导出",
        "rules": [{"name": "导出格式", "detail": "支持 CSV 与 Excel"}],  # 无 id：S1 起由服务端分配
        "apis": [
            {
                "name": "导出",
                "api": "GET /api/daily-report",
                "desc": "日报导出",
                "request": [],
                "response": [],
            }
        ],
        "nfr_md": "导出 1 秒内完成",
    }
    resp = client.put(f"/api/p/a/blocks/{blk['id']}", json=draft)
    assert resp.status_code == 200
    assert resp.json()["versions"] == []  # PUT 只存草稿，不产生版本

    got = client.get(f"/api/p/a/blocks/{blk['id']}").json()
    expected_rules = [{"id": "R1", "name": "导出格式", "detail": "支持 CSV 与 Excel"}]
    assert got["draft"] == {**draft, "rules": expected_rules}  # 回读一致，规则带分配的 id
    assert got["status"] == "draft"
    assert got["versions"] == []

    # 部分更新：只改 content_md，其余草稿字段保留（含已分配的规则 id）
    resp = client.put(f"/api/p/a/blocks/{blk['id']}", json={"content_md": "# 新背景"})
    assert resp.status_code == 200
    updated = resp.json()["draft"]
    assert updated["content_md"] == "# 新背景"
    assert updated["rules"] == expected_rules
    assert updated["apis"] == draft["apis"]


def test_tree_three_layers_and_isolation(client):
    _make_project(client, "a", "项目A")
    _make_project(client, "b", "项目B")
    _make_document_chain(client, "a")

    tree_a = client.get("/api/p/a/tree").json()
    assert len(tree_a["items"]) == 1
    domain_node = tree_a["items"][0]
    assert domain_node["title"] == "日报业务"
    assert len(domain_node["documents"]) == 1
    block_node = domain_node["documents"][0]["blocks"][0]
    assert block_node["status"] == "draft"
    assert "current_published_version" in block_node

    # b 的树为空：一项目一账本，物理隔离雏形
    tree_b = client.get("/api/p/b/tree").json()
    assert tree_b == {"items": []}
    # a 的模块 id 在 b 中查不到
    resp = client.get("/api/p/b/blocks/1")
    assert resp.status_code == 404


def test_all_stub_endpoints_return_501(client):
    _make_project(client, "a", "项目A")
    stubs = [
        ("post", "/api/p/a/cards"),
        ("get", "/api/p/a/cards"),
        ("post", "/api/p/a/cards/C-0001/approve"),
        ("post", "/api/p/a/cards/C-0001/reject"),
        ("get", "/api/p/a/rounds"),
        ("get", "/api/p/a/rounds/1"),
        ("get", "/api/p/a/events"),
        ("get", "/api/p/a/packages"),
        ("post", "/api/p/a/tasks/T-0001/receipt"),
        ("get", "/api/p/a/conventions"),
        ("put", "/api/p/a/conventions/draft"),
        ("post", "/api/p/a/conventions/approve"),
    ]
    for method, path in stubs:
        if method in ("post", "put"):
            resp = getattr(client, method)(path, json={})
        else:
            resp = getattr(client, method)(path)
        assert resp.status_code == 501, f"{method.upper()} {path} -> {resp.status_code}"
        body = resp.json()
        assert body["code"] == "not_implemented"
        assert isinstance(body["message"], str) and body["message"]


def test_404_envelopes(client):
    _make_project(client, "a", "项目A")
    # 项目不存在
    resp = client.get("/api/p/nope")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"
    # 模块不存在
    resp = client.get("/api/p/a/blocks/999")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"
    # 引用不存在的 domain
    resp = client.post("/api/p/a/documents", json={"domain_id": "999", "title": "x"})
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"


def test_validation_422(client):
    # 缺 name
    resp = client.post("/api/projects", json={"slug": "a"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"
    # 非法 slug（含路径分隔符，防路径穿越）
    resp = client.post("/api/projects", json={"slug": "../evil", "name": "x"})
    assert resp.status_code == 422
    # domain_id 非数字
    _make_project(client, "a", "项目A")
    resp = client.post("/api/p/a/documents", json={"domain_id": "abc", "title": "x"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "validation_error"
    # 未知路径也是 envelope
    resp = client.get("/api/unknown")
    assert resp.status_code == 404
    assert resp.json()["code"] == "not_found"
