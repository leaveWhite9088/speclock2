"""调整单（S2-fix）：版本快照端点 GET /blocks/{id}/versions/{version}。"""

from __future__ import annotations

from tests.test_s2 import _card, _put_draft, _setup_project


def test_version_snapshot_endpoint(client):
    blk = _setup_project(client)
    _put_draft(client, blk)

    # draft：返回当前草稿
    r = client.get(f"/api/p/a/blocks/{blk}/versions/draft")
    assert r.status_code == 200
    data = r.json()
    assert data["block_id"] == blk
    assert data["version"] == "draft"
    assert data["statement"] is None
    assert data["delta_summary"] is None
    assert data["draft"]["rules"][0]["id"] == "R1"

    # 批准产生 1..0 后：历史版本可回读，四件套 + statement/round/delta_summary 齐全
    _card(client, rule_ops=[{"block_id": blk, "op": "modify", "id": "R1",
                              "after": {"name": "导出格式", "detail": "CSV 与 Excel"}}])
    client.post("/api/p/a/cards/C-0001/approve")

    r = client.get(f"/api/p/a/blocks/{blk}/versions/1.0.0")
    assert r.status_code == 200
    snap = r.json()
    assert snap["version"] == "1.0.0"
    assert snap["round"] == 1
    assert snap["statement"]["说明"] == "导出支持 Excel"
    assert snap["delta_summary"]  # 中文摘要非空
    assert snap["draft"]["rules"][0]["detail"] == "CSV 与 Excel"
    assert snap["draft"]["apis"][0]["api"] == "GET /api/daily-report"

    # 批准后再改草稿：draft 与 1.0.0 快照分离（快照不可变）
    client.put(f"/api/p/a/blocks/{blk}", json={"content_md": "# 新背景"})
    fresh = client.get(f"/api/p/a/blocks/{blk}/versions/draft").json()
    assert fresh["draft"]["content_md"] == "# 新背景"
    frozen = client.get(f"/api/p/a/blocks/{blk}/versions/1.0.0").json()
    assert frozen["draft"]["content_md"] == "# 背景"

    # 不存在的版本 → 404 envelope
    r = client.get(f"/api/p/a/blocks/{blk}/versions/9.9.9")
    assert r.status_code == 404
    assert r.json()["code"] == "not_found"
