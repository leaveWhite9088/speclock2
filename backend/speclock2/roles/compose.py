"""提示词组装：可编辑段 + 协议段（+ 任务段）。

协议段由系统写死，用户改不了。可编辑段里手写的协议文字会被清掉，
所以协议段在组装结果里永远出现且只出现一次。
"""

from __future__ import annotations

import hashlib
import re

from ..protocol import human, report
from . import store

CHIEF_DISPATCH_CONVENTION = (
    "派发约定：\n"
    "- 派发是异步的。工具返回「已派发」不等于完成。\n"
    "- 任务结果由系统通知送达。你按通知原文向人转述。\n"
    "- 文件名、数量、结论以系统通知为准，不另编。"
)

_MARKER_LINE_RE = re.compile(
    r"^.*(?:" + re.escape(report.BLOCK_START) + "|" + re.escape(report.BLOCK_END) + r").*$",
    re.MULTILINE,
)


def chief_protocol() -> str:
    return human.HUMAN_REPORT_FORMAT + "\n\n" + CHIEF_DISPATCH_CONVENTION


def master_protocol() -> str:
    return report.REPORT_FORMAT


def sanitize_editable(content: str) -> str:
    """清掉可编辑段里的协议文字：整段协议原文、报告块标记行。"""
    out = content
    for protocol_text in (report.REPORT_FORMAT, human.HUMAN_REPORT_FORMAT, CHIEF_DISPATCH_CONVENTION):
        out = out.replace(protocol_text, "")
    out = _MARKER_LINE_RE.sub("", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _join(*parts: str) -> str:
    return "\n\n".join(p for p in parts if p)


def chief_parts(settings, slug: str) -> tuple[str, str]:
    editable, _ = store.get_chief(settings, slug)
    return sanitize_editable(editable), chief_protocol()


def compose_chief_prompt(settings, slug: str, write: bool = True) -> str:
    """核心代理提示词 = 可编辑段 + 协议段。write 为真时写入 chief.composed.md。"""
    editable, protocol = chief_parts(settings, slug)
    text = _join(editable, "## 系统协议（不可编辑）\n\n" + protocol) + "\n"
    if write:
        p = store.composed_chief_path(settings, slug)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return text


def chief_hash(settings, slug: str) -> str:
    return hashlib.sha1(compose_chief_prompt(settings, slug, write=False).encode("utf-8")).hexdigest()


def master_parts(db, slug: str, master: str | None) -> tuple[str, str]:
    editable = store.get_master_or_default(db, slug, master)
    return sanitize_editable(editable), master_protocol()


def compose_master_prompt(db, slug: str, master: str | None, brief: str) -> str:
    """主代理提示词 = 可编辑段 + 协议段 + 任务段。"""
    editable, protocol = master_parts(db, slug, master)
    return _join(editable, "## 系统协议（不可编辑）\n\n" + protocol, brief) + "\n"
