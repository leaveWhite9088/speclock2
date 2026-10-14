"""Harness×模型登记 / CLI 会话探测 / 主代理名册 / 唤醒计划（launch-plan）。

用户原则：工作台不替 Harness 做模型选择，只做登记与唤醒、监控、探测——
登记是纯信息（harness 有啥模型登记啥），派发不注入任何 --model。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from speclock2 import cli_sessions, harness_map
from tests.test_s2 import _setup_project

FAKE = Path(__file__).parent.parent / "scripts" / "fake_harness.py"


# ---------- 夹具与工具 ----------


def _sessions_dir() -> Path:
    d = Path(os.environ["SPECLOCK2_PI_SESSIONS_DIR"])
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_session(sid: str, *, name: str | None = None, first_user: str | None = None,
                   mtime: float | None = None, subdir: str = "") -> Path:
    """写一个 pi 形态的会话文件：头行 type=session + 可选 session_info/首条用户消息。"""
    d = _sessions_dir() / subdir
    d.mkdir(parents=True, exist_ok=True)
    lines = [{"type": "session", "version": 3, "id": sid, "timestamp": "2026-10-14T10:00:00.000Z",
              "cwd": "D:/work/demo"}]
    if name is not None:
        lines.append({"type": "session_info", "id": "e1", "parentId": None,
                      "timestamp": "2026-10-14T10:00:01.000Z", "name": name})
    if first_user is not None:
        lines.append({"type": "message", "id": "e2", "parentId": "e1",
                      "timestamp": "2026-10-14T10:00:02.000Z",
                      "message": {"role": "user", "content": [{"type": "text", "text": first_user}]}})
    path = d / f"20261014_1000_{sid}.jsonl"
    path.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def _register(client: TestClient, harness: str, model: str) -> dict:
    res = client.post("/api/models", json={"harness": harness, "model": model})
    assert res.status_code == 201, res.text
    return res.json()


def _add_master(client: TestClient, slug: str = "a", **overrides) -> dict:
    body = {
        "name": "数据主代理",
        "duty": "负责数据管道与报表生成",
        "dir": "data/",
        "harness": "pi",
        "model": "glm-4.7",
        "session": "sess-a",
        **overrides,
    }
    res = client.post(f"/api/p/{slug}/masters", json=body)
    assert res.status_code == 201, res.text
    return res.json()


# ---------- /api/models：登记 ----------


def test_model_registry_crud(client):
    assert client.get("/api/models").json() == {"items": []}
    entry = _register(client, "pi", "glm-4.7")
    assert entry == {"id": "mdl-1", "harness": "pi", "model": "glm-4.7"}
    _register(client, "pi", "kimi-k2.5")
    _register(client, "claude-code", "claude-sonnet-4.5")

    # 重复登记（同 harness×model）→ 409；不同 harness 同名模型可以
    dup = client.post("/api/models", json={"harness": "pi", "model": "glm-4.7"})
    assert dup.status_code == 409 and dup.json()["code"] == "conflict"
    _register(client, "codex", "glm-4.7")

    # 空字段 → 422
    for bad in ({"harness": "", "model": "x"}, {"harness": "pi", "model": " "}):
        assert client.post("/api/models", json=bad).status_code == 422

    items = client.get("/api/models").json()["items"]
    assert [i["harness"] for i in items] == ["pi", "pi", "claude-code", "codex"]

    # 删除：存在的 200，再删 404；非法 id 404
    assert client.delete("/api/models/mdl-2").status_code == 200
    assert client.delete("/api/models/mdl-2").status_code == 404
    assert client.delete("/api/models/nope").status_code == 404
    assert len(client.get("/api/models").json()["items"]) == 3


# ---------- /api/cli-sessions：探测 ----------


def test_cli_sessions_scan(client):
    _write_session("sess-a", first_user="日报导出需求：支持 CSV 与 Excel", mtime=time.time() - 100)
    _write_session("sess-b", name="全局约定 · 起草", mtime=time.time() - 50, subdir="--D--work--demo")
    # 非会话文件（无 session 头行）与空文件跳过
    (_sessions_dir() / "junk.jsonl").write_text('{"type":"message"}\n', encoding="utf-8")
    (_sessions_dir() / "empty.jsonl").write_text("", encoding="utf-8")

    items = client.get("/api/cli-sessions").json()["items"]
    assert [i["id"] for i in items] == ["sess-b", "sess-a"]  # 新→旧
    by_id = {i["id"]: i for i in items}
    assert by_id["sess-b"]["title"] == "全局约定 · 起草"          # 人为命名优先
    assert by_id["sess-a"]["title"] == "日报导出需求：支持 CSV 与 Excel"  # 否则首条用户消息
    assert all("updated_at" in i for i in items)


def test_cli_sessions_empty_dir(client):
    _sessions_dir()  # 目录存在但为空
    assert client.get("/api/cli-sessions").json() == {"items": []}


# ---------- /api/p/{slug}/masters：名册 ----------


@pytest.fixture()
def seeded(client):
    _setup_project(client)
    _register(client, "pi", "glm-4.7")
    _write_session("sess-a", first_user="日报导出 · 后端实现")
    return client


def test_master_create_and_list(seeded):
    master = _add_master(seeded)
    assert master["name"] == "数据主代理"
    assert master["harness"] == "pi" and master["model"] == "glm-4.7"
    assert master["session"] == "sess-a"
    assert master["session_title"] == "日报导出 · 后端实现"  # 探测联出的标题
    assert master["dir"] == "data/"
    assert seeded.get("/api/p/a/masters").json()["items"] == [master]


def test_master_create_validations(seeded):
    # harness×model 必须来自登记
    res = seeded.post("/api/p/a/masters", json={
        "name": "x", "duty": "y", "dir": "z", "harness": "pi", "model": "未登记模型", "session": "sess-a"})
    assert res.status_code == 422 and "未在「模型」登记" in res.json()["message"]
    # 会话必须真实存在
    res = seeded.post("/api/p/a/masters", json={
        "name": "x", "duty": "y", "dir": "z", "harness": "pi", "model": "glm-4.7", "session": "sess-x"})
    assert res.status_code == 422 and "CLI 会话不存在" in res.json()["message"]
    # 名称/职责/会话缺失
    for bad in ({"name": " ", "duty": "y"}, {"name": "x", "duty": ""}, {"name": "x", "duty": "y", "session": ""}):
        body = {"harness": "pi", "model": "glm-4.7", "session": "sess-a", "dir": "d", **bad}
        assert seeded.post("/api/p/a/masters", json=body).status_code == 422
    # 同名 → 409
    _add_master(seeded)
    res = seeded.post("/api/p/a/masters", json={
        "name": "数据主代理", "duty": "另一个职责", "harness": "pi", "model": "glm-4.7", "session": "sess-a"})
    assert res.status_code == 409
    # 项目不存在 → 404
    assert seeded.get("/api/p/nope/masters").status_code == 404


# ---------- launch-plan 与派发接续 ----------


def _write_map(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {
        "watchdog_minutes_default": 60,
        "masters": {"backend": "pi"},
        "harnesses": {
            "pi": {
                "command": sys.executable,
                "args": [str(FAKE), "--mode", "json", "-p", "{prompt}", "--no-session"],
                "prompt_mode": "inline",
                "resume_args": ["--session-id", "{session_id}", "--session-dir", "{session_dir}"],
            },
        },
    }
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")


def _tech_order_task(client: TestClient) -> str:
    order = client.post("/api/p/a/tech-orders", json={
        "intent": "写一个 hello 文件", "scope": ["backend/"], "acceptance": ["文件存在"]}).json()
    tasks = client.get("/api/p/a/packages").json()["items"][-1]["tasks"]
    assert tasks[-1]["task_id"].startswith("T-")
    return tasks[-1]["task_id"]


def test_launch_plan_uses_roster_harness_and_resume(seeded, data_dir):
    _write_map(data_dir)
    _add_master(seeded, name="backend")  # 名册登记 backend → pi + 绑定 sess-a
    task_id = _tech_order_task(seeded)

    plan = seeded.post(f"/api/p/a/tasks/{task_id}/launch-plan", json={"prompt": "做任务"}).json()
    assert plan["harness"] == "pi"
    argv = plan["argv"]
    assert "--no-session" not in argv  # 接续会话时去掉一次性会话开关
    assert argv[argv.index("--session-id") + 1] == "sess-a"
    session_dir = argv[argv.index("--session-dir") + 1]
    assert cli_sessions.find_session_dir("sess-a") == Path(session_dir)
    assert plan["cwd"] and plan["watchdog_minutes"] == 60
    assert "--model" not in argv  # 不替 Harness 选模型


def test_launch_plan_without_roster_falls_back_to_map(seeded, data_dir):
    _write_map(data_dir)  # 名册里没有 tech-order 的 master（backend 未登记）→ 映射兜底
    task_id = _tech_order_task(seeded)
    plan = seeded.post(f"/api/p/a/tasks/{task_id}/launch-plan", json={"prompt": "做任务"}).json()
    assert plan["harness"] == "pi"
    assert "--session-id" not in plan["argv"]  # 无绑定会话 → 不接续，--no-session 保留


def test_launch_plan_roster_harness_unconfigured(seeded, data_dir):
    _write_map(data_dir)
    cfg = json.loads((data_dir / "harness-map.json").read_text(encoding="utf-8"))
    del cfg["harnesses"]["pi"]  # 名册指向 pi 但映射没配 → 如实报错
    (data_dir / "harness-map.json").write_text(json.dumps(cfg), encoding="utf-8")
    _add_master(seeded, name="backend")
    task_id = _tech_order_task(seeded)
    res = seeded.post(f"/api/p/a/tasks/{task_id}/launch-plan", json={"prompt": "做"})
    assert res.status_code == 422 and res.json()["code"] == "harness_unconfigured"


def test_run_task_spawns_with_resume_args(seeded, data_dir, monkeypatch, tmp_path):
    """真实进程链路：接续参数确实传进了被唤醒的 harness。"""
    _write_map(data_dir)
    _add_master(seeded, name="backend")
    task_id = _tech_order_task(seeded)
    record = tmp_path / "argv.json"
    monkeypatch.setenv("SPECLOCK2_FAKE_RECORD_ARGV", str(record))

    from speclock2 import dispatcher
    from speclock2.utils import parse_prefixed_id

    numeric = parse_prefixed_id(task_id, "T")

    async def run():
        return await dispatcher.run_task(seeded.app, "a", numeric, "FILE: backend/hello-agent.txt")

    result = asyncio_run(run())
    assert result["outcome"] == "reported"
    argv = json.loads(record.read_text(encoding="utf-8"))
    assert argv[argv.index("--session-id") + 1] == "sess-a"
    assert "--no-session" not in argv
    # 收尾：清掉替身写进仓库根的文件
    written = Path(dispatcher.REPO_ROOT) / "backend/hello-agent.txt"
    if written.exists():
        written.unlink()


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


def test_default_map_has_no_model_injection():
    """原则守卫：默认映射里任何 harness 都不注入 --model（模型是 Harness 自己的事）。"""
    cfg = harness_map.default_map()
    for harness in cfg["harnesses"].values():
        assert "--model" not in (harness.get("args") or []), harness
