"""chat/agent 端点（mock 模式全链路）：对话入库、draft 起草、SSE、agent 启停。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tests.test_s2 import _put_draft, _setup_project


@pytest.fixture()
def mock_client(data_dir, monkeypatch):
    monkeypatch.setenv("SPECLOCK2_CHIEF_MOCK", "1")
    from speclock2.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


def _setup(mock_client) -> str:
    return _setup_project(mock_client)


def test_chat_roundtrip_and_events(mock_client):
    _setup(mock_client)
    resp = mock_client.post("/api/p/a/chat", json={"message": "我需要导出支持 Excel"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "收到需求" in body["reply"]

    # 对话入库可回放（A5：对话流是事件日志的投影）
    human = mock_client.get("/api/p/a/events", params={"type": "chat.human"}).json()["items"]
    assert len(human) == 1
    assert human[0]["payload"]["message"] == "我需要导出支持 Excel"
    assert human[0]["actor"] == "human"
    chief = mock_client.get("/api/p/a/events", params={"type": "chat.chief"}).json()["items"]
    assert len(chief) == 1
    assert chief[0]["actor"] == "chief"
    assert chief[0]["payload"]["message"] == body["reply"]

    # 对话开启轮次
    assert mock_client.get("/api/p/a").json()["current_round"] == 1
    # 空消息 → 422
    assert mock_client.post("/api/p/a/chat", json={"message": "  "}).status_code == 422
    # 项目不存在 → 404
    assert mock_client.post("/api/p/nope/chat", json={"message": "x"}).status_code == 404


def test_chat_with_draft_creates_card(mock_client):
    blk = _setup(mock_client)
    _put_draft(mock_client, blk)
    resp = mock_client.post("/api/p/a/chat", json={
        "message": "请把这轮变更起草成卡片",
        "draft": {
            "statement": {"说明": "导出支持 Excel", "动机": "财务需要带格式月报"},
            "rule_ops": [{"block_id": blk, "op": "modify", "id": "R1",
                           "after": {"name": "导出格式", "detail": "CSV 与 Excel"}}],
            "api_ops": [],
        },
    })
    assert resp.status_code == 200, resp.text
    assert "C-0001" in resp.json()["reply"]

    # 卡片真实落库（模拟 draft_card 工具效果），状态 pending，draft.proposed 由 chief 产出
    cards = mock_client.get("/api/p/a/cards", params={"status": "pending"}).json()["items"]
    assert len(cards) == 1
    assert cards[0]["statement"]["说明"] == "导出支持 Excel"
    proposed = mock_client.get("/api/p/a/events", params={"type": "draft.proposed"}).json()["items"]
    assert proposed[0]["actor"] == "chief"

    # 非法 draft（statement 缺动机）→ 422，卡片不落库
    resp = mock_client.post("/api/p/a/chat", json={
        "message": "再起草一张", "draft": {"statement": {"说明": "x"}}})
    assert resp.status_code == 422
    assert len(mock_client.get("/api/p/a/cards").json()["items"]) == 1


# SSE 端点（无限流）不适合同步 TestClient：HTTP 层连通性由实机自检（curl -N）验证，
# delta/final/card_proposed 的广播链由 tests/test_pi_framing.py 的订阅者单测覆盖。


def test_agent_endpoints(mock_client):
    _setup(mock_client)
    # 未启动（chief 为生效配置：测试环境无 env 配置 → source=env、值空）
    status = mock_client.get("/api/p/a/agent").json()
    assert status == {"running": False, "model": None, "context_usage_percent": None,
                      "session_id": "speclock2-a",
                      "chief": {"provider": None, "model": None, "source": "env"}}
    # 启动（幂等）
    r = mock_client.post("/api/p/a/agent/start", json={})
    assert r.status_code == 200
    assert r.json()["running"] is True
    assert r.json()["model"] == "mock"
    assert mock_client.post("/api/p/a/agent/start", json={}).status_code == 200  # 幂等
    # 状态：mock 的 context_usage_percent 恒 0
    status = mock_client.get("/api/p/a/agent").json()
    assert status["running"] is True
    assert status["context_usage_percent"] == 0
    assert status["session_id"] == "mock-a"
    # 停止
    assert mock_client.post("/api/p/a/agent/stop").json()["running"] is False
    assert mock_client.get("/api/p/a/agent").json()["running"] is False
