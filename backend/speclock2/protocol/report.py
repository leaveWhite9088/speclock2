"""主代理报告块的解析与校验（契约 v0.6 §3.1、§3.2）。

主代理在最终回复的末尾输出一个报告块：

    <<<SL2-REPORT
    {"status":"done","summary":"...","files":["a/b.txt"],"issues":[]}
    SL2-REPORT>>>

本模块是报告解析的唯一实现。
"""

from __future__ import annotations

import json
import re

BLOCK_START = "<<<SL2-REPORT"
BLOCK_END = "SL2-REPORT>>>"

STATUSES = ("done", "partial", "blocked", "failed")
SUMMARY_LIMIT = 300
FILES_LIMIT = 50

BLOCK_RE = re.compile(re.escape(BLOCK_START) + r"(.*?)" + re.escape(BLOCK_END), re.DOTALL)
LEGACY_FILES_RE = re.compile(r"FILES:\s*(.+)")

# 给主代理看的格式要求（协议段）：roles 模块把它拼进主代理提示词，GET /api/protocol 原文展示
REPORT_FORMAT = (
    "完成任务后，在最终回复的末尾输出一个报告块。格式固定，不要改动分隔行：\n"
    f"{BLOCK_START}\n"
    '{"status":"done","summary":"一句话说明做了什么","files":["a/b.txt"],"issues":[]}\n'
    f"{BLOCK_END}\n"
    "字段规则：\n"
    "- status 取值：done（全部完成）、partial（部分完成）、blocked（被阻塞）、failed（失败）。\n"
    f"- summary：一句话，不超过 {SUMMARY_LIMIT} 字。\n"
    f"- files：你改动的文件路径数组，最多 {FILES_LIMIT} 项。路径可以含空格。\n"
    "- issues：遇到的问题数组。没有问题就写空数组。\n"
    "报告块只出现一次，放在回复的最后。"
)


def make_report(status: str, summary: str, files: list[str] | None = None,
                issues: list[str] | None = None, parse_quality: str = "none") -> dict:
    """组装 Report 对象（契约 v0.6 §3.2）。"""
    return {
        "status": status,
        "summary": summary,
        "files_changed": list(files or []),
        "issues": list(issues or []),
        "parse_quality": parse_quality,
    }


def _tail(text: str, limit: int = SUMMARY_LIMIT) -> str:
    return text.strip()[-limit:]


def _validate_block(data) -> tuple[dict | None, str]:
    """校验报告块 JSON；合法返回 (规范化字段, "")，不合法返回 (None, 原因)。"""
    if not isinstance(data, dict):
        return None, "报告块不是 JSON 对象"
    status = data.get("status")
    if status not in STATUSES:
        return None, f"status 必须是 {'、'.join(STATUSES)} 之一"
    summary = data.get("summary", "")
    if not isinstance(summary, str):
        return None, "summary 必须是字符串"
    files = data.get("files", [])
    if not isinstance(files, list) or not all(isinstance(f, str) for f in files):
        return None, "files 必须是字符串数组"
    issues = data.get("issues", [])
    if not isinstance(issues, list) or not all(isinstance(i, str) for i in issues):
        return None, "issues 必须是字符串数组"
    return {
        "status": status,
        "summary": summary[:SUMMARY_LIMIT],
        "files": files[:FILES_LIMIT],
        "issues": list(issues),
    }, ""


def parse_output(text: str, exit_code: int = 0) -> dict:
    """从主代理输出解析 Report 对象。规则见契约 v0.6 §3.1。

    1. 取最后一个完整的报告块；块合法则 parse_quality 为 structured。
    2. 块里的 JSON 非法则 parse_quality 为 invalid。
    3. 没有报告块但有「FILES:」行，按旧规则解析，parse_quality 为 legacy。
    4. 两者都没有，parse_quality 为 none，summary 取输出尾部 300 字。
    5. 退出码非零时，status 一律是 failed。
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    blocks = BLOCK_RE.findall(text)

    if blocks:
        raw = blocks[-1].strip()
        try:
            fields, reason = _validate_block(json.loads(raw))
        except json.JSONDecodeError as exc:
            fields, reason = None, f"JSON 非法：{exc.msg}"
        if fields is not None:
            report = make_report(fields["status"], fields["summary"], fields["files"],
                                 fields["issues"], "structured")
        else:
            report = make_report("done", _tail(text), [], [f"报告块不合法：{reason}"], "invalid")
    else:
        legacy = None
        for line in text.splitlines():
            m = LEGACY_FILES_RE.search(line)
            if m:
                legacy = [f for f in m.group(1).split() if f]
                break
        if legacy is not None:
            report = make_report("done", _tail(text), legacy[:FILES_LIMIT], [], "legacy")
        else:
            report = make_report("done", _tail(text), [], [], "none")

    if exit_code != 0:
        report["status"] = "failed"
    return report


def failure_report(reason: str) -> dict:
    """进程崩溃、无法启动、看门狗超时的失败报告（契约 v0.6 §3.3）。"""
    return make_report("failed", (reason or "").strip()[:SUMMARY_LIMIT], [], [], "none")


def manual_report(summary: str, files: list[str] | None) -> dict:
    """人工回执（POST /tasks/{id}/receipt）的报告：parse_quality 为 manual。"""
    return make_report("done", (summary or "")[:SUMMARY_LIMIT], files or [], [], "manual")
