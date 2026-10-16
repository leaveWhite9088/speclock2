"""系统通知文案模板（契约 v0.6）：任务完成、任务失败、任务超时。

通知由 chief_notify 送进核心代理会话，核心代理据此向人转述。
模板读取 Report 对象，写入状态、摘要、文件数和问题。
"""

from __future__ import annotations

PREFIX = "系统通知："


def _who(task_id: str, master: str | None) -> str:
    return f"任务 {task_id}（{master or '未指派'}）"


def _issues(report: dict) -> str:
    issues = report.get("issues") or []
    return "；".join(issues) if issues else "无"


def task_completed(task_id: str, master: str | None, report: dict) -> str:
    files = report.get("files_changed") or []
    return (
        f"{PREFIX}{_who(task_id, master)}已回执，状态 {report.get('status')}。"
        f"摘要：{report.get('summary') or '（无）'}。"
        f"改动文件 {len(files)} 个：{'、'.join(files) if files else '（回执未声明文件）'}。"
        f"问题：{_issues(report)}。"
        "请向用户简报结果：文件名与数量以本通知为准，不要另编路径。"
    )


def task_failed(task_id: str, master: str | None, report: dict, stderr_tail: str | None = None) -> str:
    return (
        f"{PREFIX}{_who(task_id, master)}进程失败退出：{report.get('summary') or '（无原因）'}。"
        + (f"stderr 尾部：{stderr_tail}。" if stderr_tail else "")
        + "请向用户转述失败原因，不要臆测。"
    )


def task_timeout(task_id: str, master: str | None, report: dict, deadline: str | None) -> str:
    return (
        f"{PREFIX}{_who(task_id, master)}看门狗超时（期限 {deadline}），未收到回执。"
        "请向用户转述：任务未完成；过程输出里可能有线索，不要臆测原因。"
    )
