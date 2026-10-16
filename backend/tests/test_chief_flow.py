"""修复单 17/19：核心代理建任务通道——tech-orders 带 task_id、master 名册校验、
audit-all 只碰 reported、create_task→dispatch 全链（名册主代理 + 替身 harness）；
修复单 19：dispatch 404 纠偏回路、create_task(prompt) 一步派发、路径纪律、agent/reset。"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from speclock2 import models
from speclock2.utils import now_iso
from tests.test_s2 import _setup_project

CHIEF_TS = Path(__file__).parent.parent.parent / "chief" / "extension" / "index.ts"
CHIEF_ROLE = Path(__file__).parent.parent / "speclock2" / "roles" / "templates" / "chief.md"
FAKE = Path(__file__).parent.parent / "scripts" / "fake_harness.py"


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
    """源码级（修复单 19/慢工单）：404 纠偏回路、异步一步派发、路径纪律、宪法同步。"""
    src = CHIEF_TS.read_text(encoding="utf-8")
    # 1. dispatch 404 → 纠偏引导，不许裸抛
    assert "err.status === 404" in src
    assert "你不能编造任务号" in src
    assert "不是通道故障" in src
    # 2. 派发异步化：工具只调后端接口，进程由后端持有（契约 v0.6）
    assert "/dispatch-package" in src and "/run`" in src
    assert "create_package" in src
    assert "系统通知你" in src  # 工具结果告知模型：结果由通知回合送达
    # 3. 路径纪律移到后端：扩展只转述 422 host_path_in_instructions
    assert "host_path_in_instructions" in src
    assert "改写成「在你的工作目录下创建" in src
    assert "master_unknown" in src and "project_unbound" in src
    # 5. 宪法：异步语义 + 回执为准 + FILES 约定 + 404 应对
    # 工具用法规则已从角色文档移到 TypeScript 扩展的 promptGuidelines（契约 v0.6）
    assert "派发是异步的" in src
    assert "以通知为准" in src
    assert "回合内重试" in src
    c = CHIEF_ROLE.read_text(encoding="utf-8")
    assert "FILES:" not in c and "dispatch" not in c  # 角色文档不含工具用法


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
    from speclock2.protocol import report as report_mod
    text = [json.loads(l)["message"]["content"][0]["text"] for l in proc.stdout.splitlines()
            if '"message_end"' in l][-1]
    files = report_mod.parse_output(text)["files_changed"]
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


# ---------- 修复单 21：provider 按 harness 分治 + 派发快速失败收尸 ----------


def test_launch_plan_composes_mcode_provider_dialect(client, tmp_path):
    """回归：mcode 主代理绑定 provider=minimax（mcode 自己的方言）→
    launch-plan 的 --model 是 minimax/MiniMax-M3，不被 pi 词表/迁移改写。"""
    _setup_project(client, slug="md")
    assert client.post("/api/models", json={
        "harness": "mcode", "model": "MiniMax-M3", "provider": "minimax"}).status_code == 201
    # harness-map：mcode 条目挂替身进程，模板带 --model {model}（模拟 mcode 启动模板）
    cfg = {"watchdog_minutes_default": 60, "masters": {}, "harnesses": {
        "mcode": {"command": sys.executable, "args": [str(FAKE), "--model", "{model}"],
                  "prompt_mode": "arg"}}}
    (client.app.state.db.settings.data_dir / "harness-map.json").write_text(
        json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    _fake_pi_session(tmp_path)
    r = client.post("/api/p/md/masters", json={
        "name": "m主代理", "duty": "d", "dir": ".", "harness": "mcode",
        "model": "MiniMax-M3", "session": "pi-chief-flow"})
    assert r.status_code in (200, 201), r.text
    assert r.json()["provider"] == "minimax"  # 名册方言原样保留
    repo = tmp_path / "md-repo"
    repo.mkdir(parents=True)
    assert client.patch("/api/p/md", json={"working_dir": str(repo)}).status_code == 200
    order = client.post("/api/p/md/tech-orders", json={
        "intent": "hello", "scope": ["./"], "master": "m主代理"}).json()
    assert client.post(f"/api/p/md/tasks/{order['task_id']}/dispatch",
                       json={"watchdog_minutes": 30}).status_code == 200
    plan = client.post(f"/api/p/md/tasks/{order['task_id']}/launch-plan",
                       json={"prompt": "hi"}).json()
    assert plan["model"] == "minimax/MiniMax-M3"
    i = plan["argv"].index("--model")
    assert plan["argv"][i + 1] == "minimax/MiniMax-M3"


def test_fail_endpoint_fast_reap(client):
    """修复单 21：/fail 快速收尸——立即 timeout、取消看门狗定时器、
    task.timeout 事件 payload 附 reason/exit_code/stderr 尾部。"""
    _setup_project(client, slug="fl")
    order = client.post("/api/p/fl/tech-orders", json={
        "intent": "崩溃收尸", "scope": ["./"], "master": "backend"}).json()
    task_id = order["task_id"]
    assert client.post(f"/api/p/fl/tasks/{task_id}/dispatch",
                       json={"watchdog_minutes": 60}).json()["status"] == "dispatched"
    tid = int(task_id.split("-")[1])
    timers = client.app.state.timers
    assert any(getattr(t, "task_id", None) == tid for t in timers)  # 看门狗在值守

    r = client.post(f"/api/p/fl/tasks/{task_id}/fail", json={
        "reason": "被派发进程异常退出（码 2）", "exit_code": 2, "stderr": "boom"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "timeout"
    assert not any(getattr(t, "task_id", None) == tid for t in timers)  # 定时器已取消
    ev = client.get("/api/p/fl/events", params={"type": "task.timeout"}).json()["items"]
    assert ev and ev[0]["payload"]["reason"] == "被派发进程异常退出（码 2）"
    assert ev[0]["payload"]["exit_code"] == 2
    assert ev[0]["payload"]["stderr_tail"] == "boom"
    # 状态防御：已终态再 fail → 409；reason 空 → 422
    assert client.post(f"/api/p/fl/tasks/{task_id}/fail", json={"reason": "x"}).status_code == 409
    order2 = client.post("/api/p/fl/tech-orders", json={
        "intent": "t2", "scope": ["./"], "master": "backend"}).json()
    assert client.post(f"/api/p/fl/tasks/{order2['task_id']}/fail",
                       json={"reason": "  "}).status_code == 422


def test_chief_ts_has_no_spawn():
    """源码级（契约 v0.6）：扩展里不再有 spawn 和后台跟单，派发只有后端一份实现。"""
    src = CHIEF_TS.read_text(encoding="utf-8")
    for word in ("spawn", "monitorDispatch", "startDispatch", "promptHasHostPath"):
        assert word not in src, word


def test_launch_plan_drops_resume_on_workspace_mismatch(client, tmp_path, monkeypatch):
    """慢工单接缝：绑定的 mcode 会话源自别的目录 → launch-plan 放弃接续
    （新会话），避免 mcode「Session workspace does not match --cwd」秒败。"""
    _setup_project(client, slug="wm")
    assert client.post("/api/models", json={
        "harness": "mcode", "model": "fake-m"}).status_code == 201
    cfg = {"watchdog_minutes_default": 60, "masters": {}, "harnesses": {
        "mcode": {"command": sys.executable, "args": [str(FAKE), "{prompt}"],
                  "prompt_mode": "inline",
                  "resume_args": ["--session", "{session_id}", "--session-dir", "{session_dir}"]}}}
    (client.app.state.db.settings.data_dir / "harness-map.json").write_text(
        json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
    # 两个 mcode 会话：一个 cwd 是别的目录，一个 cwd 就是项目绑定目录
    root = tmp_path / "mm-sess"
    other = root / "2026" / "10" / "15" / "10-00-00-000-session_other"
    other.mkdir(parents=True)
    (other / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs_other_dir", "createdAtMs": 1}), encoding="utf-8")
    repo = tmp_path / "wm-repo"
    repo.mkdir(parents=True)
    here = root / "2026" / "10" / "15" / "10-00-01-000-session_here"
    here.mkdir(parents=True)
    (here / "manifest.json").write_text(json.dumps(
        {"sessionId": "mvs_here_dir", "createdAtMs": 2}), encoding="utf-8")
    (here / "messages.jsonl").write_text(
        json.dumps({"agent-context": {"cwd": str(repo)}}) + "\n", encoding="utf-8")
    monkeypatch.setenv("SPECLOCK2_MCODE_SESSIONS_DIR", str(root))

    def _mk(name: str, session: str) -> None:
        r = client.post("/api/p/wm/masters", json={
            "name": name, "duty": "d", "dir": ".", "harness": "mcode",
            "model": "fake-m", "session": session})
        assert r.status_code in (200, 201), r.text

    _mk("别目录代理", "mvs_other_dir")
    _mk("同目录代理", "mvs_here_dir")
    assert client.patch("/api/p/wm", json={"working_dir": str(repo)}).status_code == 200

    for name, expect_resume in (("别目录代理", False), ("同目录代理", True)):
        order = client.post("/api/p/wm/tech-orders", json={
            "intent": "x", "scope": ["./"], "master": name}).json()
        r = client.post(f"/api/p/wm/tasks/{order['task_id']}/dispatch",
                        json={"watchdog_minutes": 30})
        if not expect_resume:  # 秒败路径不用真跑：只看 launch-plan 的 argv
            client.post(f"/api/p/wm/tasks/{order['task_id']}/fail",
                        json={"reason": "清理"})
        plan = client.post(f"/api/p/wm/tasks/{order['task_id']}/launch-plan",
                           json={"prompt": "hi"}).json()
        has_resume = "--session" in plan["argv"]
        assert has_resume is expect_resume, (name, plan["argv"])
