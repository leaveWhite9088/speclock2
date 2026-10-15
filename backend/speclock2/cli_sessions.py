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
import re
from datetime import datetime, timezone
from pathlib import Path

MAX_FILES = 100          # 单目录扫描上限（防意外扫到海量文件）
MAX_READ_BYTES = 1 << 20  # 单文件解析上限：标题信息都在前部，超大文件只读前 1MB
CWD_PEEK_BYTES = 8 << 10  # mcode cwd 判定的探测窗口（messages.jsonl 头部 agent-context）
TITLE_MAX = 60


def _norm_path(value: str | None) -> str:
    """路径归一（Windows 大小写/分隔符无关），过滤匹配用。"""
    if not value:
        return ""
    v = str(value).replace("\\", "/").strip().rstrip("/")
    v = re.sub(r"/{2,}", "/", v)  # JSON 转义的 "\\\\" 归一成单斜杠
    return v.lower()


def session_roots() -> list[Path]:
    """pi 会话根目录：pi 官方覆盖变量优先，其次工作台变量，最后默认目录。"""
    for var in ("PI_CODING_AGENT_SESSION_DIR", "SPECLOCK2_PI_SESSIONS_DIR"):
        value = os.environ.get(var)
        if value:
            return [Path(value).expanduser()]
    return [Path.home() / ".pi" / "agent" / "sessions"]


def _mcode_roots() -> list[Path]:
    """mcode 会话根目录（~/.minimax/v2/sessions/<yyyy>/<mm>/<dd>/）；测试可覆盖。"""
    override = os.environ.get("SPECLOCK2_MCODE_SESSIONS_DIR")
    if override:
        return [Path(override).expanduser()]
    return [Path.home() / ".minimax" / "v2" / "sessions"]


def _parse_file(path: Path) -> dict | None:
    """解析单个会话文件：头行必须 type=session；返回 {id,title,mtime,path,cwd} 或 None。"""
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
    cwd = header.get("cwd") if isinstance(header.get("cwd"), str) else ""

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
    return {"id": sid, "title": title, "mtime": mtime, "path": path, "cwd": cwd}


def _scan_mcode() -> list[dict]:
    """mcode 会话发现（只读 id 与时间，不解析其内部消息格式）。

    每个会话是 ~/.minimax/v2/sessions/<yyyy>/<mm>/<dd>/<ts>_session_<blob>/ 下的
    一个目录，manifest.json 首部带 sessionId 与 createdAt/updatedAt（毫秒时间戳）——
    目录名里是编码 id，不能直接用，id 一律取 manifest。
    """
    found: list[dict] = []
    for root in _mcode_roots():
        if not root.is_dir():
            continue
        try:
            manifests = sorted(root.rglob("manifest.json"),
                               key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
        for manifest in manifests[:MAX_FILES]:
            path = manifest.parent
            if not path.is_dir():
                continue
            try:
                meta = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            sid = meta.get("sessionId")
            if not isinstance(sid, str) or not sid:
                continue
            ts = meta.get("updatedAtMs") or meta.get("createdAtMs")
            try:
                mtime = (ts / 1000) if isinstance(ts, (int, float)) else path.stat().st_mtime
            except OSError:
                continue
            found.append({"id": sid, "title": "mcode 会话", "mtime": mtime, "path": path,
                          "cwd": None})  # manifest 不记 cwd，过滤时按需探测
    return found


def _mcode_cwd_matches(session_dir: Path, cwd_norm: str) -> bool:
    """mcode cwd 判定：messages.jsonl 头部 agent-context 段内含工作目录路径。

    只做路径字符串包含检查（窗口 8KB），不解析其消息格式。
    """
    try:
        head = (session_dir / "messages.jsonl").read_bytes()[:CWD_PEEK_BYTES]
    except OSError:
        return False
    return cwd_norm in _norm_path(head.decode("utf-8", "replace"))


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
    found.extend(_scan_mcode())
    found.sort(key=lambda x: x["mtime"], reverse=True)
    return found


def scan(cwd: str | None = None) -> list[dict]:
    """会话清单（新→旧）：[{id, title, updated_at}]，供前端绑定主代理。

    cwd 给定时按会话所属工作目录过滤（修复单 3）：pi 用头行 cwd 精确匹配，
    mcode 用 messages 头部路径包含判定；cwd 未知的会话在过滤模式下不返回。
    """
    infos = _scan_all()
    if cwd:
        want = _norm_path(cwd)
        if not want:
            return []
        kept = []
        for info in infos:
            stored = _norm_path(info.get("cwd"))
            if stored:
                ok = stored == want
            elif info.get("title") == "mcode 会话":
                ok = _mcode_cwd_matches(info["path"], want)
            else:
                ok = False
            if ok:
                kept.append(info)
        infos = kept
    return [
        {
            "id": info["id"],
            "title": info["title"],
            "updated_at": datetime.fromtimestamp(info["mtime"], tz=timezone.utc).isoformat(),
        }
        for info in infos
    ]


def find_session_dir(session_id: str) -> Path | None:
    """按会话 id 定位其存储目录（pi 供 --session-dir，mcode 作存在性检查）；找不到返回 None。"""
    for info in _scan_all():
        if info["id"] == session_id:
            path: Path = info["path"]
            return path.parent if path.is_file() else path
    return None
