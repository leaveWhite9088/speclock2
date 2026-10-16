"""慢工单：任务落定通知腿——chief 没同步跟单时，结果由通知回合送回对话流。"""

from __future__ import annotations

import asyncio

import pytest

from speclock2 import chief_notify, models
from speclock2.utils import now_iso
from tests.test_s2 import _setup_project


def _queued_task(client, slug: str, status: str = "dispatched") -> int:
    _setup_project(client, slug=slug)
    with client.app.state.db.ledger_session(slug) as s:
        pkg = models.TaskPackage(origin="tech", round=0, version_refs={}, created_at=now_iso())
        s.add(pkg)
        s.flush()
        t = models.Task(package_id=pkg.id, master="backend", status=status,
                        created_at=now_iso(), updated_at=now_iso())
        s.add(t)
        s.flush()
        tid = t.id
        s.commit()
    return tid


class _SpySession:
    """记录收到的通知回合；足够骗过 PiManager.get。"""

    session_id = "spy"

    def __init__(self) -> None:
        self.got: list[str] = []
        self.running = True

    async def prompt(self, text: str, draft=None) -> str:
        self.got.append(text)
        return "收到，我会向用户转述。"

    async def stop(self) -> None:
        return None


def test_receipt_enqueues_settle_notice(client):
    """回执 → 通知入队：带任务号、master、回执文件与摘要。"""
    tid = _queued_task(client, slug="nt1")
    r = client.post(f"/api/p/nt1/tasks/T-{tid:04d}/receipt", json={
        "files_changed": ["hello.txt"], "summary": "写完了"})
    assert r.status_code == 200
    q = client.app.state.chief_notify
    assert q.qsize() == 1
    slug, text = q.get_nowait()
    assert slug == "nt1"
    assert "已回执" in text and "hello.txt" in text and "backend" in text


def test_fail_enqueues_crash_notice(client):
    """快速收尸 → 通知入队：带 reason 与 stderr 尾部。"""
    tid = _queued_task(client, slug="nt2")
    r = client.post(f"/api/p/nt2/tasks/T-{tid:04d}/fail", json={
        "reason": "模型被路由层拒绝", "exit_code": 4, "stderr": "bad model"})
    assert r.status_code == 200
    _, text = client.app.state.chief_notify.get_nowait()
    assert "进程失败退出" in text and "模型被路由层拒绝" in text and "bad model" in text


def test_timeout_enqueues_notice(client):
    """看门狗收尸 → 通知入队：不带臆测原因，指向过程输出。"""
    tid = _queued_task(client, slug="nt3")
    from speclock2.routers.queue import _mark_task_timeout

    assert _mark_task_timeout(client.app, client.app.state.db, "nt3", tid) is True
    _, text = client.app.state.chief_notify.get_nowait()
    assert "看门狗超时" in text and "T-0001" in text


def test_worker_relays_to_running_chief(client):
    """worker 消费通知：给运行中的 chief 会话发转述回合，并落账本（chat.system/chat.chief）。"""
    _setup_project(client, slug="nt4")
    spy = _SpySession()
    client.app.state.pi.sessions["nt4"] = spy
    client.app.state.chief_notify.put_nowait(("nt4", "系统通知：任务 T-0001 已完成并回执。"))

    async def one_step():
        await chief_notify.worker(client.app)  # 无限循环：靠超时打断

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(asyncio.wait_for(one_step(), timeout=3))
    assert spy.got and "已完成并回执" in spy.got[0]
    # 通知回合落账本（账本是 SSOT，回放可见）
    events = client.get("/api/p/nt4/events", params={"type": "chat.chief"}).json()["items"]
    assert events and "收到" in events[0]["payload"]["message"]
    systems = client.get("/api/p/nt4/events", params={"type": "chat.system"}).json()["items"]
    assert systems and "系统通知" in systems[0]["payload"]["message"]


def test_worker_skips_when_chief_not_running(client):
    """chief 未运行：不唤醒、不通知，队列照常消费。"""
    _setup_project(client, slug="nt5")
    client.app.state.chief_notify.put_nowait(("nt5", "系统通知：x"))

    async def one_step():
        await chief_notify.worker(client.app)

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(asyncio.wait_for(one_step(), timeout=3))
    assert client.app.state.pi.get("nt5") is None
