"""CLI 会话探测：扫描 pi 自己落盘的会话文件，读出会话清单（id/标题/更新时间）。

工作台不配置 Harness，只做唤醒与探测（用户原则）：清单来自 CLI 的会话目录
（默认 ~/.pi/agent/sessions/，可用 PI_CODING_AGENT_SESSION_DIR 或
SPECLOCK2_PI_SESSIONS_DIR 覆盖），目录按 cwd 分子目录、文件名带时间戳前缀，
定位一律以文件头行的 id 为准（与 pi 的 findById 语义一致）。

标题规则与 pi 会话选择器相同：session_info 里最新的人为命名优先，
否则取首条用户消息；更新时间取文件 mtime。
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

MAX_FILES = 100          # 单目录扫描上限（防意外扫到海量文件）
MAX_READ_BYTES = 1 << 20  # 单文件解析上限：标题信息都在前部，超大文件只读前 1MB
TITLE_MAX = 60


def session_roots() -> list[Path]:
    """会话根目录：pi 官方覆盖变量优先，其次工作台变量，最后默认目录。"""
    for var in ("PI_CODING_AGENT_SESSION_DIR", "SPECLOCK2_PI_SESSIONS_DIR"):
        value = os.environ.get(var)
        if value:
            return [Path(value).expanduser()]
    return [Path.home() / ".pi" / "agent" / "sessions"]


def _parse_file(path: Path) -> dict | None:
    """解析单个会话文件：头行必须 type=session；返回 {id,title,mtime,path} 或 None。"""
    try:
        raw = path.read_bytes()[:MAX_READ_BYTES]
    except OSError:
        return None
    lines = raw.split(b"\n")
    try:
        header = json.loads(lines[0])
    except (ValueError, IndexError):
        return None
    if not isinstance(header, dict) or header.get("type") != "session":
        return None
    sid = header.get("id")
    if not isinstance(sid, str) or not sid:
        return None

    name: str | None = None
    first_user = ""
    for line in lines[1:]:
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # 容忍截断行/坏行
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "session_info":
            named = entry.get("name")
            name = named.strip() if isinstance(named, str) and named.strip() else None
        elif entry.get("type") == "message" and not first_user:
            message = entry.get("message")
            if isinstance(message, dict) and message.get("role") == "user":
                text = "".join(
                    b.get("text", "") for b in message.get("content", [])
                    if isinstance(b, dict) and b.get("type") == "text"
                ).strip()
                if text:
                    first_user = text

    title = name or (first_user[:TITLE_MAX] or "(未命名会话)")
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    return {"id": sid, "title": title, "mtime": mtime, "path": path}


def _scan_all() -> list[dict]:
    found: list[dict] = []
    for root in session_roots():
        if not root.is_dir():
            continue
        try:
            files = sorted(root.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
        for path in files[:MAX_FILES]:
            info = _parse_file(path)
            if info:
                found.append(info)
    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


def scan() -> list[dict]:
    """会话清单（新→旧）：[{id, title, updated_at}]，供前端绑定主代理。"""
    return [
        {
            "id": info["id"],
            "title": info["title"],
            "updated_at": datetime.fromtimestamp(info["mtime"], tz=timezone.utc).isoformat(),
        }
        for info in _scan_all()
    ]


def find_session_dir(session_id: str) -> Path | None:
    """按会话 id 定位其文件所在目录（pi --session-dir 恢复用）；找不到返回 None。"""
    for info in _scan_all():
        if info["id"] == session_id:
            return info["path"].parent
    return None
