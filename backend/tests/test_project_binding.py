"""契约 v0.4：项目绑定目录、核心代理模型按项目生效、目录浏览、派发 cwd 三级解析。

核心事故回归：派发 cwd 不再落工作台仓库根——masters.working_dir →
projects.working_dir → 都无则 422「项目未绑定目标仓库，拒绝派发」。
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from speclock2 import dispatcher, models, pi_runtime
from speclock2.utils import now_iso
from tests.test_s2 import _setup_project

FAKE = Path(__file__).parent.parent / "scripts" / "fake_harness.py"
WORKBENCH_ROOT = Path(dispatcher.__file__).resolve().parent.parent.parent


def _mk_repo(tmp_path: Path, name: str = "target-repo") -> Path:
    repo = tmp_path / name
    repo.mkdir(parents=True, exist_ok=True)
    return repo


def _write_map(data_dir: Path, args: list[str] | None = None, masters: dict | None = None) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    cfg = {
        "watchdog_minutes_default": 60,
        "masters": masters or {},
        "harnesses": {
            "t": {"command": sys.executable, "args": args or [str(FAKE), "-p", "{prompt}"],
                  "prompt_mode": "inline"},
        },
    }
    (data_dir / "harness-map.json").write_text(json.dumps(cfg, ensure_ascii=False),
                                               encoding="utf-8")


def _tech_order_task(client: TestClient, slug: str = "a", master: str | None = "backend") -> str:
    body = {"intent": "最小任务", "scope": ["./"], "acceptance": ["完成"],
            "master": master}
    r = client.post(f"/api/p/{slug}/tech-orders", json=body)
    assert r.status_code in (200, 201), r.text
    tasks = client.get(f"/api/p/{slug}/packages").json()["items"][-1]["tasks"]
    return tasks[-1]["task_id"]


# ---------- 项目绑定：创建 / 查询 / PATCH ----------


def test_create_project_with_binding(client, tmp_path):
    repo = _mk_repo(tmp_path, "bind-create")
    r = client.post("/api/projects", json={
        "slug": "b1", "name": "项目B", "working_dir": str(repo),
        "chief_provider": "minimax-cn", "chief_model": "MiniMax-M3"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["working_dir"] == str(repo.resolve())
    assert body["chief_provider"] == "minimax-cn" and body["chief_model"] == "MiniMax-M3"
    # 列表与详情都带新字段
    item = client.get("/api/projects").json()["items"][-1]
    assert item["slug"] == "b1" and item["working_dir"] == str(repo.resolve())
    detail = client.get("/api/p/b1").json()
    assert detail["chief_model"] == "MiniMax-M3"


def test_create_project_binding_validation(client, tmp_path):
    # 目录不存在 → 422
    r = client.post("/api/projects", json={
        "slug": "b2", "name": "x", "working_dir": str(tmp_path / "nope")})
    assert r.status_code == 422 and r.json()["code"] == "validation_error"
    # 是文件不是目录 → 422
    f = tmp_path / "afile.txt"
    f.write_text("x", encoding="utf-8")
    r = client.post("/api/projects", json={"slug": "b2", "name": "x", "working_dir": str(f)})
    assert r.status_code == 422 and "不是目录" in r.json()["message"]
    # 不传/传空 = 未绑定
    r = client.post("/api/projects", json={"slug": "b2", "name": "x", "working_dir": "  "})
    assert r.status_code == 201 and r.json()["working_dir"] is None


def test_patch_project_binding(client, tmp_path):
    _setup_project(client, slug="b3")
    repo = _mk_repo(tmp_path, "bind-patch")
    # 只传 working_dir：另两字段不动
    r = client.patch("/api/p/b3", json={"working_dir": str(repo)})
    assert r.status_code == 200 and r.json()["working_dir"] == str(repo.resolve())
    # 再只传 chief_model：working_dir 保持
    r = client.patch("/api/p/b3", json={"chief_model": "glm-4.7"})
    assert r.json()["chief_model"] == "glm-4.7"
    assert r.json()["working_dir"] == str(repo.resolve())
    assert r.json()["chief_provider"] is None
    # 显式 "" 清空
    r = client.patch("/api/p/b3", json={"chief_model": ""})
    assert r.json()["chief_model"] is None
    # 校验：坏目录 422；项目不存在 404
    assert client.patch("/api/p/b3", json={
        "working_dir": str(tmp_path / "nope")}).status_code == 422
    assert client.patch("/api/p/none", json={"chief_model": "x"}).status_code == 404


# ---------- /api/fs/dirs ----------


def test_fs_dirs(client, tmp_path):
    root = tmp_path / "browse"  # 独立子树：避开 data_dir 夹具建的 data/
    root.mkdir()
    (root / "beta").mkdir()
    (root / "Alpha").mkdir()
    (root / "file.txt").write_text("x", encoding="utf-8")
    r = client.get("/api/fs/dirs", params={"path": str(root)})
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["name"] for i in items] == ["Alpha", "beta"]  # 只列子目录，名排序
    assert items[0]["path"] == str(root / "Alpha")
    # 异常路径
    assert client.get("/api/fs/dirs", params={"path": str(root / "nope")}).status_code == 422
    assert client.get("/api/fs/dirs", params={"path": str(root / "file.txt")}).status_code == 422
    assert client.get("/api/fs/dirs").status_code == 422  # 缺参数


# ---------- 派发 cwd 三级解析 ----------


def _launch(client: TestClient, task_id: str):
    return client.post(f"/api/p/a/tasks/{task_id}/launch-plan", json={"prompt": "只回复一个词：hello"})


def test_cwd_project_binding_only(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "cwd-proj")
    client.patch("/api/p/a", json={"working_dir": str(repo)})
    _write_map(data_dir)
    task_id = _tech_order_task(client, master=None)  # 无名册 → 项目目录兜底
    plan = _launch(client, task_id).json()
    assert Path(plan["cwd"]) == repo


def test_cwd_master_absolute_overrides_project(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "cwd-proj")
    abs_dir = _mk_repo(tmp_path, "cwd-master-abs")
    client.patch("/api/p/a", json={"working_dir": str(repo)})
    _write_map(data_dir)
    _add_master_direct(client, str(abs_dir))
    task_id = _tech_order_task(client)
    plan = _launch(client, task_id).json()
    assert Path(plan["cwd"]) == abs_dir  # 主代理绝对目录优先于项目目录


def _add_master_direct(client: TestClient, working_dir: str, name: str = "backend") -> None:
    """直接建名册行（登记校验路径已在 masters 测试覆盖；这里聚焦 cwd/模型语义）。"""
    with client.app.state.db.ledger_session("a") as s:
        s.add(models.Master(name=name, role="r", harness="t", model=None,
                            working_dir=working_dir, session_policy=None, created_at=now_iso()))
        s.commit()


def test_cwd_master_relative_joins_project(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "cwd-rel")
    (repo / "web").mkdir()
    client.patch("/api/p/a", json={"working_dir": str(repo)})
    _write_map(data_dir)
    _add_master_direct(client, "web")
    task_id = _tech_order_task(client)
    plan = _launch(client, task_id).json()
    assert Path(plan["cwd"]) == repo / "web"


def test_cwd_refuses_when_unbound(client, data_dir):
    _setup_project(client)  # 不绑定
    _write_map(data_dir)
    task_id = _tech_order_task(client, master=None)
    r = _launch(client, task_id)
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "project_unbound"
    assert "项目未绑定目标仓库" in body["message"]


def test_cwd_refuses_when_master_relative_but_project_unbound(client, data_dir):
    _setup_project(client)  # 项目未绑定，主代理相对目录没有拼接基准
    _write_map(data_dir)
    _add_master_direct(client, "web")
    task_id = _tech_order_task(client)
    r = _launch(client, task_id)
    assert r.status_code == 422 and r.json()["code"] == "project_unbound"


def test_cwd_refuses_when_target_dir_missing(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "cwd-gone")
    client.patch("/api/p/a", json={"working_dir": str(repo)})
    _write_map(data_dir)
    _add_master_direct(client, "gone")  # repo/gone 不存在
    task_id = _tech_order_task(client)
    r = _launch(client, task_id)
    assert r.status_code == 422 and "不存在" in r.json()["message"]


# ---------- 模型注入模板（{model}） ----------

MODEL_ARGS = [str(FAKE), "--model", "{model}", "-p", "{prompt}"]


def test_model_from_roster_registration(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "mdl-roster")
    client.patch("/api/p/a", json={"working_dir": str(repo), "chief_model": "proj-model"})
    _write_map(data_dir, args=MODEL_ARGS)
    _add_master_direct(client, str(repo), name="backend")
    # 名册登记了模型（直接改行，登记校验路径已在 masters 测试覆盖）
    with client.app.state.db.ledger_session("a") as s:
        row = s.query(models.Master).filter_by(name="backend").first()
        row.model = "glm-4.7"
        s.commit()
    plan = _launch(client, _tech_order_task(client)).json()
    argv = plan["argv"]
    assert argv[argv.index("--model") + 1] == "glm-4.7"  # 名册优先于项目核心代理模型
    assert plan["model"] == "glm-4.7"


def test_model_falls_back_to_project_chief(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "mdl-proj")
    client.patch("/api/p/a", json={
        "working_dir": str(repo), "chief_provider": "minimax-cn", "chief_model": "MiniMax-M3"})
    _write_map(data_dir, args=MODEL_ARGS)
    task_id = _tech_order_task(client, master=None)  # 无名册 → 项目核心代理模型兜底
    argv = _launch(client, task_id).json()["argv"]
    assert argv[argv.index("--model") + 1] == "minimax-cn/MiniMax-M3"


def test_model_placeholder_dropped_when_no_model(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "mdl-none")
    client.patch("/api/p/a", json={"working_dir": str(repo)})
    _write_map(data_dir, args=MODEL_ARGS)
    task_id = _tech_order_task(client, master=None)
    argv = _launch(client, task_id).json()["argv"]
    assert "--model" not in argv and "{model}" not in argv  # 无模型 → flag 连占位一起摘除
    assert "-p" in argv  # 其余参数完好


# ---------- 端到端：派发只写目标仓库 ----------


def test_run_task_writes_into_bound_repo_never_workbench(client, data_dir, tmp_path):
    _setup_project(client)
    repo = _mk_repo(tmp_path, "cwd-e2e")
    client.patch("/api/p/a", json={"working_dir": str(repo)})
    _write_map(data_dir)
    task_id = _tech_order_task(client, master=None)

    from speclock2.utils import parse_prefixed_id

    result = asyncio_run(dispatcher.run_task(
        client.app, "a", parse_prefixed_id(task_id, "T"), "FILE: hello-e2e.txt"))
    assert result["outcome"] == "reported"
    assert (repo / "hello-e2e.txt").exists()
    # 工作台仓库根没有新增文件（事故回归守卫）
    assert not (WORKBENCH_ROOT / "hello-e2e.txt").exists()


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)


# ---------- /agent 生效配置 ----------


def test_agent_reports_effective_chief(client):
    _setup_project(client, slug="b9")
    # 无项目配置、无 env → source=env、值空
    chief = client.get("/api/p/b9/agent").json()["chief"]
    assert chief == {"provider": None, "model": None, "source": "env"}
    # 项目配置后 → source=project、值生效
    client.patch("/api/p/b9", json={"chief_provider": "minimax-cn", "chief_model": "MiniMax-M3"})
    chief = client.get("/api/p/b9/agent").json()["chief"]
    assert chief == {"provider": "minimax-cn", "model": "MiniMax-M3", "source": "project"}


def test_effective_chief_db_function(client):
    _setup_project(client, slug="b10")
    db = client.app.state.db
    assert pi_runtime.effective_chief(db, "b10")["source"] == "env"
    with db.registry_session() as s:
        p = s.get(models.Project, "b10")
        p.chief_model = "m2"
        s.commit()
    chief = pi_runtime.effective_chief(db, "b10")
    assert chief == {"provider": None, "model": "m2", "source": "project"}
