"""任务服务：状态机、看门狗、派发与回执、收尸、验收、技术单创建。

所有任务状态迁移只经 transition_task 一个入口。
路由层（routers/queue.py、routers/dispatch.py）只做参数转换和调用。
执行器（executor.py）只经本模块推进任务状态。
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta
from pathlib import Path

from pydantic import BaseModel
from sqlalchemy import select

from .. import chief_notify, flow, models, serialize
from ..errors import ApiError
from ..protocol import notices, report as report_mod
from ..utils import fmt_id, now_iso

VALID_TRANSITIONS = {
    "queued": {"dispatched"},
    "dispatched": {"reported", "timeout"},
    "running": {"reported", "timeout"},
    "reported": {"done", "rejected"},
    "done": set(),
    "rejected": set(),
    "timeout": set(),
}


def transition_task(task: models.Task, to_status: str) -> None:
    """全仓库唯一的任务状态迁移入口：校验迁移合法，写状态和更新时间。

    非法迁移抛 409。调用方负责事件和 commit。
    """
    if to_status not in VALID_TRANSITIONS.get(task.status, set()):
        raise ApiError(409, "conflict", f"非法状态迁移：{task.status} → {to_status}")
    task.status = to_status
    task.updated_at = now_iso()


class ReceiptBody(BaseModel):
    files_changed: list = []
    self_check: str = ""
    summary: str = ""
    telemetry: dict | None = None  # 过程遥测（时长/token，解析不到标估算）——契约扩展见回执


def start_watchdog(app, db, timers: set, slug: str, task_id: int, deadline: datetime) -> None:
    """内存看门狗：到期仍未回执 → timeout + task.timeout 事件（§9.4）。
    定时器带 slug/task_id 标记（修复单 21）：/fail 收尸时按任务精确定位取消。"""
    delay = max((deadline - datetime.now().astimezone()).total_seconds(), 0.1)

    def fire() -> None:
        timers.discard(timer)
        try:
            mark_task_timeout(app, db, slug, task_id)
        except Exception:
            pass  # 看门狗尽力而为，不向外抛

    timer = threading.Timer(delay, fire)
    timer.daemon = True
    timer.slug = slug  # type: ignore[attr-defined]
    timer.task_id = task_id  # type: ignore[attr-defined]
    timers.add(timer)
    timer.start()


def cancel_watchdog(timers: set, slug: str, task_id: int) -> bool:
    """取消指定任务的看门狗定时器（修复单 21 快速收尸用）；返回是否找到。"""
    for t in list(timers):
        if getattr(t, "slug", None) == slug and getattr(t, "task_id", None) == task_id:
            t.cancel()
            timers.discard(t)
            return True
    return False


ZOMBIE_STATUSES = ("dispatched", "running")  # 已派发未回执的状态（看门狗管辖范围）


def _duration_since(iso: str | None) -> int | None:
    """从 dispatched_at 到现在的毫秒数；缺值返回 None。"""
    try:
        return round((datetime.now().astimezone() - datetime.fromisoformat(iso)).total_seconds() * 1000)
    except (TypeError, ValueError):
        return None


def add_report_event(session, task: models.Task, report: dict, telemetry: dict | None = None,
                     duration_ms: int | None = None) -> dict:
    """写 task.report 事件（契约 v0.6 §3.3），返回 payload。调用方负责 commit 与推送。"""
    telemetry = telemetry or {}
    payload = {
        "task_id": fmt_id("T", task.id),
        "master": task.master,
        "status": report["status"],
        "summary": report["summary"],
        "files_changed": report["files_changed"],
        "issues": report["issues"],
        "parse_quality": report["parse_quality"],
        "duration_ms": telemetry.get("duration_ms", duration_ms),
        "token_source": telemetry.get("token_source") or "estimated",
    }
    round_ = flow.get_open_round(session)
    flow.add_event(session, round_.n if round_ else 0, "system", "task.report",
                   {"task": payload["task_id"]}, payload)
    return payload


def publish_task_report(app, slug: str, payload: dict) -> None:
    """把 task.report 推给 SSE（事件名 task_report）。看门狗线程与端点线程都会调用，
    所以经事件循环的线程安全入口广播；核心代理会话没在跑（无订阅者）则放弃。"""
    import asyncio

    session = app.state.pi.get(slug)
    loop = getattr(app.state, "loop", None)
    if session is None or loop is None:
        return
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        session.broadcast("task_report", payload)
    else:
        loop.call_soon_threadsafe(session.broadcast, "task_report", payload)


def mark_task_timeout(app, db, slug: str, task_id: int) -> bool:
    """僵尸任务收尸：仍处 dispatched/running → timeout + task.timeout 事件；返回是否标记。
    收尸即通知（慢工单）：chief 没在跟单时，由通知回合把超时事实送回对话流。"""
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None or task.status not in ZOMBIE_STATUSES:
            return False  # 已回执/已处理，忽略
        transition_task(task, "timeout")
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "system", "task.timeout",
            {"task": fmt_id("T", task_id)}, {"deadline": task.watchdog_deadline},
        )
        report = report_mod.failure_report(f"看门狗超时（期限 {task.watchdog_deadline}），未收到回执")
        payload = add_report_event(session, task, report, duration_ms=_duration_since(task.dispatched_at))
        session.commit()
        session.refresh(task)
        master = task.master
    publish_task_report(app, slug, payload)
    chief_notify.enqueue(app, slug, notices.task_timeout(
        fmt_id("T", task_id), master, report, task.watchdog_deadline))
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
                start_watchdog(app, db, timers, slug, task_id, deadline)
                stats["rearmed"] += 1
            elif mark_task_timeout(app, db, slug, task_id):
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
        transition_task(task, "dispatched")
        task.watchdog_deadline = deadline.isoformat(timespec="seconds")
        task.dispatched_at = now_iso()  # 落库：重启后重建看门狗的审计字段（追加项 9）
        task.watchdog_minutes = float(watchdog_minutes)
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "human", "task.dispatched",
            {"task": fmt_id("T", task.id)}, {"watchdog_deadline": task.watchdog_deadline},
        )
        session.commit()
        session.refresh(task)
        snapshot = task
    start_watchdog(app, db, app.state.timers, slug, task_id, deadline)
    return snapshot, False


def receipt_service(app, slug: str, task_id: int, body: ReceiptBody,
                    report: dict | None = None) -> models.Receipt:
    """dispatched→reported + 回执落库 + task.report 事件（端点与派发执行器共用）。

    report 为空表示人工回执：parse_quality 记为 manual。"""
    db = app.state.db
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{task_id}")
        transition_task(task, "reported")
        if report is None:
            report = report_mod.manual_report(body.summary, body.files_changed)
        receipt = models.Receipt(
            task_id=task.id,
            files_changed=body.files_changed,
            self_check=body.self_check,
            summary=body.summary,
            telemetry=body.telemetry,
            report=report,
            created_at=now_iso(),
        )
        session.add(receipt)
        round_ = flow.get_open_round(session)
        flow.add_event(
            session, round_.n if round_ else 0, "human", "task.receipt",
            {"task": fmt_id("T", task.id)},
            {"files_changed": body.files_changed, "self_check": body.self_check,
             "summary": body.summary, "telemetry": body.telemetry},
        )
        payload = add_report_event(session, task, report, body.telemetry)
        session.commit()
        session.refresh(receipt)
    publish_task_report(app, slug, payload)
    return receipt


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


def reap_failed(app, slug: str, task_id: int, reason: str, exit_code: int | None = None,
                stderr: str | None = None) -> bool:
    """快速失败收尸（修复单 21/派单共享）：仅看门狗管辖内任务可收。
    取消看门狗定时器 → timeout + 事件（reason/exit_code/stderr 尾部）→ 通知 chief。
    非 dispatched/running 返回 False（调用方自行决定要不要当错误）。"""
    if not reason.strip():
        return False
    cancel_watchdog(app.state.timers, slug, task_id)
    with app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None or task.status not in ZOMBIE_STATUSES:
            return False
        transition_task(task, "timeout")
        details: dict = {"reason": reason}
        if exit_code is not None:
            details["exit_code"] = exit_code
        if stderr:
            details["stderr_tail"] = stderr[-500:]
        round_ = flow.get_open_round(session)
        flow.add_event(session, round_.n if round_ else 0, "system", "task.timeout",
                       {"task": fmt_id("T", task_id)}, details)
        report = report_mod.failure_report(reason)
        payload = add_report_event(session, task, report, duration_ms=_duration_since(task.dispatched_at))
        session.commit()
        session.refresh(task)
        master = task.master
    publish_task_report(app, slug, payload)
    chief_notify.enqueue(app, slug, notices.task_failed(
        fmt_id("T", task_id), master, report, details.get("stderr_tail")))
    return True


def fail_service(app, slug: str, task_id: int, reason: str, exit_code: int | None,
                 stderr: str | None) -> dict:
    """/fail 端点的服务：校验任务在看门狗管辖内，收尸，返回任务视图。"""
    reason = (reason or "").strip()
    if not reason:
        raise ApiError(422, "validation_error", "reason 不能为空（崩溃原因）")
    label = fmt_id("T", task_id)
    with app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{label}")
        if task.status not in ZOMBIE_STATUSES:
            raise ApiError(409, "conflict",
                           f"任务 {label} 状态为 {task.status}，不在看门狗管辖（只有已派发未回执的任务可 fail）")
    if not reap_failed(app, slug, task_id, reason, exit_code, stderr):
        raise ApiError(409, "conflict", f"任务 {label} 已被处理（回执或收尸）")
    with app.state.db.ledger_session(slug) as session:
        return serialize.task_out(session.get(models.Task, task_id))


def _add_audit_event(session, task: models.Task, result: str, note: str | None) -> None:
    round_ = flow.get_open_round(session)
    flow.add_event(
        session, round_.n if round_ else 0, "human",
        "audit.machine.passed" if result == "pass" else "audit.machine.failed",
        {"task": fmt_id("T", task.id)}, {"note": note},
    )


def audit_service(app, slug: str, task_id: int, result: str, note: str | None) -> dict:
    """reported→done|rejected，写审计记录和事件。M1 用人工模拟机器审计。"""
    if result not in ("pass", "fail"):
        raise ApiError(422, "validation_error", "result 必须是 pass 或 fail")
    with app.state.db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：{fmt_id('T', task_id)}")
        transition_task(task, "done" if result == "pass" else "rejected")
        session.add(models.AuditRun(
            task_id=task.id, level="machine", result=result,
            details={"note": note} if note else None, created_at=now_iso(),
        ))
        _add_audit_event(session, task, result, note)
        session.commit()
        session.refresh(task)
        return serialize.task_out(task)


def audit_all_service(app, slug: str, result: str, note: str | None) -> list[str]:
    """批量验收（修复单 4）：项目内全部 reported 任务一次 audit，返回任务号。"""
    if result not in ("pass", "fail"):
        raise ApiError(422, "validation_error", "result 必须是 pass 或 fail")
    audited: list[str] = []
    with app.state.db.ledger_session(slug) as session:
        for task in session.scalars(select(models.Task).where(models.Task.status == "reported")).all():
            transition_task(task, "done" if result == "pass" else "rejected")
            _add_audit_event(session, task, result, note)
            audited.append(fmt_id("T", task.id))
        session.commit()
    return audited


def create_tech_order_service(app, slug: str, intent, scope, baseline, acceptance, master) -> dict:
    """技术任务单（DESIGN.md §6.4）：不动业务的变更，不进版本链；M1 创建即视为确认。"""
    errors: list[dict] = []
    if not isinstance(intent, str) or not intent.strip():
        errors.append({"field": "intent", "message": "intent 不能为空（必须能回答'为什么动'）"})
    if not scope or not isinstance(scope, list):
        errors.append({"field": "scope", "message": "scope 不能为空（范围声明 = 技术任务的契约）"})
    if errors:
        raise ApiError(422, "validation_error", "技术任务单校验失败", details={"errors": errors})

    with app.state.db.ledger_session(slug) as session:
        # 名册校验（修复单 17）：名册非空时 master 必须对上；报错附可用名单让调用方自纠。
        # 名册为空（纯替身自测）保持旧行为：master 随便填，映射落替身
        names = list(session.scalars(select(models.Master.name)).all())
        if names and master and master not in names:
            raise ApiError(
                422, "master_unknown",
                f"master {master!r} 不在名册，可用：{'、'.join(names)}",
                details={"available": names},
            )
        round_ = flow.get_open_round(session) or flow.open_round(session, 1)
        package = models.TaskPackage(origin="tech", round=round_.n, version_refs={}, created_at=now_iso())
        session.add(package)
        session.flush()
        task = models.Task(package_id=package.id, master=master, status="queued",
                           created_at=now_iso(), updated_at=now_iso())
        session.add(task)
        session.flush()
        order = models.TechOrder(
            intent=intent.strip(), scope=scope, baseline=baseline, acceptance=acceptance,
            package_id=package.id, created_at=now_iso(),
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
