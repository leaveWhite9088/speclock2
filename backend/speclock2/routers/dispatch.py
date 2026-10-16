"""派发端点（契约 v0.6）：dispatch-package 与 tasks/{id}/run。

两个端点都只创建账本记录并启动进程，随后立即返回。
进程由后端持有并监控，结果经回执、task.report 事件和系统通知回到核心代理。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import executor, flow, models
from ..errors import ApiError
from ..utils import fmt_id, now_iso, parse_prefixed_id

router = APIRouter(prefix="/api/p/{slug}")


class PackageTask(BaseModel):
    master: str | None = None
    instructions: str = ""
    scope: list[str] = []
    acceptance: list[str] = []


class DispatchPackageBody(BaseModel):
    intent: str = ""
    tasks: list[PackageTask] = []
    watchdog_minutes: float | None = None


class RunBody(BaseModel):
    instructions: str = ""
    watchdog_minutes: float | None = None


def _project_dir(request: Request, slug: str) -> str:
    with request.app.state.db.registry_session() as registry:
        project = registry.get(models.Project, slug)
        if project is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")
        return (project.working_dir or "").strip()


def _check_host_path(text: str, field: str) -> None:
    if executor.has_host_path(text):
        raise ApiError(
            422, "host_path_in_instructions",
            f"{field} 含工作台仓库的绝对路径。请只写相对路径，工作目录由工作台按名册指定。",
        )


@router.post("/dispatch-package", status_code=201)
async def dispatch_package(slug: str, body: DispatchPackageBody, request: Request) -> dict:
    """创建技术单与任务包，并行启动包内全部任务，立即返回。"""
    app = request.app
    project_dir = _project_dir(request, slug)
    errors: list[dict] = []
    if not body.intent.strip():
        errors.append({"field": "intent", "message": "intent 不能为空（必须能回答'为什么动'）"})
    if not body.tasks:
        errors.append({"field": "tasks", "message": "tasks 不能为空"})
    for i, t in enumerate(body.tasks):
        if not t.instructions.strip():
            errors.append({"field": f"tasks[{i}].instructions", "message": "instructions 不能为空"})
    if errors:
        raise ApiError(422, "validation_error", "派发包校验失败", details={"errors": errors})
    for i, t in enumerate(body.tasks):
        _check_host_path(t.instructions, f"tasks[{i}].instructions")
    _check_host_path(body.intent, "intent")

    db = app.state.db
    created: list[tuple[int, PackageTask]] = []
    with db.ledger_session(slug) as session:
        rows = {m.name: m for m in session.scalars(select(models.Master)).all()}
        names = list(rows)
        for t in body.tasks:
            # 名册为空（纯替身自测）保持宽松：master 随便填，映射落替身
            if names and t.master not in rows:
                raise ApiError(
                    422, "master_unknown",
                    f"master {t.master!r} 不在名册，可用：{'、'.join(names)}",
                    details={"available": names},
                )
            row = rows.get(t.master)
            executor._resolve_dispatch_cwd((row.working_dir or "").strip() if row else "", project_dir)

        round_ = flow.get_open_round(session) or flow.open_round(session, 1)
        package = models.TaskPackage(origin="tech", round=round_.n, version_refs={}, created_at=now_iso())
        session.add(package)
        session.flush()
        for t in body.tasks:
            task = models.Task(package_id=package.id, master=t.master, status="queued",
                               created_at=now_iso(), updated_at=now_iso())
            session.add(task)
            session.flush()
            created.append((task.id, t))
        scope = [s for _, t in created for s in t.scope]
        acceptance = [a for _, t in created for a in t.acceptance]
        order = models.TechOrder(
            intent=body.intent.strip(), scope=scope, baseline=None, acceptance=acceptance,
            package_id=package.id, created_at=now_iso(),
        )
        session.add(order)
        session.flush()
        flow.add_event(
            session, round_.n, "human", "tech.order",
            {"order": fmt_id("O", order.id), "package": fmt_id("P", package.id)},
            {"order": {"id": fmt_id("O", order.id), "intent": order.intent, "scope": scope,
                       "acceptance": acceptance}},
        )
        session.commit()
        package_id, order_id = package.id, order.id

    results = []
    for task_id, t in created:
        started = await executor.start_task(
            app, slug, task_id, t.instructions,
            intent=body.intent.strip(), scope=t.scope, acceptance=t.acceptance,
            watchdog_minutes=body.watchdog_minutes,
        )
        results.append({
            "task_id": fmt_id("T", task_id), "master": t.master,
            "status": "dispatched" if started.outcome == "started" else started.outcome,
        })
    return {"package_id": fmt_id("P", package_id), "order_id": fmt_id("O", order_id), "tasks": results}


@router.post("/tasks/{task_id}/run")
async def run_task(slug: str, task_id: str, body: RunBody, request: Request) -> dict:
    """启动一个 queued 任务，立即返回。非 queued 任务返回 skipped，不动进程。"""
    app = request.app
    _project_dir(request, slug)
    numeric = parse_prefixed_id(task_id, "T")
    _check_host_path(body.instructions, "instructions")
    started = await executor.start_task(app, slug, numeric, body.instructions,
                                        watchdog_minutes=body.watchdog_minutes)
    with app.state.db.ledger_session(slug) as session:
        from .. import serialize

        task = session.get(models.Task, numeric)
        data = serialize.task_out(task)
    if started.outcome == "skipped":
        return {"skipped": True, "task": data}
    return {"skipped": False, "outcome": started.outcome, "task": data}
