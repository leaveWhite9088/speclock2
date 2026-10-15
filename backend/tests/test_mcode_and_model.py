"""mcode harness 接入 + /agent/model 切换端点（契约 v0.5）。

mcode exec：纯文本 stdout（无事件流）、--session 接续、token 恒估算；
全部实验约束在绑定的测试项目目录（协作规则 §5.6）。
"""

from __future__ import annotations

import asyncio
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


@pytest.fixture()
def mock_client(data_dir, monkeypatch):
    monkeypatch.setenv("SPECLOCK2_CHIEF_MOCK", "1")
    from speclock2.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


def _mcode_map(data_dir: Path, tmp_path: Path) -> None:
    """t-text：--plain 替身（模拟 mcode 纯文本输出）；t-ndjson：普通 NDJSON 替身。"""
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {
        "watchdog_minutes_default": 60,
        "masters": {},
        "harnesses": {
            # arg 模式：prompt 由执行器追加为尾参，模板里不能再写 {prompt}
            "t-text": {"command": sys.executable, "args": [str(FAKE), "--plain"],
                       "prompt_mode": "arg", "output": "text",
                       "resume_args": ["--session", "{session_id}"]},
            "t-ndjson": {"command": sys.executable, "args": [str(FAKE), "{prompt}"],
                         "prompt_mode": "inline"},
        },
    }
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")


# ---------- harness 模板与命令解析 ----------


def test_default_map_includes_mcode_when_resolvable(monkeypatch, tmp_path):
    fake_cli = tmp_path / "cli.js"
    fake_cli.write_text("//", encoding="utf-8")
    monkeypatch.setenv("SPECLOCK2_MCODE_CMD", f"node {fake_cli}")
    cfg = harness_map.default_map()
    mcode = cfg["harnesses"].get("mcode")
    assert mcode, "已安装 mcode（SPECLOCK2_MCODE_CMD 指向 cli.js）时应出现在默认映射"
    assert mcode["output"] == "text"
    assert mcode["resume_args"] == ["--session", "{session_id}"]
    args = mcode["args"]
    assert args.count("exec") == 1 and "--permission" in args and "full" in args
    assert args[args.index("--cwd") + 1] == "{cwd}"
    for i, a in enumerate(args):  # 模板守卫：--model 只能跟 {model} 占位
        if a == "--model":
            assert args[i + 1] == "{model}"


def test_resolve_mcode_prefers_bundled_runtime(monkeypatch, tmp_path):
    """自带运行时优先：better-sqlite3 按自带 Node 编译，系统 Node 会版本不匹配。"""
    import json as jsonlib

    home = tmp_path / "home"
    runtime_node = home / ".minimax-code" / "runtime" / "node-v22.0.0-win-x64" / "node.exe"
    runtime_node.parent.mkdir(parents=True)
    runtime_node.write_text("", encoding="utf-8")
    pkg_cli = home / ".minimax-code" / "node_modules" / "@minimax-ai" / "code" / "cli.js"
    pkg_cli.parent.mkdir(parents=True)
    pkg_cli.write_text("//", encoding="utf-8")
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("SPECLOCK2_MCODE_CMD", "")
    resolved = harness_map.resolve_mcode_command()
    assert resolved == [str(runtime_node), str(pkg_cli)]


def test_build_argv_substitutes_cwd_placeholder():
    cfg = {"command": "mcode", "args": ["exec", "{prompt}", "--cwd", "{cwd}"],
           "prompt_mode": "inline"}
    argv = harness_map.build_argv(cfg, "hello", cwd="D:/work/repo")
    assert argv == ["mcode", "exec", "hello", "--cwd", "D:/work/repo"]
    # 不传 cwd 时占位保持原样（plan 阶段总是传，防御性保留）
    assert harness_map.build_argv(cfg, "hello")[-1] == "{cwd}"


# ---------- 会话发现（只读 id 与时间） ----------


