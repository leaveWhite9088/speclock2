"""GET /api/health：健康检查。"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter()


@router.get("/api/health")
def health() -> dict:
    return {"ok": True}
