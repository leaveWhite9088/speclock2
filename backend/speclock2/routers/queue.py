"""队列：任务包清单、任务状态机（dispatch/receipt/audit）、看门狗、技术任务单。"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import flow, models, serialize
from ..errors import ApiError
from ..utils import fmt_id, now_iso, parse_prefixed_id

router = APIRouter(prefix="/api/p/{slug}")

# M1 任务链（手工模拟，跳过 running/auditing）：queued→dispatched→reported→done|rejected；dispatched→timeout
VALID_TRANSITIONS = {
    "queued": {"dispatched"},
    "dispatched": {"reported", "timeout"},
    "reported": {"done", "rejected"},
    "done": set(),
    "rejected": set(),
    "timeout": set(),
}


class DispatchBody(BaseModel):
    watchdog_minutes: float = 60


class ReceiptBody(BaseModel):
    files_changed: list = []
    self_check: str = ""
    summary: str = ""
    telemetry: dict | None = None  # 过程遥测（时长/token，解析不到标估算）——契约扩展见回执


class AuditBody(BaseModel):
    result: str  # pass | fail
    note: str | None = None


class TechOrderBody(BaseModel):
    intent: str | None = None  # 可选进入，统一在端点内做 field 定位校验
    scope: list | None = None
    baseline: dict | None = None
    acceptance: list = []


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


def _task_or_404(session, task_id: str) -> models.Task:
    task = session.get(models.Task, parse_prefixed_id(task_id, "T"))
    if task is None:
        raise ApiError(404, "not_found", f"任务不存在：{task_id}")
    return task


def _transition(task: models.Task, to_status: str) -> None:
    if to_status not in VALID_TRANSITIONS.get(task.status, set()):
        raise ApiError(409, "conflict", f"非法状态迁移：{task.status} → {to_status}")


def _start_watchdog(db, timers: set, slug: str, task_id: int, deadline: datetime) -> None:
    """内存看门狗：到期仍未回执（dispatched）→ timeout + task.timeout 事件（§9.4）。"""
    delay = max((deadline - datetime.now().astimezone()).total_seconds(), 0.1)

    def fire() -> None:
        timers.discard(timer)
        try:
            with db.ledger_session(slug) as session:
                task = session.get(models.Task, task_id)
                if task is None or task.status != "dispatched":
                    return  # 已回执/已处理，忽略
                task.status = "timeout"
                task.updated_at = now_iso()
                round_ = flow.get_open_round(session)
                flow.add_event(
                    session, round_.n if round_ else 0, "system", "task.timeout",
                    {"task": fmt_id("T", task_id)}, {"deadline": task.watchdog_deadline},
                )
                session.commit()
        except Exception:
            pass  # 看门狗尽力而为，不向外抛

    timer = threading.Timer(delay, fire)
    timer.daemon = True
    timers.add(timer)
    timer.start()


def dispatch_service(db, timers: set, slug: str, task_id: int, watchdog_minutes: float) -> models.Task:
    """queued→dispatched + deadline + 事件 + 启动看门狗（端点与派发执行器共用）。"""
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{task_id}")
        _transition(task, "dispatched")
        deadline = datetime.now().astimezone() + timedelta(minutes=watchdog_minutes)
        task.status = "dispatched"
        task.watchdog_deadline = deadline.isoformat(timespec="seconds")
        task.updated_at = now_iso()
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "human", "task.dispatched",
            {"task": fmt_id("T", task.id)}, {"watchdog_deadline": task.watchdog_deadline},
        )
        session.commit()
        session.refresh(task)
        snapshot = task
    _start_watchdog(db, timers, slug, task_id, deadline)
    return snapshot


def receipt_service(db, slug: str, task_id: int, body: ReceiptBody) -> models.Receipt:
    """dispatched→reported + 回执落库 + 事件（端点与派发执行器共用）。"""
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{task_id}")
        _transition(task, "reported")
        receipt = models.Receipt(
            task_id=task.id,
            files_changed=body.files_changed,
            self_check=body.self_check,
            summary=body.summary,
            telemetry=body.telemetry,
            created_at=now_iso(),
        )
        session.add(receipt)
        task.status = "reported"
        task.updated_at = now_iso()
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "human", "task.receipt",
            {"task": fmt_id("T", task.id)},
            {"files_changed": body.files_changed, "self_check": body.self_check,
             "summary": body.summary, "telemetry": body.telemetry},
        )
        session.commit()
        session.refresh(receipt)
        return receipt


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


@router.post("/tasks/{task_id}/dispatch")
def dispatch_task(slug: str, task_id: str, body: DispatchBody, request: Request) -> dict:
    _project_or_404(request, slug)
    if body.watchdog_minutes <= 0:
        raise ApiError(422, "validation_error", "watchdog_minutes 必须为正数")
    task = dispatch_service(
        request.app.state.db, request.app.state.timers, slug,
        parse_prefixed_id(task_id, "T") or -1, body.watchdog_minutes,
    )
    return serialize.task_out(task)


@router.post("/tasks/{task_id}/receipt")
def submit_receipt(slug: str, task_id: str, body: ReceiptBody, request: Request) -> dict:
    _project_or_404(request, slug)
    receipt = receipt_service(request.app.state.db, slug, parse_prefixed_id(task_id, "T") or -1, body)
    with request.app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, receipt.task_id)
        data = serialize.task_out(task, receipt)
    return data


@router.post("/tasks/{task_id}/audit")
def audit_task(slug: str, task_id: str, body: AuditBody, request: Request) -> dict:
    _project_or_404(request, slug)
    if body.result not in ("pass", "fail"):
        raise ApiError(422, "validation_error", "result 必须是 pass 或 fail")
    with request.app.state.db.ledger_session(slug) as session:
        task = _task_or_404(session, task_id)
        to_status = "done" if body.result == "pass" else "rejected"
        _transition(task, to_status)
        run = models.AuditRun(
            task_id=task.id,
            level="machine",  # M1 人工模拟机器审计
            result=body.result,
            details={"note": body.note} if body.note else None,
            created_at=now_iso(),
        )
        session.add(run)
        task.status = to_status
        task.updated_at = now_iso()
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "human",
            "audit.machine.passed" if body.result == "pass" else "audit.machine.failed",
            {"task": fmt_id("T", task.id)}, {"note": body.note},
        )
        session.commit()
        session.refresh(task)
        data = serialize.task_out(task)
    return data


@router.post("/tech-orders", status_code=201)
def create_tech_order(slug: str, body: TechOrderBody, request: Request) -> dict:
    """技术任务单（DESIGN.md §6.4）：不动业务的变更，不进版本链；M1 创建即视为确认。"""
    _project_or_404(request, slug)
    errors: list[dict] = []
    if not isinstance(body.intent, str) or not body.intent.strip():
        errors.append({"field": "intent", "message": "intent 不能为空（必须能回答'为什么动'）"})
    if not body.scope or not isinstance(body.scope, list):
        errors.append({"field": "scope", "message": "scope 不能为空（范围声明 = 技术任务的契约）"})
    if errors:
        raise ApiError(422, "validation_error", "技术任务单校验失败", details={"errors": errors})
    scope = body.scope or []

    with request.app.state.db.ledger_session(slug) as session:
        round_ = flow.get_open_round(session) or flow.open_round(session, 1)
        package = models.TaskPackage(origin="tech", round=round_.n, version_refs={}, created_at=now_iso())
        session.add(package)
        session.flush()
        # 技术单任务 master 待定（null），派发前由人指定——M1 由 dispatch 直接派发
        task = models.Task(package_id=package.id, master=None, status="queued",
                           created_at=now_iso(), updated_at=now_iso())
        session.add(task)
        session.flush()
        order = models.TechOrder(
            intent=body.intent.strip(),
            scope=scope,
            baseline=body.baseline,
            acceptance=body.acceptance,
            package_id=package.id,
            created_at=now_iso(),
        )
        session.add(order)
        session.flush()
        flow.add_event(
            session, round_.n, "human", "tech.order",
            {"order": fmt_id("O", order.id), "package": fmt_id("P", package.id)},
            {"order": serialize.tech_order_out(order)},
        )
        session.commit()
        session.refresh(order)
        data = serialize.tech_order_out(order)
    return data
