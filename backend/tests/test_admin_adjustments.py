"""调整单：项目删除、主代理编辑/删除、登记 provider、过程输出通道。"""

from __future__ import annotations

import asyncio
import json
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


# ---------- 1. 删除项目 ----------


def test_delete_project(client, tmp_path):
    repo = tmp_path / "del-repo"
    repo.mkdir()
    r = client.post("/api/projects", json={
        "slug": "gone", "name": "待删", "working_dir": str(repo)})
    assert r.status_code == 201
    ledger = client.app.state.db.settings.ledger_path("gone")
    assert ledger.exists()

    r = client.delete("/api/projects/gone")
    assert r.status_code == 200 and r.json()["ok"] is True
    # 注册表 404；账本改名 .deleted 保留
    assert "gone" not in [p["slug"] for p in client.get("/api/projects").json()["items"]]
    assert client.get("/api/p/gone").status_code == 404
    assert not ledger.exists()
    assert ledger.with_suffix(".db.deleted").exists()
    # 再删 → 404
    assert client.delete("/api/projects/gone").status_code == 404


# ---------- 2/3. 主代理编辑与删除 ----------


def _mk_master(client: TestClient, name: str = "后端", **kw) -> dict:
    r = client.post("/api/projects", json={"slug": "ad", "name": "项目AD"})
    assert r.status_code in (201, 409)  # 首建或已存在
    from speclock2.utils import now_iso

    with client.app.state.db.ledger_session("ad") as s:
        row = models.Master(name=name, role=kw.get("duty", "职责"), harness="pi",
                            model=kw.get("model", "glm-4.7"),
                            provider=kw.get("provider"),
                            working_dir=kw.get("dir", "."),
                            created_at=now_iso())
        s.add(row)
        s.commit()
        return {"id": str(row.id), "name": row.name}


