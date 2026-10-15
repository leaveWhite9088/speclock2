"""追加项 9：看门狗定时器是内存态，进程重启即丢 → 启动时扫描僵尸任务重建。

派发时 dispatched_at/watchdog_minutes 落库；重启后按 watchdog_deadline 重武装，
已过期的立即收尸标 timeout。
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from speclock2 import models
from speclock2.utils import now_iso, parse_prefixed_id
from tests.test_s2 import _setup_project


def _make_zombie(client: TestClient, *, dispatched_at: datetime, deadline: datetime) -> str:
    """不经 dispatch 端点，直接把一个 queued 任务改成 dispatched 僵尸
    （避开 dispatch 端点当场武装的定时器，专测「重启后重建」这条路）。"""
    order = client.post("/api/p/a/tech-orders", json={
        "intent": "僵尸任务", "scope": ["./"], "acceptance": []}).json()
    task = client.get("/api/p/a/packages").json()["items"][-1]["tasks"][-1]
    with client.app.state.db.ledger_session("a") as s:
        row = s.get(models.Task, parse_prefixed_id(task["task_id"], "T"))
        row.status = "dispatched"
        row.dispatched_at = dispatched_at.isoformat(timespec="seconds")
        row.watchdog_minutes = 0.05
        row.watchdog_deadline = deadline.isoformat(timespec="seconds")
        row.updated_at = now_iso()
        s.commit()
    return task["task_id"]


def test_dispatch_persists_watchdog_fields(client):
    """dispatch 端点把 dispatched_at / watchdog_minutes / deadline 落库。"""
    _setup_project(client)
    order = client.post("/api/p/a/tech-orders", json={
        "intent": "落库检查", "scope": ["./"], "acceptance": []}).json()
    task = client.get("/api/p/a/packages").json()["items"][-1]["tasks"][-1]
    r = client.post(f"/api/p/a/tasks/{task['task_id']}/dispatch", json={"watchdog_minutes": 30})
    assert r.status_code == 200, r.text

    with client.app.state.db.ledger_session("a") as s:
        row = s.get(models.Task, parse_prefixed_id(task["task_id"], "T"))
        assert row.status == "dispatched"
        assert row.dispatched_at is not None and row.watchdog_minutes == 30.0
        deadline = datetime.fromisoformat(row.watchdog_deadline)
    assert timedelta(minutes=29) < deadline - datetime.now().astimezone() <= timedelta(minutes=30)


def test_rearm_marks_expired_zombie_on_startup(client):
    """重启后：已过期的僵尸任务被立即收尸标 timeout。"""
    _setup_project(client)
    now = datetime.now().astimezone()
    task_id = _make_zombie(client, dispatched_at=now - timedelta(minutes=5),
                           deadline=now - timedelta(seconds=1))

    from speclock2.app import create_app

    with TestClient(create_app()) as c2:  # 同数据目录「重启」：lifespan 触发扫描
        detail = [t for p in c2.get("/api/p/a/packages").json()["items"]
                  for t in p["tasks"] if t["task_id"] == task_id][0]
        assert detail["status"] == "timeout"
        events = c2.get("/api/p/a/events", params={"type": "task.timeout"}).json()["items"]
        assert events and events[0]["ref"]["task"] == task_id


def test_rearm_arms_future_watchdog_after_restart(client):
    """重启后：未到期的僵尸任务被重武装，到期照常触发 timeout。"""
    _setup_project(client)
    now = datetime.now().astimezone()
    task_id = _make_zombie(client, dispatched_at=now,
                           deadline=now + timedelta(seconds=2))

    from speclock2.app import create_app

    with TestClient(create_app()) as c2:
        deadline = time.time() + 15
        status = None
        while time.time() < deadline:
            detail = [t for p in c2.get("/api/p/a/packages").json()["items"]
                      for t in p["tasks"] if t["task_id"] == task_id][0]
            status = detail["status"]
            if status == "timeout":
                break
            time.sleep(0.4)
        assert status == "timeout"  # 重武装的定时器在重启后的进程里照常开火


def test_rearm_clean_directory_is_noop(client):
    """无僵尸任务时启动扫描为空操作（不报错、不动数据）。"""
    _setup_project(client)
    from speclock2.routers.queue import rearm_watchdogs

    stats = rearm_watchdogs(client.app, client.app.state.settings.ledgers_dir)
    assert stats == {"zombies": 0, "rearmed": 0, "timed_out": 0}
