"""派发执行器：全仓库唯一的派发实现（契约 v0.6）。

start_task 组装提示词，计算启动参数，启动被派发 harness 进程，并在后台监控。
监控负责：解析报告块，上报遥测与回执，收尸，写 task.report 事件，发系统通知。
进程由后端持有。核心代理的工具（TypeScript 扩展）和 mock 核心代理都经它派发。
token 从被派发 CLI 的 stdout 解析（message_end.usage），解析不到标"估算"。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select

from . import chief_notify, cli_sessions, harness_map, models
from .errors import ApiError
from .pi_runtime import effective_chief, effective_chief_model_str, parse_record, split_records
from .protocol import brief as brief_mod
from .protocol import notices
from .protocol import report as report_mod
from .roles import compose
from .utils import fmt_id
from .routers.queue import ReceiptBody, dispatch_service, reap_failed, receipt_service, record_task_output

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # 工作台仓库根
GRACE_SECONDS = 8  # 看门狗后的回执宽限：进程仍未退出则 kill
OUTPUT_FLUSH_SECONDS = 2.0  # 过程输出节流（调整单 5）


def _resolve_dispatch_cwd(master_dir: str, project_dir: str) -> str:
    """派发 cwd 三级解析（契约 v0.4）：masters.working_dir → projects.working_dir → 拒派。

    主代理目录为相对路径时按项目目录拼（名册里的 dir 是所有权边界，如 backend/）；
    绝对路径直接用。工作台仓库永远不是候选——被派发 agent 不许写工作台自己。
    """
    if master_dir:
        mp = Path(master_dir)
        if mp.is_absolute():
            cwd = mp
        elif project_dir:
            cwd = Path(project_dir) / master_dir
        else:
            raise ApiError(422, "project_unbound",
                           "项目未绑定目标仓库，拒绝派发（主代理目录为相对路径，需项目先绑定目录）")
    elif project_dir:
        cwd = Path(project_dir)
    else:
        raise ApiError(422, "project_unbound", "项目未绑定目标仓库，拒绝派发")
    if not cwd.is_dir():
        raise ApiError(422, "project_unbound", f"派发目标目录不存在：{cwd}")
    return str(cwd)


def _session_matches_cwd(session_id: str, cwd: str | None, harness: str) -> bool:
    """接续前核对会话工作区（慢工单接缝）：mcode/opencode 会校验被接续会话的
    workspace 与运行目录的关系，硬接可能秒败（mcode exit 4「Session workspace
    does not match --cwd」，E2E 实证）——因此这类 harness 只接证实同目录的会话，
    查不到 cwd 也放弃（新会话）。其余 harness 不做工作区校验，维持原行为。"""
    if not cwd or harness not in ("mcode", "opencode"):
        return True
    try:
        hits = cli_sessions.scan(cwd=cwd)
    except Exception:
        return False  # 探测失败宁可不接续（硬接有秒败风险）
    return any(s["id"] == session_id for s in hits)


def plan_task_launch(app, slug: str, task_id: int, prompt: str) -> dict:
    """统一计算「这个任务怎么唤醒 harness」：名册（harness/绑定会话/模型）×映射（argv）×cwd。

    执行器（executor.start_task）与真实 chief 的 dispatch 工具（经
    /tasks/{id}/launch-plan 端点）共用此函数——启动参数只有这一个事实源。
    会话接续：主代理绑定了 CLI 会话且文件仍在 → 按模板追加接续参数
    （pi 传 --session-id/--session-dir）；文件没了则放弃接续、新会话照常。
    """
    db = app.state.db
    cfg = harness_map.load_or_create(app.state.settings.data_dir)
    harnesses = cfg.get("harnesses") or {}

    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：T-{task_id:04d}")
        master_name = task.master
        # 名册优先：主代理创建时登记的 harness；名册没有该名字再走机器映射
        row = None
        if master_name:
            row = session.scalars(
                select(models.Master).where(models.Master.name == master_name)
            ).first()

    with db.registry_session() as registry:
        project = registry.get(models.Project, slug)
    project_dir = (project.working_dir or "").strip() if project else ""

    if row is not None and row.harness:
        name = row.harness
        if name not in harnesses:
            raise ApiError(
                422, "harness_unconfigured",
                f"harness {name!r} 未配置命令（harness-map.json），无法唤醒主代理 {master_name!r}",
            )
    else:
        name = harness_map.resolve_harness_name(cfg, master_name)
    harness = harnesses.get(name) or {}
    if not harness:
        raise RuntimeError(f"harness 映射缺失（master={master_name!r}），请检查 harness-map.json")

    # cwd：主代理目录 → 项目绑定目录 → 422 拒派（契约 v0.4 核心）
    master_dir = (row.working_dir or "").strip() if row is not None else ""
    cwd = _resolve_dispatch_cwd(master_dir, project_dir)

    # 模型：名册登记的模型 → 项目核心代理模型兜底 → 无（摘除 {model} 占位）。
    # 名册 model 无 "/" 且登记了 provider → 组合成 provider/model（两 harness 各用各的供应商名）
    roster_model = (row.model or "").strip() if row is not None else ""
    roster_provider = (row.provider or "").strip() if row is not None else ""
    if roster_model:
        model = (roster_model if "/" in roster_model
                 else f"{roster_provider}/{roster_model}" if roster_provider
                 else roster_model)
    else:
        model = effective_chief_model_str(db, slug) or None

    full = harness_map.build_argv(harness, prompt, cwd=cwd)  # [command, *args]
    command, args = full[0], harness_map.apply_model(full[1:], model)
    if row is not None:
        bound = (row.session_policy or {}).get("cli_session")
        if bound and _session_matches_cwd(bound, cwd, name):
            resume_dir = cli_sessions.find_session_dir(bound)
            if resume_dir is not None:  # 接续存储还在才接（mcode/pi 同一降级语义）
                extra = harness_map.build_resume_args(harness, bound, str(resume_dir))
                if extra:
                    args = [a for a in args if a != "--no-session"] + extra

    return {
        "harness": name,
        "command": command,
        "argv": args,
        "cwd": cwd,
        "model": model,
        # 输出形态：pi 等走 NDJSON 事件流；mcode exec 是纯文本（全部 stdout 即回复）
        "output": harness.get("output", "ndjson"),
        "wrap_cmd": command.lower().endswith((".cmd", ".bat")),
        "watchdog_minutes": float(cfg.get("watchdog_minutes_default", 60)),
        "chief": effective_chief(db, slug),
        "master": master_name,
    }


def _assistant_text_and_usage(records: list[dict]) -> tuple[str, dict | None]:
    text, usage = "", None
    for rec in records:
        if rec.get("type") != "message_end":
            continue
        message = rec.get("message") or {}
        if message.get("role") != "assistant":
            continue
        text = "".join(
            b.get("text", "") for b in message.get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        )
        usage = message.get("usage")
    return text, usage


def _norm_path(text: str) -> str:
    return text.replace("\\", "/").lower()


def has_host_path(text: str) -> bool:
    """路径纪律：任务说明含工作台仓库的绝对路径时返回 True。

    主代理的领地由工作台按名册解析。说明里写工作台绝对路径，会把产物写进工作台仓库。
    """
    root = _norm_path(str(REPO_ROOT)).rstrip("/")
    return len(root) > 3 and root in _norm_path(text or "")


async def spawn_process(*cmd: str, **kwargs):
    """全仓库唯一启动子进程的入口：被派发的主代理和核心代理自己的 pi 进程都经它。"""
    return await asyncio.create_subprocess_exec(*cmd, **kwargs)


@dataclass
class StartResult:
    task_id: int
    outcome: str  # started | skipped | spawn_failed
    monitor: asyncio.Task | None = None  # 后台监控；run_task 等它，端点不等
    info: dict = field(default_factory=dict)


def _task_context(session, task: models.Task) -> dict:
    """任务说明骨架的上下文：技术单的意图、范围、验收；其他来源用任务包信息。"""
    order = session.scalars(
        select(models.TechOrder).where(models.TechOrder.package_id == task.package_id)
    ).first()
    if order is not None:
        return {"intent": order.intent, "scope": list(order.scope or []),
                "acceptance": list(order.acceptance or [])}
    package = session.get(models.TaskPackage, task.package_id)
    origin = package.origin if package else "approval"
    return {"intent": f"执行任务包 P-{task.package_id:04d}（{origin}）", "scope": [], "acceptance": []}


async def start_task(app, slug: str, task_id: int, instructions: str, *,
                     intent: str | None = None, scope: list[str] | None = None,
                     acceptance: list[str] | None = None,
                     watchdog_minutes: float | None = None) -> StartResult:
    """启动一个 queued 任务，并在后台监控它。启动后立即返回。

    步骤：组装提示词，计算启动参数，推进状态机，启动进程，创建后台监控。
    非 queued 任务返回 skipped，不动进程（幂等，修复单 2）。
    """
    db = app.state.db
    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise ApiError(404, "not_found", f"任务不存在：T-{task_id:04d}")
        if task.status != "queued":
            return StartResult(task_id, "skipped", info={"reason": f"task in state {task.status}"})
        ctx = _task_context(session, task)
        master = task.master
    brief = brief_mod.build_brief(
        intent if intent is not None else ctx["intent"], instructions,
        scope if scope is not None else ctx["scope"],
        acceptance if acceptance is not None else ctx["acceptance"],
    )
    prompt = compose.compose_master_prompt(db, slug, master, brief)
    plan = plan_task_launch(app, slug, task_id, prompt)  # 项目未绑定等校验失败在此抛 422，状态不动
    if watchdog_minutes is None:
        watchdog_minutes = plan["watchdog_minutes"]

    dispatch_service(app, slug, task_id, watchdog_minutes)
    command, argv = plan["command"], plan["argv"]
    if plan["wrap_cmd"]:
        command, argv = "cmd", ["/c", plan["command"], *argv]
    started = asyncio.get_running_loop().time()
    try:
        proc = await spawn_process(
            command, *argv,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=plan["cwd"],
        )
    except OSError as e:  # 命令不存在或不可执行：快速收尸，不等看门狗，原因如实上报
        reap_failed(app, slug, task_id, reason=f"进程无法启动：{type(e).__name__}: {e}")
        return StartResult(task_id, "spawn_failed", info={"error": f"{type(e).__name__}: {e}"})

    monitor = asyncio.create_task(_monitor(app, slug, task_id, proc, plan, watchdog_minutes, started))
    procs = app.state.procs
    procs[(slug, task_id)] = (proc, monitor)
    monitor.add_done_callback(lambda _t: procs.pop((slug, task_id), None))
    return StartResult(task_id, "started", monitor=monitor)


async def _monitor(app, slug: str, task_id: int, proc, plan: dict,
                   watchdog_minutes: float, started: float) -> dict:
    """后台监控：读输出，等退出，解析报告，回执或收尸。返回执行摘要。"""
    records: list[dict] = []
    buffer = b""
    stdout_raw = bytearray()
    stderr_tail = b""
    reported = 0  # 已上报（广播加落库）的字节偏移
    last_flush = 0.0

    async def read_stdout() -> None:
        nonlocal buffer, stdout_raw, last_flush, reported
        assert proc.stdout
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                break
            stdout_raw += chunk
            buffer += chunk
            lines, buffer = split_records(buffer)  # 与 pi_runtime 同款 LF 分帧
            for line in lines:
                rec = parse_record(line)
                if rec is not None:
                    records.append(rec)
            now = asyncio.get_running_loop().time()
            if now - last_flush >= OUTPUT_FLUSH_SECONDS and len(stdout_raw) > reported:
                record_task_output(app, slug, task_id,
                                   bytes(stdout_raw[reported:]).decode("utf-8", "replace"))
                reported = len(stdout_raw)
                last_flush = now

    async def drain_stderr() -> None:
        nonlocal stderr_tail
        assert proc.stderr
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                break
            stderr_tail = (stderr_tail + chunk)[-500:]  # 尾部诊断

    reader = asyncio.create_task(read_stdout())
    err_drain = asyncio.create_task(drain_stderr())
    try:
        await asyncio.wait_for(proc.wait(), timeout=watchdog_minutes * 60 + GRACE_SECONDS)
    except asyncio.TimeoutError:
        proc.kill()  # 看门狗已标 timeout；这里只负责收尸，不回执
        return {"task_id": task_id, "outcome": "timeout_killed", "exit_code": None}
    finally:
        try:
            await asyncio.wait_for(asyncio.gather(reader, err_drain), timeout=5)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

    if getattr(app.state, "shutting_down", False):
        # 后端关闭时被杀：任务保持原状态，下次启动由看门狗重建逻辑收尸
        return {"task_id": task_id, "outcome": "shutdown", "exit_code": proc.returncode}

    duration_ms = round((asyncio.get_running_loop().time() - started) * 1000)
    # 进程结束：剩余增量只落库不再广播（调整单 5：结束即停播）
    if len(stdout_raw) > reported:
        record_task_output(app, slug, task_id,
                           bytes(stdout_raw[reported:]).decode("utf-8", "replace"),
                           broadcast=False)
    if proc.returncode != 0:
        # mcode 失败时错误行走 stdout（如 "mcode exec failed: ..."），一并带上
        stderr_text = stderr_tail.decode("utf-8", "replace")
        stdout_tail = bytes(stdout_raw[-300:]).decode("utf-8", "replace")
        # 快速收尸（修复单 21）：不等看门狗，失败原因进事件并通知 chief
        reap_failed(app, slug, task_id,
                    reason=f"被派发进程异常退出（码 {proc.returncode}）",
                    exit_code=proc.returncode,
                    stderr=(stderr_text or stdout_tail) or None)
        return {"task_id": task_id, "outcome": "crashed", "exit_code": proc.returncode,
                "stderr": stderr_text, "stdout_tail": stdout_tail}

    if plan.get("output") == "text":
        # mcode exec：纯文本 stdout，全部文本即回复；token 不暴露，恒为估算
        text = bytes(stdout_raw).decode("utf-8", "replace").strip()
        usage = None
    else:
        text, usage = _assistant_text_and_usage(records)
    report = report_mod.parse_output(text, proc.returncode)
    files = report["files_changed"]
    telemetry = {
        "duration_ms": duration_ms,
        "tokens": {k: usage.get(k) for k in ("input", "output", "cacheRead", "cacheWrite")} if usage else None,
        "token_source": "exact" if usage else "estimated",  # 解析不到精确值就标估算
    }
    detail = (f"输出 {len(records)} 条事件" if usage
              else f"输出 {len(text)} 字符（纯文本 harness）")
    try:
        receipt = receipt_service(app, slug, task_id, ReceiptBody(
            files_changed=files,
            self_check=f"主代理进程退出码 0；{detail}",
            summary=report["summary"],
            telemetry=telemetry,
        ), report=report)
    except ApiError:  # 任务已被看门狗收尸（状态迁移 409）：以账本为准，放弃回执
        return {"task_id": task_id, "outcome": "late_receipt_dropped", "exit_code": 0}
    chief_notify.enqueue(app, slug, notices.task_completed(
        fmt_id("T", task_id), plan.get("master"), report))
    return {"task_id": task_id, "outcome": "reported", "exit_code": 0,
            "files_changed": files, "receipt_id": receipt.id}


async def run_task(app, slug: str, task_id: int, prompt: str,
                   watchdog_minutes: float | None = None) -> dict:
    """调用 start_task 并等后台监控结束，返回执行摘要。mock 核心代理和测试用它。"""
    started = await start_task(app, slug, task_id, prompt, watchdog_minutes=watchdog_minutes)
    if started.outcome == "skipped":
        return {"task_id": task_id, "outcome": "skipped", **started.info}
    if started.outcome == "spawn_failed":
        return {"task_id": task_id, "outcome": "spawn_failed", **started.info}
    assert started.monitor is not None
    return await started.monitor


async def terminate_all(app) -> None:
    """后端关闭：杀掉全部在跑的主代理进程。

    任务保持当前状态。下次启动时，看门狗重建逻辑会收尸。
    """
    app.state.shutting_down = True
    entries = list(app.state.procs.values())
    for proc, _ in entries:
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
    for _, monitor in entries:
        try:
            await asyncio.wait_for(asyncio.shield(monitor), timeout=10)
        except Exception:
            monitor.cancel()


async def run_package(app, slug: str, package_id: int, prompt_of=None) -> list[dict]:
    """对任务包内全部 queued 任务并行派发（包内并行，DESIGN §9.2）。"""
    db = app.state.db
    with db.ledger_session(slug) as session:
        package = session.get(models.TaskPackage, package_id)
        if package is None:
            raise RuntimeError(f"任务包不存在：{package_id}")
        tasks = [
            (t.id, t.master)
            for t in session.scalars(
                select(models.Task).where(
                    models.Task.package_id == package_id, models.Task.status == "queued"
                )
            ).all()
        ]
    default_prompt = f"执行任务包 P-{package_id:04d}（{package.origin}，轮次 {package.round}）。"
    prompts = [
        prompt_of(task_id, master) if prompt_of else f"{default_prompt} 角色：{master or '待定'}。"
        for task_id, master in tasks
    ]
    return list(await asyncio.gather(*[
        run_task(app, slug, task_id, prompt) for (task_id, _), prompt in zip(tasks, prompts)
    ]))
