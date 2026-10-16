"""核心代理向人汇报的格式规范（契约 v0.6）。"""

from __future__ import annotations

HUMAN_REPORT_FORMAT = (
    "向人汇报任务结果时，回复固定为三行：\n"
    "结果：一句话结论。\n"
    "问题：具体问题。没有就写无。\n"
    "下一步：建议动作。没有就写无。\n"
    "不要复述文件清单。系统会用 task.report 事件渲染文件清单等事实。"
)
