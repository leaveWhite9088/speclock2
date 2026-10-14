"""B 阶段：派发执行器全链路——真实进程、遥测回执、批准自动派发、崩溃超时、映射解析。"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from speclock2.harness_map import build_argv, default_map, resolve_harness
from tests.test_s2 import _put_draft, _setup_project

FAKE = Path(__file__).parent.parent / "scripts" / "fake_harness.py"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # 被派发进程在此写文件，测试后清理

WRITTEN_FILES = ["backend/hello-agent.txt", "backend/hello-from-agent.txt"]


@pytest.fixture()
def cleanup_written_files():
    yield
    for name in WRITTEN_FILES:
        p = REPO_ROOT / name
        if p.exists():
            p.unlink()


@pytest.fixture()
def mock_client(data_dir, monkeypatch):
    monkeypatch.setenv("SPECLOCK2_CHIEF_MOCK", "1")
    from speclock2.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


def _write_map(data_dir: Path, masters: dict, extra_args: list[str] | None = None,
               watchdog: float = 60) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {
        "watchdog_minutes_default": watchdog,
        "masters": masters,
        "harnesses": {
            "t": {"command": sys.executable, "args": [str(FAKE), *(extra_args or [])],
                  "prompt_mode": "arg"},
        },
    }
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")


def test_harness_map_build_argv():
    cfg = {"command": "python", "args": ["x.py", "--flag"], "prompt_mode": "arg"}
    assert build_argv(cfg, "做任务") == ["python", "x.py", "--flag", "做任务"]
    inline = {"command": "node", "args": ["cli.js", "-p", "{prompt}"], "prompt_mode": "inline"}
    assert build_argv(inline, "做任务") == ["node", "cli.js", "-p", "做任务"]
    # 默认映射：包含替身 harness 与 master 映射
    default = default_map()
    assert resolve_harness(default, "backend")["prompt_mode"] == "arg"
    assert resolve_harness(default, None)["command"]  # 技术单任务（master 待定）落到默认替身


def test_dispatch_full_flow_with_real_process(mock_client, data_dir, cleanup_written_files):
    """技术单 → 派发执行器：真实 fake_harness 进程跑完 → 回执（files/telemetry）→ audit → done。"""
    _write_map(data_dir, {"backend": "t", "frontend": "t"})
    _setup_project(mock_client)
    order = mock_client.post("/api/p/a/tech-orders", json={
        "intent": "写一个 hello 文件", "scope": ["backend/"], "acceptance": ["文件存在"]}).json()
    pkg_id = order["package_id"]
    task = mock_client.get("/api/p/a/packages").json()["items"][-1]["tasks"][0]

    app = mock_client.app
    from speclock2 import dispatcher

    async def run():
        return await dispatcher.run_task(
            app, "a", int(task["task_id"].split("-")[1]),
            prompt="在 backend/ 下写 hello 文件。FILE: backend/hello-agent.txt",
        )

    result = asyncio.run(run())
    assert result["outcome"] == "reported"
    assert result["files_changed"] == ["backend/hello-agent.txt"]
    assert (REPO_ROOT / "backend" / "hello-agent.txt").exists()  # 被派发进程真实写入了文件

    # 回执落库：任务 reported、receipt 带 files 与 telemetry
    tasks = mock_client.get("/api/p/a/packages").json()["items"][-1]["tasks"]
    assert tasks[0]["status"] == "reported"
    assert tasks[0]["receipt"]["files_changed"] == ["backend/hello-agent.txt"]
    tel = tasks[0]["receipt"].get("telemetry") or {}
    assert tel.get("duration_ms", 0) >= 0
    assert tel.get("token_source") in ("exact", "estimated")
    assert pkg_id.startswith("P-")

    # audit → done（验收：回执到达后人工验收）
    r = mock_client.post(f"/api/p/a/tasks/{task['task_id']}/audit", json={"result": "pass"})
    assert r.json()["status"] == "done"


def test_approve_notifies_chief_and_dispatches(mock_client, data_dir, cleanup_written_files):
    """批准 → 通知 mock 核心代理 → 自动派发全部任务（真实进程）→ 回执到达。"""
    _write_map(data_dir, {"backend": "t", "frontend": "t"})
    blk = _setup_project(mock_client)
    _put_draft(mock_client, blk)
    mock_client.post("/api/p/a/chat", json={
        "message": "起草", "draft": {
            "statement": {"说明": "导出支持 Excel", "动机": "财务需要带格式月报"},
            "rule_ops": [{"block_id": blk, "op": "modify", "id": "R1",
                           "after": {"name": "导出格式", "detail": "CSV 与 Excel"}}],
            "api_ops": []}})
    r = mock_client.post("/api/p/a/cards/C-0001/approve")
    assert r.status_code == 200

    # 派发是 fire-and-forget：轮询等两任务都 reported
    deadline = time.time() + 30
    while time.time() < deadline:
        tasks = [t for p in mock_client.get("/api/p/a/packages").json()["items"]
                 for t in p["tasks"]]
        statuses = {t["task_id"]: t["status"] for t in tasks}
        if statuses and all(s in ("reported", "done", "rejected", "timeout") for s in statuses.values()):
            break
        time.sleep(0.3)
    assert all(t["status"] == "reported" for t in tasks), statuses
    assert all(t["receipt"] for t in tasks)  # 回执都到了
    # 核心代理的派发汇报也进了对话事件（chat.chief）
    chiefs = mock_client.get("/api/p/a/events", params={"type": "chat.chief"}).json()["items"]
    assert any("已派发" in e["payload"]["message"] for e in chiefs)


def test_crashed_process_times_out_via_watchdog(mock_client, data_dir):
    """主代理进程崩溃（exit 1）不回执 → 看门狗标 timeout + task.timeout 事件。"""
    _write_map(data_dir, {"backend": "t", "frontend": "t"}, extra_args=["--fail"], watchdog=0.05)
    _setup_project(mock_client)
    order = mock_client.post("/api/p/a/tech-orders", json={
        "intent": "必然失败的任务", "scope": ["backend/"], "acceptance": []}).json()
    task = mock_client.get("/api/p/a/packages").json()["items"][-1]["tasks"][0]

    app = mock_client.app
    from speclock2 import dispatcher

    async def run():
        return await dispatcher.run_task(app, "a", 1, prompt="干一件会崩的事")

    result = asyncio.run(run())
    assert result["outcome"] == "crashed"
    assert result["exit_code"] == 1

    # 看门狗 ~3 秒后触发（0.05 分钟）
    deadline = time.time() + 15
    status = None
    while time.time() < deadline:
        tasks = [t for p in mock_client.get("/api/p/a/packages").json()["items"] for t in p["tasks"]]
        status = [t for t in tasks if t["task_id"] == task["task_id"]][0]["status"]
        if status == "timeout":
            break
        time.sleep(0.5)
    assert status == "timeout"
    timeouts = mock_client.get("/api/p/a/events", params={"type": "task.timeout"}).json()["items"]
    assert timeouts and timeouts[0]["ref"]["task"] == task["task_id"]
    assert order["order_id"].startswith("O-")
