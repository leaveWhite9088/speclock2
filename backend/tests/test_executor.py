"""阶段 C：执行器合并（契约 v0.6）——dispatch-package、tasks/{id}/run、失败路径、关闭收尸。"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tests.test_chief_flow import _fake_pi_session, _roster_master, mock_client  # noqa: F401
from tests.test_dispatch import FAKE
from tests.test_s2 import _setup_project

SRC = Path(__file__).parent.parent / "speclock2"


def _map(data_dir: Path, args: list[str], command: str | None = None, watchdog: float = 60) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {
        "watchdog_minutes_default": watchdog,
        "masters": {},
        "harnesses": {"sl2-fake": {"command": command or sys.executable,
                                   "args": [str(FAKE), *args], "prompt_mode": "arg"}},
    }
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")


def _two_masters(client, tmp_path: Path, slug: str = "ex") -> Path:
    _roster_master(client, tmp_path, slug=slug, name="后端")
    r = client.post(f"/api/p/{slug}/masters", json={
        "name": "前端", "duty": "测试", "dir": ".", "harness": "sl2-fake",
        "model": "fake-m", "session": "pi-chief-flow"})
    assert r.status_code in (200, 201), r.text
    repo = tmp_path / "bound"
    repo.mkdir()
    assert client.patch(f"/api/p/{slug}", json={"working_dir": str(repo)}).status_code == 200
    return repo


def _wait_reports(client, slug: str, n: int, timeout: float = 30) -> list[dict]:
    deadline = time.time() + timeout
    items: list[dict] = []
    while time.time() < deadline:
        items = client.get(f"/api/p/{slug}/events", params={"type": "task.report"}).json()["items"]
        if len(items) >= n:
            break
        time.sleep(0.2)
    return items


def _package_body(*masters: str) -> dict:
    return {"intent": "并行写文件", "tasks": [
        {"master": m, "instructions": f"FILE: out-{i}.txt", "scope": ["./"], "acceptance": ["文件存在"]}
        for i, m in enumerate(masters)]}


def test_two_masters_run_in_parallel(mock_client, data_dir, tmp_path, monkeypatch):
    _map(data_dir, ["--sleep", "2"])
    repo = _two_masters(mock_client, tmp_path)
    notices: list[str] = []
    from speclock2 import chief_notify

    monkeypatch.setattr(chief_notify, "enqueue", lambda app, slug, text: notices.append(text))
    started = time.time()
    r = mock_client.post("/api/p/ex/dispatch-package", json=_package_body("后端", "前端"))
    assert r.status_code == 201, r.text
    assert time.time() - started < 1.5  # 立即返回，不等进程
    body = r.json()
    assert body["package_id"].startswith("P-") and body["order_id"].startswith("O-")
    assert [t["status"] for t in body["tasks"]] == ["dispatched", "dispatched"]

    items = _wait_reports(mock_client, "ex", 2)
    assert len(items) == 2
    assert time.time() - started < 3.9  # 两个 2 秒任务并行，总时长小于串行之和
    for e in items:
        p = e["payload"]
        assert p["status"] == "done" and p["parse_quality"] == "structured"
        assert p["files_changed"] and p["token_source"] in ("exact", "estimated")
    assert (repo / "out-0.txt").exists() and (repo / "out-1.txt").exists()
    assert len([n for n in notices if "系统通知" in n]) == 2

    pk = mock_client.get("/api/p/ex/packages").json()["items"][-1]
    assert all(t["status"] == "reported" for t in pk["tasks"])
    assert all(t["receipt"]["report"]["parse_quality"] == "structured" for t in pk["tasks"])


def test_master_unknown_lists_available(mock_client, data_dir, tmp_path):
    _map(data_dir, [])
    _two_masters(mock_client, tmp_path)
    r = mock_client.post("/api/p/ex/dispatch-package", json=_package_body("不存在"))
    assert r.status_code == 422
    err = r.json()
    assert err["code"] == "master_unknown"
    assert err["details"]["available"] == ["后端", "前端"]
    assert mock_client.get("/api/p/ex/packages").json()["items"] == []  # 校验失败不建单


def test_host_path_rejected(mock_client, data_dir, tmp_path):
    _map(data_dir, [])
    _two_masters(mock_client, tmp_path)
    from speclock2 import executor

    body = _package_body("后端")
    body["tasks"][0]["instructions"] = f"写到 {executor.REPO_ROOT}/x.txt"
    r = mock_client.post("/api/p/ex/dispatch-package", json=body)
    assert r.status_code == 422 and r.json()["code"] == "host_path_in_instructions"


def test_project_unbound_rejected(mock_client, data_dir, tmp_path):
    _map(data_dir, [])
    _roster_master(mock_client, tmp_path, slug="ub", name="后端")  # 项目没有绑定目录
    r = mock_client.post("/api/p/ub/dispatch-package", json=_package_body("后端"))
    assert r.status_code == 422 and r.json()["code"] == "project_unbound"


def test_run_endpoint_skips_non_queued(mock_client, data_dir, tmp_path):
    _map(data_dir, [])
    _two_masters(mock_client, tmp_path)
    order = mock_client.post("/api/p/ex/tech-orders", json={
        "intent": "x", "scope": ["./"], "master": "后端"}).json()
    tid = order["task_id"]
    r = mock_client.post(f"/api/p/ex/tasks/{tid}/run", json={"instructions": "FILE: a.txt"})
    assert r.status_code == 200 and r.json()["skipped"] is False
    assert _wait_reports(mock_client, "ex", 1)
    r = mock_client.post(f"/api/p/ex/tasks/{tid}/run", json={"instructions": "FILE: a.txt"})
    assert r.status_code == 200 and r.json()["skipped"] is True
    assert r.json()["task"]["status"] == "reported"
    assert mock_client.post("/api/p/ex/tasks/T-0999/run",
                            json={"instructions": "x"}).status_code == 404


def test_nonzero_exit_gives_failed_report(mock_client, data_dir, tmp_path):
    _map(data_dir, ["--fail"])
    _two_masters(mock_client, tmp_path)
    assert mock_client.post("/api/p/ex/dispatch-package", json=_package_body("后端")).status_code == 201
    items = _wait_reports(mock_client, "ex", 1)
    assert len(items) == 1
    p = items[0]["payload"]
    assert p["status"] == "failed" and p["parse_quality"] == "none"


def test_spawn_failure_gives_failed_report(mock_client, data_dir, tmp_path):
    _map(data_dir, [], command=str(tmp_path / "no-such-command"))
    _two_masters(mock_client, tmp_path)
    r = mock_client.post("/api/p/ex/dispatch-package", json=_package_body("后端"))
    assert r.status_code == 201
    items = _wait_reports(mock_client, "ex", 1)
    assert len(items) == 1
    assert items[0]["payload"]["status"] == "failed" and items[0]["payload"]["parse_quality"] == "none"


def test_watchdog_timeout_gives_failed_report(mock_client, data_dir, tmp_path):
    _map(data_dir, [])
    _two_masters(mock_client, tmp_path)
    order = mock_client.post("/api/p/ex/tech-orders", json={
        "intent": "x", "scope": ["./"], "master": "后端"}).json()
    tid = int(order["task_id"].split("-")[1])
    app = mock_client.app
    from speclock2.routers.queue import _mark_task_timeout, dispatch_service

    dispatch_service(app, "ex", tid, 60)
    assert _mark_task_timeout(app, app.state.db, "ex", tid) is True
    items = _wait_reports(mock_client, "ex", 1)
    assert len(items) == 1 and items[0]["payload"]["status"] == "failed"
    assert mock_client.get("/api/p/ex/events", params={"type": "task.timeout"}).json()["items"]


def test_prompt_has_role_doc_report_format_and_task(mock_client, data_dir, tmp_path, monkeypatch):
    record = tmp_path / "argv.json"
    monkeypatch.setenv("SPECLOCK2_FAKE_RECORD_ARGV", str(record))
    _map(data_dir, [])
    _two_masters(mock_client, tmp_path)
    mock_client.put("/api/p/ex/roles/masters/后端", json={"content": "角色正文：只写后端代码"})
    assert mock_client.post("/api/p/ex/dispatch-package", json=_package_body("后端")).status_code == 201
    assert _wait_reports(mock_client, "ex", 1)
    prompt = json.loads(record.read_text(encoding="utf-8"))[-1]
    assert "角色正文：只写后端代码" in prompt
    assert "<<<SL2-REPORT" in prompt
    assert "FILE: out-0.txt" in prompt


def test_fake_harness_echo_prompt_and_legacy(tmp_path):
    base = [sys.executable, str(FAKE)]
    out = subprocess.run([*base, "--plain", "--echo-prompt", "提示词原文 FILE: e.txt"], cwd=tmp_path,
                         capture_output=True, text=True, encoding="utf-8").stdout
    assert "提示词原文" in out and "<<<SL2-REPORT" in out
    out = subprocess.run([*base, "--plain", "--legacy", "FILE: e.txt"], cwd=tmp_path,
                         capture_output=True, text=True, encoding="utf-8").stdout
    assert "FILES: e.txt" in out and "SL2-REPORT" not in out


def test_legacy_output_gives_legacy_quality(mock_client, data_dir, tmp_path):
    _map(data_dir, ["--legacy"])
    _two_masters(mock_client, tmp_path)
    assert mock_client.post("/api/p/ex/dispatch-package", json=_package_body("后端")).status_code == 201
    items = _wait_reports(mock_client, "ex", 1)
    assert items[0]["payload"]["parse_quality"] == "legacy"


def test_mock_session_uses_executor_start_task(mock_client, data_dir, tmp_path, monkeypatch):
    """MockSession 的派发走 executor.start_task，没有第二套实现。"""
    from speclock2 import executor
    from tests.test_s2 import _put_draft

    _map(data_dir, [])
    blk = _setup_project(mock_client, slug="ms")
    repo = tmp_path / "ms-repo"
    repo.mkdir()
    mock_client.patch("/api/p/ms", json={"working_dir": str(repo)})
    calls: list[int] = []
    real = executor.start_task

    async def spy(app, slug, task_id, instructions, **kw):
        calls.append(task_id)
        return await real(app, slug, task_id, instructions, **kw)

    monkeypatch.setattr(executor, "start_task", spy)
    _put_draft(mock_client, blk, slug="ms") if "slug" in _put_draft.__code__.co_varnames else _put_draft(mock_client, blk)
    mock_client.post("/api/p/ms/chat", json={"message": "起草", "draft": {
        "statement": {"说明": "导出支持 Excel", "动机": "财务需要"},
        "rule_ops": [{"block_id": blk, "op": "modify", "id": "R1",
                      "after": {"name": "导出格式", "detail": "CSV 与 Excel"}}],
        "api_ops": []}})
    assert mock_client.post("/api/p/ms/cards/C-0001/approve").status_code == 200
    deadline = time.time() + 20
    while time.time() < deadline and not calls:
        time.sleep(0.2)
    assert calls


def test_shutdown_kills_running_process(data_dir, tmp_path, monkeypatch):
    """后端关闭时杀掉在跑的主代理进程，任务保持 dispatched，下次启动由看门狗重建收尸。"""
    monkeypatch.setenv("SPECLOCK2_CHIEF_MOCK", "1")
    from fastapi.testclient import TestClient

    from speclock2.app import create_app

    _map(data_dir, ["--sleep", "12"])
    app = create_app()
    with TestClient(app) as c:
        _two_masters(c, tmp_path)
        assert c.post("/api/p/ex/dispatch-package", json=_package_body("后端")).status_code == 201
        time.sleep(1)
        procs = [p for p, _ in app.state.procs.values()]
        assert procs and procs[0].returncode is None
    assert procs[0].returncode is not None  # 关闭后进程已被杀
    assert not app.state.procs


def test_dispatch_implementation_is_single():
    """create_subprocess_exec 只出现在 executor.py；扩展里没有 spawn。"""
    hits = [p.name for p in SRC.rglob("*.py") if "create_subprocess_exec" in p.read_text(encoding="utf-8")
            and p.name != "executor.py"]
    assert hits == []
    ts = (SRC.parent.parent / "chief" / "extension" / "index.ts").read_text(encoding="utf-8")
    assert "spawn" not in ts