def test_mcode_session_discovery(client, tmp_path, monkeypatch):
    root = tmp_path / "mm-sessions" / "2026" / "10" / "15"
    old = root / "02-45-45-887-session_x2Fkqq"   # 目录名是编码 id，真 id 在 manifest
    new = root / "02-57-53-119-session_x9zrrs"
    old.mkdir(parents=True)
    new.mkdir(parents=True)
    (old / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs_aaaa00000000000000000000000000", "createdAtMs": 1792030000000,
         "updatedAtMs": 1792030100000}), encoding="utf-8")
    (new / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs_bbbb00000000000000000000000000", "createdAtMs": 1792030200000}),
        encoding="utf-8")
    os.utime(old, (time.time() - 600,) * 2)
    monkeypatch.setenv("SPECLOCK2_MCODE_SESSIONS_DIR", str(tmp_path / "mm-sessions"))

    items = client.get("/api/cli-sessions").json()["items"]
    mcode_items = [i for i in items if i["id"].startswith("mvs_")]
    assert [i["id"] for i in mcode_items] == [
        "mvs_bbbb00000000000000000000000000", "mvs_aaaa00000000000000000000000000"]  # 新→旧
    assert all(i["updated_at"] for i in mcode_items)
    # find_session_dir 能定位 mcode 会话（接续存在性检查用）
    assert cli_sessions.find_session_dir("mvs_bbbb00000000000000000000000000") == new


# ---------- 派发：纯文本输出解析 + 会话接续 ----------


def _setup_mcode_project(client: TestClient, data_dir: Path, tmp_path: Path,
                         session_id: str | None) -> Path:
    _setup_project(client, slug="mc")
    repo = tmp_path / "mc-repo"
    repo.mkdir(exist_ok=True)
    r = client.patch("/api/p/mc", json={"working_dir": str(repo)})
    assert r.status_code == 200, r.text
    _mcode_map(data_dir, tmp_path)
    # 名册：直接建行（登记校验路径已在 masters 测试覆盖），harness 用纯文本替身
    from speclock2 import models
    from speclock2.utils import now_iso

    with client.app.state.db.ledger_session("mc") as s:
        s.add(models.Master(name="backend", role="mcode 测试", harness="t-text",
                            model="minimax/MiniMax-M3", working_dir=".",
                            session_policy={"cli_session": session_id} if session_id else None,
                            created_at=now_iso()))
        s.commit()
    return repo


def _tech_order_task(client: TestClient, prompt_intent: str) -> str:
    order = client.post("/api/p/mc/tech-orders", json={
        "intent": prompt_intent, "scope": ["./"], "acceptance": [],
        "master": "backend"}).json()
    return client.get("/api/p/mc/packages").json()["items"][-1]["tasks"][-1]["task_id"]


def test_dispatch_text_harness_parses_stdout(client, data_dir, tmp_path):
    """mcode 形态替身：回执来自全部 stdout 文本，token 恒 estimated，无 NDJSON 事件。"""
    repo = _setup_mcode_project(client, data_dir, tmp_path, session_id=None)
    task_id = _tech_order_task(client, "hello 级任务")
    from speclock2 import dispatcher
    from speclock2.utils import parse_prefixed_id

    result = asyncio_run(dispatcher.run_task(
        client.app, "mc", parse_prefixed_id(task_id, "T"),
        "FILE: hello-mcode.txt 只回复一个词：hello"))
    assert result["outcome"] == "reported"
    assert result["files_changed"] == ["hello-mcode.txt"]  # FILES: 约定照旧，来自纯文本

    detail = client.get("/api/p/mc/packages").json()["items"][-1]["tasks"][-1]
    receipt = detail["receipt"]
    assert "FILES: hello-mcode.txt" in receipt["summary"]
    assert receipt["telemetry"]["token_source"] == "estimated"
    assert receipt["telemetry"]["tokens"] is None  # mcode 不暴露 token
    assert receipt["telemetry"]["duration_ms"] >= 0
    assert (repo / "hello-mcode.txt").exists()


