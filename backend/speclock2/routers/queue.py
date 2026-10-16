"""队列：任务包清单、任务状态机（dispatch/receipt/audit）、看门狗、技术任务单。"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta
from pathlib import Path

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
    master: str | None = "backend"  # 执行主体（决定派发哪个 harness；回执记录契约扩展）


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


def _start_watchdog(app, db, timers: set, slug: str, task_id: int, deadline: datetime) -> None:
    """内存看门狗：到期仍未回执 → timeout + task.timeout 事件（§9.4）。
    定时器带 slug/task_id 标记（修复单 21）：/fail 收尸时按任务精确定位取消。"""
    delay = max((deadline - datetime.now().astimezone()).total_seconds(), 0.1)

    def fire() -> None:
        timers.discard(timer)
        try:
            _mark_task_timeout(app, db, slug, task_id)
        except Exception:
            pass  # 看门狗尽力而为，不向外抛

    timer = threading.Timer(delay, fire)
    timer.daemon = True
    timer.slug = slug  # type: ignore[attr-defined]
    timer.task_id = task_id  # type: ignore[attr-defined]
    timers.add(timer)
    timer.start()


def _cancel_watchdog(timers: set, slug: str, task_id: int) -> bool:
    """取消指定任务的看门狗定时器（修复单 21 快速收尸用）；返回是否找到。"""
    for t in list(timers):
        if getattr(t, "slug", None) == slug and getattr(t, "task_id", None) == task_id:
            t.cancel()
            timers.discard(t)
            return True
    return False


ZOMBIE_STATUSES = ("dispatched", "running")  # 已派发未回执的状态（看门狗管辖范围）


def _mark_task_timeout(app, db, slug: str, task_id: int) -> bool:
    """僵尸任务收尸：仍处 dispatched/running → timeout + task.timeout 事件；返回是否标记。
    收尸即通知（慢工单）：chief 没在跟单时，由通知回合把超时事实送回对话流。"""
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None or task.status not in ZOMBIE_STATUSES:
            return False  # 已回执/已处理，忽略
        task.status = "timeout"
        task.updated_at = now_iso()
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "system", "task.timeout",
            {"task": fmt_id("T", task_id)}, {"deadline": task.watchdog_deadline},
        )
        session.commit()
        session.refresh(task)
        master = task.master
    from .. import chief_notify
    chief_notify.enqueue(
        app, slug,
        f"系统通知：任务 {fmt_id('T', task_id)}（{master or '未指派'}）看门狗超时"
        f"（期限 {task.watchdog_deadline}），未收到回执。"
        "请向用户转述：任务未完成；过程输出里可能有线索，不要臆测原因。",
    )
    return True


def rearm_watchdogs(app, ledgers_dir) -> dict:
    """重启后重建看门狗（追加项 9）：定时器是内存态，进程重启即丢。

    扫描全部账本里 dispatched/running 的僵尸任务，按落库的 watchdog_deadline
    重武装；已过期（或无 deadline）的立即收尸标 timeout。派发时落库的
    dispatched_at/watchdog_minutes 是 deadline 的来源与审计字段。
    """
    db = app.state.db
    timers = app.state.timers
    stats = {"zombies": 0, "rearmed": 0, "timed_out": 0}
    ledgers_dir = Path(ledgers_dir)
    if not ledgers_dir.is_dir():
        return stats
    now = datetime.now().astimezone()
    for db_file in sorted(ledgers_dir.glob("*.db")):
        slug = db_file.stem
        with db.ledger_session(slug) as session:
            rows = [
                (t.id, t.watchdog_deadline)
                for t in session.scalars(
                    select(models.Task).where(models.Task.status.in_(ZOMBIE_STATUSES))
                ).all()
            ]
        for task_id, deadline_str in rows:
            stats["zombies"] += 1
            try:
                deadline = datetime.fromisoformat(deadline_str)
            except (TypeError, ValueError):
                deadline = None
            if deadline is not None and deadline > now:
                _start_watchdog(app, db, timers, slug, task_id, deadline)
                stats["rearmed"] += 1
            elif _mark_task_timeout(app, db, slug, task_id):
                stats["timed_out"] += 1
    return stats


def dispatch_service(app, slug: str, task_id: int, watchdog_minutes: float) -> tuple[models.Task, bool]:
    """queued→dispatched + deadline + 事件 + 启动看门狗（端点与派发执行器共用）。

    幂等（修复单 2）：非 queued 任务不再 409——原样返回 (task, skipped=True)，
    不做任何迁移、不启动看门狗、无副作用；双派发路径重叠时后来者安全跳过。
    """
    db = app.state.db
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{task_id}")
        if task.status != "queued":
            session.refresh(task)
            return task, True
        deadline = datetime.now().astimezone() + timedelta(minutes=watchdog_minutes)
        task.status = "dispatched"
        task.watchdog_deadline = deadline.isoformat(timespec="seconds")
        task.dispatched_at = now_iso()  # 落库：重启后重建看门狗的审计字段（追加项 9）
        task.watchdog_minutes = float(watchdog_minutes)
        task.updated_at = now_iso()
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "human", "task.dispatched",
            {"task": fmt_id("T", task.id)}, {"watchdog_deadline": task.watchdog_deadline},
        )
        session.commit()
        session.refresh(task)
        snapshot = task
    _start_watchdog(app, db, app.state.timers, slug, task_id, deadline)
    return snapshot, False


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


OUTPUT_TAIL_LIMIT = 4096  # output_tail 滚动保留的最后字节数（调整单 5）
OUTPUT_BROADCAST_LIMIT = 2000  # 单次 SSE 增量上限（NDJSON 行可能很长）


def record_task_output(app, slug: str, task_id: int, text: str, *, broadcast: bool = True) -> None:
    """追加被派发进程的过程输出：output_tail 滚动保留最后 4KB + SSE master_output 广播。

    dispatch 执行器（Python）与真实 chief 的 dispatch 工具（经 /output 端点）共用。
    """
    if not text:
        return
    db = app.state.db
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            return
        tail = (task.output_tail or "") + text
        task.output_tail = tail[-OUTPUT_TAIL_LIMIT:]
        task.updated_at = now_iso()
        session.commit()
        master = task.master
    if broadcast:
        chief = app.state.pi.get(slug)
        if chief is not None:
            chief.broadcast("master_output", {
                "task_id": fmt_id("T", task_id), "master": master,
                "text": text[-OUTPUT_BROADCAST_LIMIT:],
            })


class TaskOutputBody(BaseModel):
    text: str = ""


@router.post("/tasks/{task_id}/output")
def push_task_output(slug: str, task_id: str, body: TaskOutputBody, request: Request) -> dict:
    """真实 chief 的 dispatch 工具上报被派发进程的过程输出（节流由上报方负责）。"""
    _project_or_404(request, slug)
    record_task_output(request.app, slug, parse_prefixed_id(task_id, "T") or -1, body.text)
    return {}


@router.post("/tasks/{task_id}/dispatch")
def dispatch_task(slug: str, task_id: str, body: DispatchBody, request: Request) -> dict:
    _project_or_404(request, slug)
    if body.watchdog_minutes <= 0:
        raise ApiError(422, "validation_error", "watchdog_minutes 必须为正数")
    task, skipped = dispatch_service(
        request.app, slug,
        parse_prefixed_id(task_id, "T") or -1, body.watchdog_minutes,
    )
    if skipped:  # 幂等跳过（修复单 2）：进程没起来、无副作用
        return {"skipped": True, "reason": f"task in state {task.status}",
                "task": serialize.task_out(task)}
    return serialize.task_out(task)


class TaskFailBody(BaseModel):
    reason: str
    exit_code: int | None = None
    stderr: str | None = None


def reap_failed(app, slug: str, task_id: int, reason: str, exit_code: int | None = None,
                stderr: str | None = None) -> bool:
    """快速失败收尸（修复单 21/派单共享）：仅看门狗管辖内任务可收。
    取消看门狗定时器 → timeout + 事件（reason/exit_code/stderr 尾部）→ 通知 chief。
    非 dispatched/running 返回 False（调用方自行决定要不要当错误）。"""
    if not reason.strip():
        return False
    _cancel_watchdog(app.state.timers, slug, task_id)
    with app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None or task.status not in ZOMBIE_STATUSES:
            return False
        task.status = "timeout"
        task.updated_at = now_iso()
        details: dict = {"reason": reason}
        if exit_code is not None:
            details["exit_code"] = exit_code
        if stderr:
            details["stderr_tail"] = stderr[-500:]
        round_ = flow.get_open_round(session)
        flow.add_event(session, round_.n if round_ else 0, "system", "task.timeout",
                       {"task": fmt_id("T", task_id)}, details)
        session.commit()
        session.refresh(task)
        master = task.master
    from .. import chief_notify
    chief_notify.enqueue(
        app, slug,
        f"系统通知：任务 {fmt_id('T', task_id)}（{master or '未指派'}）进程失败退出：{reason}。"
        + (f"stderr 尾部：{details['stderr_tail']}" if "stderr_tail" in details else "")
        + "请向用户转述失败原因，不要臆测。",
    )
    return True


@router.post("/tasks/{task_id}/fail")
def fail_task(slug: str, task_id: str, body: TaskFailBody, request: Request) -> dict:
    """派发快速失败收尸（修复单 21）：被派发进程非零退出时由 chief 扩展立即调用。

    timeout 状态语义涵盖两种未回执终局：看门狗超时与进程崩溃——两者都是
    「已派发、没回执、不会再有回执」。仅 dispatched/running 可调（409 否则）。
    收尸 guts 在 reap_failed（dispatcher.run_task 的崩溃路径共用）。
    """
    """派发快速失败收尸（修复单 21）：被派发进程非零退出时由 chief 扩展立即调用。

    timeout 状态语义涵盖两种未回执终局：看门狗超时与进程崩溃——两者都是
    「已派发、没回执、不会再有回执」。仅 dispatched/running 可调（409 否则）；
    调用即取消对应看门狗定时器，不等剩余时限。事件 payload 附
    reason / exit_code / stderr 尾部（500 字符），回放可查崩溃原因。
    """
    _project_or_404(request, slug)
    reason = (body.reason or "").strip()
    if not reason:
        raise ApiError(422, "validation_error", "reason 不能为空（崩溃原因）")
    tid = parse_prefixed_id(task_id, "T") or -1
    with request.app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, tid)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{task_id}")
        if task.status not in ZOMBIE_STATUSES:
            raise ApiError(409, "conflict",
                           f"任务 {task_id} 状态为 {task.status}，不在看门狗管辖（只有已派发未回执的任务可 fail）")
    if not reap_failed(request.app, slug, tid, reason, body.exit_code, body.stderr):
        raise ApiError(409, "conflict", f"任务 {task_id} 已被处理（回执或收尸）")
    with request.app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, tid)
        data = serialize.task_out(task)
    return data


class AuditAllBody(BaseModel):
    result: str = "pass"
    note: str | None = None


@router.post("/audit-all")
def audit_all(slug: str, body: AuditAllBody, request: Request) -> dict:
    """批量验收（修复单 4）：项目内全部 reported 任务一次 audit，返回数量。"""
    _project_or_404(request, slug)
    if body.result not in ("pass", "fail"):
        raise ApiError(422, "validation_error", "result 必须是 pass 或 fail")
    db = request.app.state.db
    audited: list[str] = []
    with db.ledger_session(slug) as session:
        rows = session.scalars(
            select(models.Task).where(models.Task.status == "reported")
        ).all()
        for task in rows:
            task.status = "done" if body.result == "pass" else "rejected"
            task.updated_at = now_iso()
            round_ = flow.get_open_round(session)
            flow.add_event(
                session, round_.n if round_ else 0, "human",
                "audit.machine.passed" if body.result == "pass" else "audit.machine.failed",
                {"task": fmt_id("T", task.id)}, {"note": body.note},
            )
            audited.append(fmt_id("T", task.id))
        session.commit()
    return {"audited": len(audited), "task_ids": audited}


class LaunchPlanBody(BaseModel):
    prompt: str = ""


@router.post("/tasks/{task_id}/launch-plan")
def launch_plan(slug: str, task_id: str, body: LaunchPlanBody, request: Request) -> dict:
    """唤醒计划：真实 chief 的 dispatch 工具先问这里拿启动参数，再自己 spawn+监控。

    工作台统一计算「怎么启动 Harness」（名册 harness×harness-map×会话接续），
    被 spawn 的一方（TS 扩展 / mock 执行器）不再各自解析映射。
    """
    _project_or_404(request, slug)
    from ..dispatcher import plan_task_launch

    return plan_task_launch(request.app, slug, parse_prefixed_id(task_id, "T") or -1, body.prompt)


@router.post("/tasks/{task_id}/receipt")
def submit_receipt(slug: str, task_id: str, body: ReceiptBody, request: Request) -> dict:
    _project_or_404(request, slug)
    receipt = receipt_service(request.app.state.db, slug, parse_prefixed_id(task_id, "T") or -1, body)
    with request.app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, receipt.task_id)
        data = serialize.task_out(task, receipt)
        master = task.master
    # 落定即通知（慢工单）：后台派发时 chief 没在跟单，由通知回合把结果送回对话流
    files = "、".join(receipt.files_changed or []) or "（回执未声明文件）"
    from .. import chief_notify
    chief_notify.enqueue(
        request.app, slug,
        f"系统通知：任务 {fmt_id('T', receipt.task_id)}（{master or '未指派'}）已完成并回执。"
        f"回执文件：{files}；摘要：{(receipt.summary or '')[:280]}。"
        "请向用户简报结果：文件名与数量以本回执为准，不要另编路径。",
    )
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
        # 名册校验（修复单 17）：名册非空时 master 必须对上；报错附可用名单让调用方自纠。
        # 名册为空（纯替身自测）保持旧行为：master 随便填，映射落替身
        names = list(session.scalars(select(models.Master.name)).all())
        if names and body.master and body.master not in names:
            raise ApiError(
                422, "master_unknown",
                f"master {body.master!r} 不在名册，可用：{'、'.join(names)}",
            )
        round_ = flow.get_open_round(session) or flow.open_round(session, 1)
        package = models.TaskPackage(origin="tech", round=round_.n, version_refs={}, created_at=now_iso())
        session.add(package)
        session.flush()
        # 技术单任务的执行主体（默认 backend；映射 masters[None] 命不中会落替身）
        task = models.Task(package_id=package.id, master=body.master, status="queued",
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
        data["task_id"] = fmt_id("T", task.id)  # 核心代理 create_task 直接拿任务号派发
    return data