def test_patch_master(client):
    m = _mk_master(client, "旧名")
    # 改名 + 职责 + 目录
    r = client.patch("/api/p/ad/masters/" + m["id"],
                     json={"name": "新名", "duty": "新职责", "dir": "web/"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "新名" and body["duty"] == "新职责" and body["dir"] == "web/"
    # 未传字段不动
    assert body["model"] == "glm-4.7"
    # 同名冲突 → 409
    _mk_master(client, "另一个")
    r = client.patch("/api/p/ad/masters/" + m["id"], json={"name": "另一个"})
    assert r.status_code == 409
    # 改名成自己 → 放行
    assert client.patch("/api/p/ad/masters/" + m["id"],
                        json={"name": "新名"}).status_code == 200
    # 空 name → 422；不存在 → 404
    assert client.patch("/api/p/ad/masters/" + m["id"], json={"name": " "}).status_code == 422
    assert client.patch("/api/p/ad/masters/999", json={"name": "x"}).status_code == 404


def test_patch_master_binding_validation(client):
    m = _mk_master(client, "校验")
    # 未登记的 harness×model → 422
    r = client.patch("/api/p/ad/masters/" + m["id"],
                     json={"harness": "pi", "model": "未登记"})
    assert r.status_code == 422 and "未在「模型」登记" in r.json()["message"]
    # 登记后（带 provider）→ 通过且 provider 跟随登记
    client.post("/api/models", json={
        "harness": "pi", "model": "MiniMax-M3", "provider": "minimax-cn"})
    r = client.patch("/api/p/ad/masters/" + m["id"],
                     json={"harness": "pi", "model": "MiniMax-M3"})
    assert r.status_code == 200
    assert r.json()["provider"] == "minimax-cn"
    # 旧全串写法也能匹配登记（provider/model 组合）
    r = client.patch("/api/p/ad/masters/" + m["id"], json={"model": "minimax-cn/MiniMax-M3"})
    assert r.status_code == 200
    assert r.json()["model"] == "minimax-cn/MiniMax-M3"


def test_delete_master(client):
    m = _mk_master(client, "待删")
    # 在跑任务 → 409
    with client.app.state.db.ledger_session("ad") as s:
        pkg = models.TaskPackage(origin="tech", round=0, version_refs={}, created_at=now_iso())
        s.add(pkg)
        s.flush()
        s.add(models.Task(package_id=pkg.id, master="待删", status="dispatched",
                          created_at=now_iso(), updated_at=now_iso()))
        s.commit()
    r = client.delete("/api/p/ad/masters/" + m["id"])
    assert r.status_code == 409 and "在跑" in r.json()["message"]
    # queued 不拦（不在守卫列表）
    with client.app.state.db.ledger_session("ad") as s:
        t = s.query(models.Task).filter_by(master="待删").first()
        t.status = "queued"
        s.commit()
    assert client.delete("/api/p/ad/masters/" + m["id"]).status_code == 200
    assert client.get("/api/p/ad/masters").json()["items"] == []
    # 再删 → 404
    assert client.delete("/api/p/ad/masters/" + m["id"]).status_code == 404


# ---------- 4. 模型登记 provider ----------


def test_model_registry_provider_and_migration(client):
    # 带 provider 登记
    r = client.post("/api/models", json={
        "harness": "pi", "model": "MiniMax-M3", "provider": "minimax-cn"})
    assert r.status_code == 201
    assert r.json()["provider"] == "minimax-cn"
    # 无 provider 登记（旧形态）
    r = client.post("/api/models", json={"harness": "codex", "model": "gpt-5.2"})
    assert r.json()["provider"] == ""
    items = {i["model"]: i for i in client.get("/api/models").json()["items"]}
    assert items["MiniMax-M3"]["provider"] == "minimax-cn"
    assert items["gpt-5.2"]["provider"] == ""


def test_model_entry_migration_splits_prefix(client, tmp_path):
    """老库迁移：model 带 provider/model 前缀 → 拆出 provider。"""
    # 直接以旧形态写库，再触发迁移（init_registry 在 create_app 时执行）
    import sqlite3

    db_path = client.app.state.db.settings.registry_path
    conn = sqlite3.connect(db_path)
    conn.execute(
        "INSERT INTO model_entries (harness, model, provider, created_at) VALUES (?, ?, NULL, ?)",
        ("mcode", "minimax/MiniMax-M3", now_iso()))
    conn.execute(
        "INSERT INTO model_entries (harness, model, provider, created_at) VALUES (?, ?, NULL, ?)",
        ("pi", "glm-4.7", now_iso()))
    conn.commit()
    conn.close()
    # 二次 create_app（同数据目录）→ 启动迁移跑一遍
    from speclock2.app import create_app

    with TestClient(create_app()) as c2:
        items = {i["model"]: i for i in c2.get("/api/models").json()["items"]}
        # 前缀拆出 provider=minimax；mcode 方言原样保留（修复单 21 分治，不再刷成 minimax-cn）
        assert items["MiniMax-M3"]["provider"] == "minimax"
        assert items["glm-4.7"]["provider"] == ""            # 无前缀置空


def test_create_master_with_provider(client):
    _setup_project(client, slug="ad2")
    client.post("/api/models", json={
        "harness": "mcode", "model": "MiniMax-M3", "provider": "minimax-cn"})
    body = {"name": "m主代理", "duty": "d", "dir": ".", "harness": "mcode",
            "model": "MiniMax-M3", "provider": "minimax-cn"}
    # 会话必选（同创建校验）
    r = client.post("/api/p/ad2/masters", json={**body, "session": ""})
    assert r.status_code == 422
    # 用 pi 会话清单造一个（探测接口与 harness 无关，见 cli_sessions 测试）
    import os

    root = Path(os.environ["SPECLOCK2_MCODE_SESSIONS_DIR"]) / "d"
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs_prov000000000000000000000000", "createdAtMs": 1}), encoding="utf-8")
    r = client.post("/api/p/ad2/masters", json={**body, "session": "mvs_prov000000000000000000000000"})
    assert r.status_code == 201, r.text
    assert r.json()["provider"] == "minimax-cn"


# ---------- 5. 过程输出通道 ----------


def test_output_tail_streams_during_dispatch(client, data_dir, tmp_path):
    """纯文本替身分阶段输出：派发期间 output_tail 增长，结束后含 FILES 行。"""
    _setup_project(client, slug="ot")
    repo = tmp_path / "ot-repo"
    repo.mkdir()
    client.patch("/api/p/ot", json={"working_dir": str(repo)})
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {"watchdog_minutes_default": 60, "masters": {"backend": "t"},
           "harnesses": {"t": {"command": sys.executable, "args": [str(FAKE), "--plain"],
                               "prompt_mode": "arg", "output": "text"}}}
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    order = client.post("/api/p/ot/tech-orders", json={
        "intent": "hello", "scope": ["./"], "acceptance": [], "master": "backend"}).json()
    task_id = client.get("/api/p/ot/packages").json()["items"][-1]["tasks"][-1]["task_id"]

    from speclock2 import dispatcher

    async def run():
        task = asyncio.create_task(dispatcher.run_task(
            client.app, "ot", parse_prefixed_id(task_id, "T"), "只回复一个词：hello"))
        # 替身首行立即可见、其余在 2.5s 后：中途应只有第一阶段行（增量）
        await asyncio.sleep(1.0)
        with client.app.state.db.ledger_session("ot") as s:
            row = s.get(models.Task, parse_prefixed_id(task_id, "T"))
            mid_tail = row.output_tail or ""
        assert "已收到任务" in mid_tail and "FILES:" not in mid_tail  # 运行中：尾部在长
        return await task

    result = asyncio_run(run())
    assert result["outcome"] == "reported"
    detail = [t for p in client.get("/api/p/ot/packages").json()["items"]
              for t in p["tasks"] if t["task_id"] == task_id][0]
    tail = detail["output_tail"]
    assert "已收到任务" in tail and "FILES:" in tail  # 阶段行 + 收尾行都进了尾部
    assert len(tail) <= 4096


def test_output_endpoint_appends_and_broadcasts(mock_client):
    """POST /tasks/{id}/output：追加 tail + 向 chief 会话订阅者广播 master_output。"""
    _setup_project(mock_client, slug="ob")
    order = mock_client.post("/api/p/ob/tech-orders", json={
        "intent": "x", "scope": ["./"], "acceptance": []}).json()
    task_id = mock_client.get("/api/p/ob/packages").json()["items"][-1]["tasks"][-1]["task_id"]
    mock_client.post("/api/p/ob/agent/start", json={})  # mock 会话：广播有接收方
    session = mock_client.app.state.pi.get("ob")
    q = session.subscribe()

    r = mock_client.post(f"/api/p/ob/tasks/{task_id}/output", json={"text": "阶段1\n"})
    assert r.status_code == 200
    mock_client.post(f"/api/p/ob/tasks/{task_id}/output", json={"text": "阶段2\n"})

    events = []
    while not q.empty():
        events.append(q.get_nowait())
    outs = [e for e in events if e["event"] == "master_output"]
    assert [e["data"]["text"] for e in outs] == ["阶段1\n", "阶段2\n"]
    assert outs[0]["data"]["task_id"] == task_id

    detail = [t for p in mock_client.get("/api/p/ob/packages").json()["items"]
              for t in p["tasks"] if t["task_id"] == task_id][0]
    assert detail["output_tail"] == "阶段1\n阶段2\n"


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)
