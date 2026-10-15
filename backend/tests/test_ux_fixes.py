"""修复单：provider 校验 / 派发幂等 / 会话按目录过滤 / audit-all。"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from speclock2 import models
from speclock2.utils import now_iso, parse_prefixed_id
from tests.test_s2 import _setup_project

FAKE = Path(__file__).parent.parent / "scripts" / "fake_harness.py"


@pytest.fixture()
def mock_client(data_dir, monkeypatch):
    monkeypatch.setenv("SPECLOCK2_CHIEF_MOCK", "1")
    from speclock2.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


# ---------- 1. provider 校验 + 迁移修正 ----------


def test_register_model_provider_validation(client):
    # 非法 provider（mcode 自己的供应商名不是 pi 供应商）→ 422 带合法值清单
    r = client.post("/api/models", json={
        "harness": "mcode", "model": "MiniMax-M3", "provider": "minimax"})
    assert r.status_code == 422 and "minimax-cn" in r.json()["message"]
    # 合法 provider → 201
    r = client.post("/api/models", json={
        "harness": "mcode", "model": "MiniMax-M3", "provider": "minimax-cn"})
    assert r.status_code == 201 and r.json()["provider"] == "minimax-cn"
    # 空 provider 合法（只作 harness 绑定）
    assert client.post("/api/models", json={
        "harness": "pi", "model": "glm-4.7", "provider": ""}).status_code == 201


def test_migration_fixes_invalid_provider(client):
    """存量坏值（provider=minimax）启动迁移自动修成 minimax-cn。"""
    import sqlite3

    conn = sqlite3.connect(client.app.state.db.settings.registry_path)
    conn.execute(
        "INSERT INTO model_entries (harness, model, provider, created_at) VALUES (?, ?, ?, ?)",
        ("mcode", "MiniMax-M3", "minimax", now_iso()))
    conn.commit()
    conn.close()
    from speclock2.app import create_app

    with TestClient(create_app()) as c2:
        items = {i["model"]: i for i in c2.get("/api/models").json()["items"]}
        assert items["MiniMax-M3"]["provider"] == "minimax-cn"


def test_agent_model_strips_source_prefix(mock_client):
    """登记里带来源前缀的 model（minimax/MiniMax-M3）切给 pi 时剥成 modelId。"""
    _setup_project(mock_client, slug="pf")
    mock_client.post("/api/p/pf/agent/start", json={})
    r = mock_client.post("/api/p/pf/agent/model",
                         json={"provider": "minimax-cn", "model": "minimax/MiniMax-M3"})
    assert r.status_code == 200
    assert r.json()["model"] == "minimax-cn/MiniMax-M3"  # 不是 minimax-cn/minimax/MiniMax-M3
    assert mock_client.get("/api/p/pf/agent").json()["model"] == "minimax-cn/MiniMax-M3"


# ---------- 2. 派发幂等 ----------


def test_dispatch_idempotent_on_reported(client, data_dir, tmp_path):
    _setup_project(client, slug="idem")
    repo = tmp_path / "idem-repo"
    repo.mkdir()
    client.patch("/api/p/idem", json={"working_dir": str(repo)})
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {"watchdog_minutes_default": 60, "masters": {"backend": "t"},
           "harnesses": {"t": {"command": sys.executable, "args": [str(FAKE), "--plain"],
                               "prompt_mode": "arg", "output": "text"}}}
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    client.post("/api/p/idem/tech-orders", json={
        "intent": "hello", "scope": ["./"], "acceptance": [], "master": "backend"})
    task_id = client.get("/api/p/idem/packages").json()["items"][-1]["tasks"][-1]["task_id"]
    # 先正常派发到 reported
    from speclock2 import dispatcher

    r1 = asyncio.run(dispatcher.run_task(client.app, "idem", parse_prefixed_id(task_id, "T"),
                                         "只回复一个词：hello"))
    assert r1["outcome"] == "reported"
    # 再 dispatch（endpoint 与执行器两条路都应跳过、无副作用）
    r2 = client.post(f"/api/p/idem/tasks/{task_id}/dispatch", json={"watchdog_minutes": 60})
    assert r2.status_code == 200
    body = r2.json()
    assert body["skipped"] is True and "reported" in body["reason"]
    r3 = asyncio.run(dispatcher.run_task(client.app, "idem", parse_prefixed_id(task_id, "T"),
                                         "只回复一个词：hello"))
    assert r3["outcome"] == "skipped" and "reported" in r3["reason"]


def test_chief_dispatch_tool_reports_skipped():
    """TS 工具收到 skipped 响应时不 spawn——源码级检查（工具早退分支）。"""
    src = (Path(__file__).parent.parent.parent / "chief" / "extension" / "index.ts").read_text(
        encoding="utf-8")
    assert "dispatchRes.skipped" in src
    assert "无需重复派发" in src


# ---------- 3. 会话按目录过滤 ----------


def test_cli_sessions_cwd_filter(client, tmp_path, monkeypatch):
    # pi：头行 cwd
    pi_root = tmp_path / "pi-sess"
    pi_root.mkdir(parents=True)
    pi_sess = pi_root / "20261015_a.jsonl"
    pi_sess.write_text(json.dumps({
        "type": "session", "version": 3, "id": "pi-in-proj", "cwd": "D:/work/proj"}) + "\n",
        encoding="utf-8")
    monkeypatch.setenv("SPECLOCK2_PI_SESSIONS_DIR", str(pi_root))
    # mcode：cwd 在 messages 头部
    mm_root = tmp_path / "mm-sess"
    sess_dir = mm_root / "2026" / "10" / "15" / "03-00-00-000-session_x1"
    sess_dir.mkdir(parents=True)
    (sess_dir / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs-in-mcodetest", "createdAtMs": 1}), encoding="utf-8")
    (sess_dir / "messages.jsonl").write_text(
        '{"message":{"role":"user","content":[{"type":"text","text":"'
        '<agent-context>  cwd: D:\\\\work\\\\mcodetest </agent-context>"}]}}\n',
        encoding="utf-8")
    monkeypatch.setenv("SPECLOCK2_MCODE_SESSIONS_DIR", str(mm_root))

    all_ids = [i["id"] for i in client.get("/api/cli-sessions").json()["items"]]
    assert "pi-in-proj" in all_ids and "mvs-in-mcodetest" in all_ids
    # 按目录过滤：各回各家
    proj = [i["id"] for i in client.get("/api/cli-sessions",
                                        params={"cwd": "d:/work/proj"}).json()["items"]]
    assert proj == ["pi-in-proj"]
    mcode = [i["id"] for i in client.get(
        "/api/cli-sessions", params={"cwd": "D:\\work\\mcodetest"}).json()["items"]]
    assert mcode == ["mvs-in-mcodetest"]
    # 无关目录 → 空
    assert client.get("/api/cli-sessions", params={"cwd": "D:/elsewhere"}).json()["items"] == []


# ---------- 4. audit-all ----------


def test_audit_all(client):
    _setup_project(client, slug="aa")
    with client.app.state.db.ledger_session("aa") as s:
        for status in ("reported", "reported", "queued", "done"):
            pkg = models.TaskPackage(origin="tech", round=0, version_refs={},
                                     created_at=now_iso())
            s.add(pkg)
            s.flush()
            s.add(models.Task(package_id=pkg.id, master="backend", status=status,
                              created_at=now_iso(), updated_at=now_iso()))
        s.commit()
    r = client.post("/api/p/aa/audit-all", json={"result": "pass", "note": "一键清理"})
    assert r.status_code == 200
    body = r.json()
    assert body["audited"] == 2 and len(body["task_ids"]) == 2
    statuses = [t["status"] for p in client.get("/api/p/aa/packages").json()["items"]
                for t in p["tasks"]]
    assert statuses.count("reported") == 0
    assert statuses.count("done") == 3  # 原有 1 + 清理 2
    # result 非法 → 422；无 reported → 0
    assert client.post("/api/p/aa/audit-all", json={"result": "x"}).status_code == 422
    assert client.post("/api/p/aa/audit-all", json={"result": "pass"}).json()["audited"] == 0
