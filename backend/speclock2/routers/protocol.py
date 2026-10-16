"""GET /api/protocol：系统规定的报告格式（只读文本，前端展示用）。"""

from __future__ import annotations

from fastapi import APIRouter

from ..protocol import human, report

router = APIRouter(prefix="/api")


@router.get("/protocol")
def get_protocol() -> dict:
    return {"report_format": report.REPORT_FORMAT, "human_report_format": human.HUMAN_REPORT_FORMAT}