def test_dispatch_mcode_resume_session(client, data_dir, tmp_path, monkeypatch):
    """绑定了 mcode 会话 → 派发 argv 自动带 --session <id>。"""
    root = tmp_path / "mcode-sessions" / "2026" / "10" / "15"
    sess = root / "02-57-53-119-session_x9zrrs"
    sess.mkdir(parents=True, exist_ok=True)
    (sess / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs_bbbb00000000000000000000000000", "createdAtMs": 1792030200000}),
        encoding="utf-8")
    repo = _setup_mcode_project(client, data_dir, tmp_path,
                                session_id="mvs_bbbb00000000000000000000000000")
    # 接续证据：会话工作区 = 项目绑定目录（慢工单接缝：mcode 只接证实同目录的会话）
    (sess / "messages.jsonl").write_text(
        json.dumps({"agent-context": {"cwd": str(repo)}}) + "\n", encoding="utf-8")
    task_id = _tech_order_task(client, "hello 级任务")
    record = tmp_path / "argv.json"
    monkeypatch.setenv("SPECLOCK2_FAKE_RECORD_ARGV", str(record))

    from speclock2 import dispatcher
    from speclock2.utils import parse_prefixed_id

    plan = dispatcher.plan_task_launch(
        client.app, "mc", parse_prefixed_id(task_id, "T"), "只回复一个词：hello")
    argv = plan["argv"]
    assert argv[argv.index("--session") + 1] == "mvs_bbbb00000000000000000000000000"
    assert plan["output"] == "text" and plan["model"] == "minimax/MiniMax-M3"

    result = asyncio_run(dispatcher.run_task(
        client.app, "mc", parse_prefixed_id(task_id, "T"), "只回复一个词：hello"))
    assert result["outcome"] == "reported"
    recorded = json.loads(record.read_text(encoding="utf-8"))
    assert recorded[recorded.index("--session") + 1] == "mvs_bbbb00000000000000000000000000"


def test_dispatch_mcode_session_missing_degrades(client, data_dir, tmp_path):
    """绑定的会话文件没了 → 优雅降级为新会话（不带 --session）。"""
    _setup_mcode_project(client, data_dir, tmp_path,
                         session_id="mvs_gone00000000000000000000000000")
    task_id = _tech_order_task(client, "hello 级任务")
    from speclock2 import dispatcher
    from speclock2.utils import parse_prefixed_id

    plan = dispatcher.plan_task_launch(
        client.app, "mc", parse_prefixed_id(task_id, "T"), "只回复一个词：hello")
    assert "--session" not in plan["argv"]  # 目录已不存在 → 放弃接续
    assert plan["output"] == "text"


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


# ---------- /agent/model 切换端点 ----------


def test_agent_model_endpoint_state_machine(mock_client):
    _setup_project(mock_client, slug="mm")
    # 会话未运行 → 409
    r = mock_client.post("/api/p/mm/agent/model", json={"model": "glm-4.7"})
    assert r.status_code == 409 and "未运行" in r.json()["message"]
    # model 缺失 → 422
    mock_client.post("/api/p/mm/agent/start", json={})
    r = mock_client.post("/api/p/mm/agent/model", json={"model": " "})
    assert r.status_code == 422
    # 正常切换（mock 会话：provider 可选，拼 provider/model）
    r = mock_client.post("/api/p/mm/agent/model",
                         json={"provider": "minimax-cn", "model": "MiniMax-M3"})
    assert r.status_code == 200 and r.json() == {"ok": True, "model": "minimax-cn/MiniMax-M3"}
    # GET /agent 的 model 字段反映切换结果
    status = mock_client.get("/api/p/mm/agent").json()
    assert status["running"] is True and status["model"] == "minimax-cn/MiniMax-M3"
    # 再切一次（无 provider）覆盖
    r = mock_client.post("/api/p/mm/agent/model", json={"model": "glm-4.7"})
    assert r.json()["model"] == "glm-4.7"
    assert mock_client.get("/api/p/mm/agent").json()["model"] == "glm-4.7"
    # 停止后再切 → 409
    mock_client.post("/api/p/mm/agent/stop")
    assert mock_client.post("/api/p/mm/agent/model", json={"model": "x"}).status_code == 409
