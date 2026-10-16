"""任务说明骨架（契约 v0.6）：把意图、说明、范围、验收拼成给主代理的任务段。"""

from __future__ import annotations

PLACEHOLDER_INSTRUCTIONS = "（示例任务说明）"


def build_brief(intent: str, instructions: str, scope: list[str] | None = None,
                acceptance: list[str] | None = None) -> str:
    lines = ["## 任务", "", f"意图：{(intent or '').strip() or '（未写明）'}", ""]
    lines.append("范围（只改这些路径）：")
    lines.extend([f"- {s}" for s in scope] if scope else ["- （未限定）"])
    lines.append("")
    lines.append("验收标准：")
    lines.extend([f"- {a}" for a in acceptance] if acceptance else ["- （未写明）"])
    lines.extend(["", "任务说明：", (instructions or "").strip()])
    return "\n".join(lines)
