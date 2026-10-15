"""修复单 17/19：核心代理建任务通道——tech-orders 带 task_id、master 名册校验、
audit-all 只碰 reported、create_task→dispatch 全链（名册主代理 + 替身 harness）；
修复单 19：dispatch 404 纠偏回路、create_task(prompt) 一步派发、路径纪律、agent/reset。"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from speclock2 import models
from speclock2.utils import now_iso
from tests.test_s2 import _setup_project

CHIEF_TS = Path(__file__).parent.parent.parent / "chief" / "extension" / "index.ts"
CHIEF_CONSTITUTION = Path(__file__).parent.parent.parent / "chief" / "constitution.md"


@pytest.fixture()
def mock_client(data_dir, monkeypatch):
    monkeypatch.setenv("SPECLOCK2_CHIEF_MOCK", "1")
    from speclock2.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c


def _fake_pi_session(tmp_path: Path, session_id: str = "pi-chief-flow") -> None:
    """在探测目录造假 pi 会话（主代理创建要求会话必选且真实存在）。"""
    root = tmp_path / "cli-sessions"
    root.mkdir(parents=True, exist_ok=True)
    (root / "chief_flow.jsonl").write_text(json.dumps({
        "type": "session", "version": 3, "id": session_id, "cwd": "D:/work/chief-flow",
    }) + "\n", encoding="utf-8")


def _roster_master(client: TestClient, tmp_path: Path, slug: str = "cf",
                   name: str = "后端主代理") -> None:
    """登记模型 + 造会话 + 建一个挂在替身 harness 上的主代理（名册非空）。"""
    _setup_project(client, slug=slug)
    r = client.post("/api/models", json={"harness": "sl2-fake", "model": "fake-m"})
    assert r.status_code in (200, 201), r.text
    _fake_pi_session(tmp_path)
    r = client.post(f"/api/p/{slug}/masters", json={
        "name": name, "duty": "测试", "dir": ".", "harness": "sl2-fake",
        "model": "fake-m", "session": "pi-chief-flow"})
    assert r.status_code in (200, 201), r.text


def test_create_task_tool_exists_in_chief_ts():
    """源码级：chief 扩展必须登记 create_task 工具（直达请求的合法入口）。"""
    src = CHIEF_TS.read_text(encoding="utf-8")
    assert 'name: "create_task"' in src
    assert "/tech-orders" in src
    assert "task_id" in src  # 返回结果要带新任务号


def test_chief_ts_404_guidance_and_one_step():
    """源码级（修复单 19）：404 纠偏回路、一步派发共享链、路径纪律、宪法同步。"""
    src = CHIEF_TS.read_text(encoding="utf-8")
    # 1. dispatch 404 → 纠偏引导，不许裸抛
    assert "err.status === 404" in src
    assert "你不能编造任务号" in src
    assert "不是通道故障" in src
    # 2. create_task 带 prompt 一步派发：共享链被两个工具复用（无任务号交接）
    assert src.count("runDispatchChain(") >= 3  # 定义 + dispatch + create_task
    assert "Type.Optional" in src and "一步完成建单+派发+回执" in src
    # 3. 路径纪律：宿主仓库绝对路径 → 拒绝并要求改写（不自动放行）
    assert "promptHasHostPath" in src and "REPO_ROOT" in src
    assert "改写成「在你的工作目录下创建" in src
    # 4. 工具结果带解析出的工作目录（launch-plan cwd）
    assert "工作目录：${plan.cwd}" in src
    # 5. 宪法：一步建单 + 路径纪律 + 404 应对
    c = CHIEF_CONSTITUTION.read_text(encoding="utf-8")
    assert "一次 `create_task`" in c
    assert "禁止出现宿主/工作台仓库的绝对路径" in c
    assert "回合内重试" in c


def test_tech_order_returns_task_id_and_validates_master(client, tmp_path):
    """tech-orders：响应带 task_id；名册非空时 master 必须对上，报错附可用名单。"""
    _roster_master(client, tmp_path)
    # 名册外名字 → 422，错误文本带可用名单（模型可自纠）
    r = client.post("/api/p/cf/tech-orders", json={
        "intent": "写 hello", "scope": ["./"], "acceptance": [],
        "master": "不存在的代理"})
    assert r.status_code == 422
    assert "后端主代理" in r.json()["message"]
    # 名册内名字 → 201，响应带新任务号
    r = client.post("/api/p/cf/tech-orders", json={
        "intent": "写 hello", "scope": ["./"], "acceptance": ["文件存在"],
        "master": "后端主代理"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["task_id"].startswith("T-")
    tasks = client.get("/api/p/cf/packages").json()["items"][-1]["tasks"]
    assert tasks[-1]["task_id"] == body["task_id"]
    assert tasks[-1]["status"] == "queued"


def test_create_task_dispatch_full_flow(client, tmp_path):
    """全链（修复单 17 验收，完全模拟真实 chief 工具的四步）：
    create_task 建 queued → dispatch 状态机推进 → launch-plan 拿启动参数并 spawn
    → 报 receipt 回执。最后再派发一次 → skipped（终态不可派发）。"""
    _roster_master(client, tmp_path)
    # 项目绑定目录（派发 cwd 3 级解析的落点；替身 harness 会把文件写进这里）
    repo = tmp_path / "chief-flow-repo"
    repo.mkdir(parents=True)
    assert client.patch("/api/p/cf", json={"working_dir": str(repo)}).status_code == 200

    # 1. create_task（POST /tech-orders）
    order = client.post("/api/p/cf/tech-orders", json={
        "intent": "写 hello 文件", "scope": ["./"], "acceptance": ["文件存在"],
        "master": "后端主代理"}).json()
    task_id = order["task_id"]

    # 2. dispatch：queued → dispatched
    r = client.post(f"/api/p/cf/tasks/{task_id}/dispatch", json={"watchdog_minutes": 30})
    assert r.status_code == 200, r.text
    assert "skipped" not in r.json()
    assert r.json()["status"] == "dispatched"

    # 3. launch-plan → spawn（chief 工具同款动作）
    prompt = "写一个 hello 文件。FILE: hello-chief-flow.txt"
    plan = client.post(f"/api/p/cf/tasks/{task_id}/launch-plan",
                       json={"prompt": prompt}).json()
    assert plan["cwd"] == str(repo)
    import subprocess
    proc = subprocess.run([plan["command"], *plan["argv"]], cwd=plan["cwd"],
                          capture_output=True, text=True, timeout=60, encoding="utf-8")
    assert proc.returncode == 0, proc.stderr
    assert (repo / "hello-chief-flow.txt").exists()

    # 4. receipt：dispatched → reported
    files = proc.stdout.split("FILES:", 1)[1].split()
    r = client.post(f"/api/p/cf/tasks/{task_id}/receipt", json={
        "files_changed": files, "self_check": "主代理进程退出码 0",
        "summary": proc.stdout[:200]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "reported"

    # 终态再派发 → skipped，无副作用（chief 工具把它转成「请新建任务」引导）
    r = client.post(f"/api/p/cf/tasks/{task_id}/dispatch", json={"watchdog_minutes": 30})
    assert r.status_code == 200
    body = r.json()
    assert body["skipped"] is True and "reported" in body["reason"]


def test_audit_all_only_touches_reported(client):
    """回归（修复单 17）：audit-all 只迁移 reported；queued/dispatched/done/rejected 不动。
    背景：中间版本曾把从未派发的 queued 任务批量扫成 done（幽灵完成）。"""
    _setup_project(client, slug="aa3")
    ids: dict[str, int] = {}
    with client.app.state.db.ledger_session("aa3") as s:
        for status in ("queued", "dispatched", "done", "rejected", "reported"):
            pkg = models.TaskPackage(origin="tech", round=0, version_refs={},
                                     created_at=now_iso())
            s.add(pkg)
            s.flush()
            t = models.Task(package_id=pkg.id, master="backend", status=status,
                            created_at=now_iso(), updated_at=now_iso())
            s.add(t)
            s.flush()
            ids[status] = t.id
        s.commit()
    r = client.post("/api/p/aa3/audit-all", json={"result": "pass"})
    assert r.status_code == 200
    assert r.json()["audited"] == 1
    with client.app.state.db.ledger_session("aa3") as s:
        for status, tid in ids.items():
            assert s.get(models.Task, tid).status == ("done" if status == "reported" else status)


# ---------- 修复单 19：核心代理会话重建 ----------


def test_agent_reset_archives_session_jsonl(mock_client):
    """POST /agent/reset：stop 当前会话 + 归档 pi 会话 JSONL（加时间戳后缀）；
    归档后 agent 状态 running=false，下次 ensure 同 session-id 全新启动。"""
    _setup_project(mock_client, slug="rs")
    # 伪造一个真实 chief 会话 JSONL（PiSession 命名：{时间戳}_speclock2-{slug}.jsonl）
    sess_dir = mock_client.app.state.settings.data_dir / "pi-sessions"
    sess_dir.mkdir(parents=True, exist_ok=True)
    f = sess_dir / "20261015T120000Z_speclock2-rs.jsonl"
    f.write_text('{"type":"session"}\n', encoding="utf-8")
    assert mock_client.post("/api/p/rs/agent/start", json={}).status_code == 200
    assert mock_client.get("/api/p/rs/agent").json()["running"] is True

    r = mock_client.post("/api/p/rs/agent/reset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["archived"].startswith("20261015T120000Z_speclock2-rs.archived-")
    assert body["archived"].endswith(".jsonl")
    assert not f.exists()  # 原文件已改名
    assert len(list(sess_dir.glob("*_speclock2-rs.archived-*.jsonl"))) == 1
    # 会话已停：下次 /agent 是 not running；ensure 会以同 session-id 全新启动
    assert mock_client.get("/api/p/rs/agent").json()["running"] is False


def test_agent_reset_without_session_or_file(mock_client):
    """会话未启动、无 JSONL：reset 幂等成功，不报错、无 archived 字段。"""
    _setup_project(mock_client, slug="rs2")
    r = mock_client.post("/api/p/rs2/agent/reset")
    assert r.status_code == 200
    body = r.json()
    assert body == {"ok": True}  # 可空字段省略（DESIGN §5.5 null 语义）
