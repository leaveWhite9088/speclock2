"""小工具：时间与 id 解析。"""

from __future__ import annotations

import re
from datetime import datetime

from .errors import ApiError

# ISO 8601 带时区偏移，秒精度（DESIGN.md §5.5 时间约定）
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def is_iso(value: str) -> bool:
    return bool(_ISO_RE.match(value))


def parse_int_id(value: str, field: str) -> int:
    """请求体里的 id（对外为字符串）：非法时报 422。"""
    try:
        return int(str(value).strip())
    except ValueError:
        raise ApiError(422, "validation_error", f"{field} 不是合法的 id：{value!r}")


def parse_int_or_none(value: str) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def fmt_id(prefix: str, n: int) -> str:
    """对外 id 格式：E-0001 / C-0001 / P-0001 / T-0001 / O-0001（DESIGN.md §7.2、§6.4）。"""
    return f"{prefix}-{n:04d}"


def parse_prefixed_id(value: str, prefix: str) -> int | None:
    """'C-0001' 或 '1' -> 1；不合法返回 None。"""
    s = str(value).strip()
    if s.upper().startswith(f"{prefix}-"):
        s = s[len(prefix) + 1:]
    return parse_int_or_none(s)
