"""派发执行器：spawn 被派发 harness 真实进程，NDJSON 解析，上报遥测与回执。

设计对齐 DESIGN.md §13.4/13.5：回执通道是薄 REST；token 从被派发 CLI 的
stdout 解析（message_end.usage），解析不到标"估算"。
mock 核心代理（MockSession）用它执行"模拟 dispatch 工具"；真实模式由
chief/extension 的 dispatch 工具（TS）实现同一链路。
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from sqlalchemy import select

from . import cli_sessions, harness_map, models
from .errors import ApiError
from .pi_runtime import effective_chief, effective_chief_model_str, parse_record, split_records
from .routers.queue import ReceiptBody, dispatch_service, receipt_service, record_task_output

FILES_LINE_RE = re.compile(r"FILES:\s*(.+)")
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
    """接续前核对会话工作区（慢工单接缝）：mcode 会校验被接续会话的 workspace
    与 --cwd 一致，硬接会秒败（exit 4「Session workspace does not match --cwd」，
    testproj/E2E 实证）——因此 mcode 绑定会话只有证实同目录才接续，查不到 cwd
    也放弃（新会话）。其余 harness 不做工作区校验，维持原行为。"""
    if not cwd or harness != "mcode":
        return True
    try:
        hits = cli_sessions.scan(cwd=cwd)
    except Exception:
        return False  # 探测失败宁可不接续（mcode 硬接会秒败）
    return any(s["id"] == session_id for s in hits)


def plan_task_launch(app, slug: str, task_id: int, prompt: str) -> dict:
    """统一计算「这个任务怎么唤醒 harness」：名册（harness/绑定会话/模型）×映射（argv）×cwd。

    mock 执行器（dispatcher.run_task）与真实 chief 的 dispatch 工具（经
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


def parse_files_changed(text: str) -> list[str]:
    """从主代理输出解析改动文件（「FILES: a b c」清单行）；解析不到返回空。"""
    for line in text.splitlines():
        m = FILES_LINE_RE.search(line)
        if m:
            return [f for f in m.group(1).split() if f]
    return []


async def run_task(app, slug: str, task_id: int, prompt: str, watchdog_minutes: float | None = None) -> dict:
    """单任务完整链：plan（启动参数）→ dispatch（状态机+看门狗）→ spawn → 解析 → receipt。

    返回执行摘要；进程失败/超时不回执，留给看门狗标 timeout。
    """
    db = app.state.db
    plan = plan_task_launch(app, slug, task_id, prompt)
    if watchdog_minutes is None:
        watchdog_minutes = plan["watchdog_minutes"]

    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is not None and task.status != "queued":
            # 幂等（修复单 2）：批准自动派发与 chief 手工派发重叠时，后来者不动进程
            return {"task_id": task_id, "outcome": "skipped",
                    "reason": f"task in state {task.status}"}

    dispatch_service(app, slug, task_id, watchdog_minutes)
    command, argv = plan["command"], plan["argv"]
    if plan["wrap_cmd"]:
        command, argv = "cmd", ["/c", plan["command"], *argv]
    started = asyncio.get_running_loop().time()

    try:
        proc = await asyncio.create_subprocess_exec(
            command,
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=plan["cwd"],
        )
    except OSError as e:  # 命令不存在/不可执行：如实上报，不回执（看门狗兜底）
        return {"task_id": task_id, "outcome": "spawn_failed", "error": f"{type(e).__name__}: {e}"}
    records: list[dict] = []
    buffer = b""
    stdout_raw = bytearray()
    stderr_tail = b""
    reported = 0  # 已上报（广播+落库）的字节偏移
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
        await asyncio.wait_for(asyncio.gather(reader, err_drain), timeout=5)

    duration_ms = round((asyncio.get_running_loop().time() - started) * 1000)
    # 进程结束：剩余增量只落库不再广播（调整单 5：结束即停播）
    if len(stdout_raw) > reported:
        record_task_output(app, slug, task_id,
                           bytes(stdout_raw[reported:]).decode("utf-8", "replace"),
                           broadcast=False)
    if proc.returncode != 0:
        # mcode 失败时错误行走 stdout（如 "mcode exec failed: ..."），一并带上
        return {"task_id": task_id, "outcome": "crashed", "exit_code": proc.returncode,
                "stderr": stderr_tail.decode("utf-8", "replace"),
                "stdout_tail": bytes(stdout_raw[-300:]).decode("utf-8", "replace")}

    if plan.get("output") == "text":
        # mcode exec：纯文本 stdout，全部文本即回复；token 不暴露 → 恒估算
        text = bytes(stdout_raw).decode("utf-8", "replace").strip()
        usage = None
    else:
        text, usage = _assistant_text_and_usage(records)
    files = parse_files_changed(text)
    telemetry = {
        "duration_ms": duration_ms,
        "tokens": {k: usage.get(k) for k in ("input", "output", "cacheRead", "cacheWrite")} if usage else None,
        "token_source": "exact" if usage else "estimated",  # 解析不到精确值就标估算
    }
    ok_word = "0" if proc.returncode == 0 else str(proc.returncode)
    detail = (f"输出 {len(records)} 条事件" if usage
              else f"输出 {len(text)} 字符（纯文本 harness）")
    receipt = receipt_service(db, slug, task_id, ReceiptBody(
        files_changed=files,
        self_check=f"主代理进程退出码 {ok_word}；{detail}",
        summary=text[:200],
        telemetry=telemetry,
    ))
    return {"task_id": task_id, "outcome": "reported", "exit_code": 0,
            "files_changed": files, "receipt_id": receipt.id}


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
