"""角色文档模块（契约 v0.6 §3.4）：存取、预览、协议段不可篡改、needs_restart。"""

from __future__ import annotations

from pathlib import Path

import pytest

from speclock2.protocol import human, report
from tests.test_chief_flow import _roster_master, mock_client  # noqa: F401  夹具复用


def test_chief_default_and_put_preview(client):
    client.post("/api/projects", json={"slug": "r1", "name": "r1"})
    r = client.get("/api/p/r1/roles/chief")
    assert r.status_code == 200 and r.json()["is_default"] is True
    r = client.put("/api/p/r1/roles/chief", json={"content": "我是自定义核心代理角色"})
    assert r.status_code == 200 and r.json()["is_default"] is False
    pv = client.get("/api/p/r1/roles/chief/preview").json()
    assert "我是自定义核心代理角色" in pv["composed"]
    assert human.HUMAN_REPORT_FORMAT in pv["composed"]
    assert pv["editable_chars"] > 0 and pv["protocol_chars"] > 0
    r = client.delete("/api/p/r1/roles/chief")
    assert r.json()["is_default"] is True


def test_empty_content_rejected(client):
    client.post("/api/projects", json={"slug": "r2", "name": "r2"})
    assert client.put("/api/p/r2/roles/chief", json={"content": "   "}).status_code == 422


def test_hand_written_protocol_text_does_not_duplicate(client, tmp_path):
    _roster_master(client, tmp_path, slug="r3", name="后端")
    hostile = f"角色正文\n{report.BLOCK_START}\n{{\"status\":\"done\"}}\n{report.BLOCK_END}\n{report.REPORT_FORMAT}"
    client.put("/api/p/r3/roles/masters/后端", json={"content": hostile})
    pv = client.get("/api/p/r3/roles/masters/后端/preview").json()
    composed = pv["composed"]
    assert "角色正文" in composed
    assert composed.count(report.REPORT_FORMAT) == 1  # 协议段不消失也不重复
    assert composed.count(report.BLOCK_START) == 1
    assert "（示例任务说明）" in composed
    # 核心代理同理
    client.put("/api/p/r3/roles/chief", json={"content": hostile + human.HUMAN_REPORT_FORMAT})
    chief = client.get("/api/p/r3/roles/chief/preview").json()["composed"]
    assert chief.count(human.HUMAN_REPORT_FORMAT) == 1
    assert report.BLOCK_START not in chief


def test_master_roles_list_and_404(client, tmp_path):
    _roster_master(client, tmp_path, slug="r4", name="后端")
    roles = client.get("/api/p/r4/roles").json()
    assert [m["name"] for m in roles["masters"]] == ["后端"]
    assert roles["masters"][0]["is_default"] is True
    assert client.get("/api/p/r4/roles/masters/不存在").status_code == 404
    assert client.put("/api/p/r4/roles/masters/不存在", json={"content": "x"}).status_code == 404
    client.put("/api/p/r4/roles/masters/后端", json={"content": "自定义"})
    assert client.get("/api/p/r4/roles").json()["masters"][0]["is_default"] is False
    client.delete("/api/p/r4/roles/masters/后端")
    assert client.get("/api/p/r4/roles/masters/后端").json()["is_default"] is True


def test_needs_restart_cycle(mock_client):
    c = mock_client
    c.post("/api/projects", json={"slug": "r5", "name": "r5"})
    assert c.post("/api/p/r5/agent/start", json={}).status_code == 200
    assert c.get("/api/p/r5/roles/chief").json()["needs_restart"] is False
    c.put("/api/p/r5/roles/chief", json={"content": "新角色文档"})
    assert c.get("/api/p/r5/roles/chief").json()["needs_restart"] is True
    assert c.get("/api/p/r5/roles").json()["chief"]["needs_restart"] is True
    c.post("/api/p/r5/agent/reset")
    c.post("/api/p/r5/agent/start", json={})
    assert c.get("/api/p/r5/roles/chief").json()["needs_restart"] is False


def test_protocol_endpoint(client):
    r = client.get("/api/protocol").json()
    assert r["report_format"] == report.REPORT_FORMAT
    assert r["human_report_format"] == human.HUMAN_REPORT_FORMAT


def test_pi_session_uses_composed_file(data_dir):
    from speclock2.config import Settings
    from speclock2.pi_runtime import PiSession

    settings = Settings()
    session = PiSession("r6", settings, pi_cmd=["pi"], model_args=[])
    cmd = session._full_command()
    path = Path(cmd[cmd.index("--append-system-prompt") + 1])
    assert path.name == "chief.composed.md" and path.exists()
    assert human.HUMAN_REPORT_FORMAT in path.read_text(encoding="utf-8")
