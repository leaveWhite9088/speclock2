"""队列端点：任务包清单、任务派发/回执/验收、收尸、技术任务单。

本文件只做参数转换和调用。状态机、看门狗和事件写入都在 tasks/service.py。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import chief_notify, models, serialize
from ..errors import ApiError
from ..protocol import notices
from ..tasks import service
from ..tasks.service import ReceiptBody
from ..utils import fmt_id, parse_prefixed_id

router = APIRouter(prefix="/api/p/{slug}")


class DispatchBody(BaseModel):
    watchdog_minutes: float = 60


class AuditBody(BaseModel):
    result: str  # pass | fail
    note: str | None = None


class AuditAllBody(BaseModel):
    result: str = "pass"
    note: str | None = None


class TaskFailBody(BaseModel):
    reason: str
    exit_code: int | None = None
    stderr: str | None = None


class TaskOutputBody(BaseModel):
    text: str = ""


class LaunchPlanBody(BaseModel):
    prompt: str = ""


class TechOrderBody(BaseModel):
    intent: str | None = None  # 可选进入，统一在服务里做 field 定位校验
    scope: list | None = None
    baseline: dict | None = None
    acceptance: list = []
    master: str | None = "backend"  # 执行主体（决定派发哪个 harness；回执记录契约扩展）


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


def _tid(task_id: str) -> int:
    return parse_prefixed_id(task_id, "T") or -1


@router.get("/packages")
def list_packages(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    with request.app.state.db.ledger_session(slug) as session:
        packages = session.scalars(select(models.TaskPackage).order_by(models.TaskPackage.id)).all()
        tasks = session.scalars(select(models.Task).order_by(models.Task.id)).all()
        receipts = {r.task_id: r for r in session.scalars(select(models.Receipt)).all()}
        by_pkg: dict[int, list[models.Task]] = {}
        for t in tasks:
            by_pkg.setdefault(t.package_id, []).append(t)
        data = [serialize.package_out(p, by_pkg.get(p.id, []), receipts) for p in packages]
    return {"items": data}


@router.post("/tasks/{task_id}/output")
def push_task_output(slug: str, task_id: str, body: TaskOutputBody, request: Request) -> dict:
    """上报被派发进程的过程输出（节流由上报方负责）。"""
    _project_or_404(request, slug)
    service.record_task_output(request.app, slug, _tid(task_id), body.text)
    return {}


@router.post("/tasks/{task_id}/dispatch")
def dispatch_task(slug: str, task_id: str, body: DispatchBody, request: Request) -> dict:
    """手工推进 queued→dispatched（不启动进程）。非 queued 任务幂等跳过。"""
    _project_or_404(request, slug)
    if body.watchdog_minutes <= 0:
        raise ApiError(422, "validation_error", "watchdog_minutes 必须为正数")
    task, skipped = service.dispatch_service(request.app, slug, _tid(task_id), body.watchdog_minutes)
    if skipped:  # 幂等跳过（修复单 2）：进程没起来、无副作用
        return {"skipped": True, "reason": f"task in state {task.status}",
                "task": serialize.task_out(task)}
    return serialize.task_out(task)


@router.post("/tasks/{task_id}/fail")
def fail_task(slug: str, task_id: str, body: TaskFailBody, request: Request) -> dict:
    """快速失败收尸（修复单 21）：已派发未回执的任务立即标 timeout，并取消看门狗。

    timeout 状态涵盖两种未回执终局：看门狗超时和进程崩溃。
    状态不在 dispatched/running 时返回 409。
    """
    _project_or_404(request, slug)
    return service.fail_service(request.app, slug, _tid(task_id), body.reason,
                                body.exit_code, body.stderr)


@router.post("/audit-all")
def audit_all(slug: str, body: AuditAllBody, request: Request) -> dict:
    """批量验收（修复单 4）：项目内全部 reported 任务一次 audit。"""
    _project_or_404(request, slug)
    audited = service.audit_all_service(request.app, slug, body.result, body.note)
    return {"audited": len(audited), "task_ids": audited}


@router.post("/tasks/{task_id}/launch-plan")
def launch_plan(slug: str, task_id: str, body: LaunchPlanBody, request: Request) -> dict:
    """唤醒计划：返回名册 harness、harness-map 和会话接续算出的启动参数（只读诊断）。"""
    _project_or_404(request, slug)
    from ..executor import plan_task_launch

    return plan_task_launch(request.app, slug, _tid(task_id), body.prompt)


@router.post("/tasks/{task_id}/receipt")
def submit_receipt(slug: str, task_id: str, body: ReceiptBody, request: Request) -> dict:
    _project_or_404(request, slug)
    receipt = service.receipt_service(request.app, slug, _tid(task_id), body)
    with request.app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, receipt.task_id)
        data = serialize.task_out(task, receipt)
        master = task.master
        report = receipt.report
    # 落定即通知（慢工单）：后台派发时 chief 没在跟单，由通知回合把结果送回对话流
    chief_notify.enqueue(request.app, slug,
                         notices.task_completed(fmt_id("T", receipt.task_id), master, report))
    return data


@router.post("/tasks/{task_id}/audit")
def audit_task(slug: str, task_id: str, body: AuditBody, request: Request) -> dict:
    _project_or_404(request, slug)
    return service.audit_service(request.app, slug, _tid(task_id), body.result, body.note)


@router.post("/tech-orders", status_code=201)
def create_tech_order(slug: str, body: TechOrderBody, request: Request) -> dict:
    _project_or_404(request, slug)
    return service.create_tech_order_service(
        request.app, slug, body.intent, body.scope, body.baseline, body.acceptance, body.master)
