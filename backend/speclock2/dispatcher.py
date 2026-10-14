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

from . import harness_map, models
from .pi_runtime import parse_record, split_records
from .routers.queue import ReceiptBody, dispatch_service, receipt_service

REPO_ROOT = Path(__file__).resolve().parent.parent.parent  # speclock2/../.. = 仓库根：主代理在其领地内干活

FILES_LINE_RE = re.compile(r"FILES:\s*(.+)")
GRACE_SECONDS = 8  # 看门狗后的回执宽限：进程仍未退出则 kill


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
    """单任务完整链：dispatch（状态机+看门狗）→ spawn → 解析 → receipt。

    返回执行摘要；进程失败/超时不回执，留给看门狗标 timeout。
    """
    db = app.state.db
    cfg = harness_map.load_or_create(app.state.settings.data_dir)
    if watchdog_minutes is None:
        watchdog_minutes = float(cfg.get("watchdog_minutes_default", 60))

    with db.ledger_session(slug) as session:
        task = session.get(models.Task, task_id)
        if task is None:
            raise RuntimeError(f"任务不存在：{task_id}")
        master = task.master
    harness = harness_map.resolve_harness(cfg, master)
    if not harness:
        raise RuntimeError(f"harness 映射缺失（master={master!r}），请检查 harness-map.json")

    dispatch_service(db, app.state.timers, slug, task_id, watchdog_minutes)
    argv = harness_map.build_argv(harness, prompt)
    started = asyncio.get_running_loop().time()

    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(REPO_ROOT),
    )
    records: list[dict] = []
    buffer = b""

    async def read_stdout() -> None:
        nonlocal buffer
        assert proc.stdout
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                break
            buffer += chunk
            lines, buffer = split_records(buffer)  # 与 pi_runtime 同款 LF 分帧
            for line in lines:
                rec = parse_record(line)
                if rec is not None:
                    records.append(rec)

    async def drain_stderr() -> None:
        assert proc.stderr
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                break

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
    if proc.returncode != 0:
        return {"task_id": task_id, "outcome": "crashed", "exit_code": proc.returncode}

    text, usage = _assistant_text_and_usage(records)
    files = parse_files_changed(text)
    telemetry = {
        "duration_ms": duration_ms,
        "tokens": {k: usage.get(k) for k in ("input", "output", "cacheRead", "cacheWrite")} if usage else None,
        "token_source": "exact" if usage else "estimated",  # 解析不到精确值就标估算
    }
    receipt = receipt_service(db, slug, task_id, ReceiptBody(
        files_changed=files,
        self_check=f"主代理进程退出码 0；输出 {len(records)} 条事件",
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
