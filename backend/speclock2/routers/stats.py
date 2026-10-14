"""统计聚合：仪表盘渲染源（契约 v0.2 Stats 形状）。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from .. import models
from ..errors import ApiError

router = APIRouter(prefix="/api/p/{slug}")

# 仪表盘固定展示的任务状态键（含 0 计数，前端好遍历）
TASK_STATUS_KEYS = ("queued", "dispatched", "reported", "done", "rejected", "timeout")


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


@router.get("/stats")
def get_stats(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    with request.app.state.db.ledger_session(slug) as session:
        closed = session.scalar(
            select(func.count()).select_from(models.Round).where(models.Round.closed_at.is_not(None))
        ) or 0
        open_round = session.scalar(
            select(func.max(models.Round.n)).where(models.Round.closed_at.is_(None))
        ) or 0

        cards = dict(
            session.execute(
                select(models.ApprovalCard.status, func.count()).group_by(models.ApprovalCard.status)
            ).all()
        )

        packages = session.scalars(select(models.TaskPackage)).all()
        tasks_all = session.scalars(select(models.Task)).all()
        by_pkg: dict[int, list[models.Task]] = {}
        for t in tasks_all:
            by_pkg.setdefault(t.package_id, []).append(t)
        done_pkgs = active_pkgs = 0
        for p in packages:
            states = {t.status for t in by_pkg.get(p.id, [])}
            if not states or states <= {"done", "rejected"}:
                done_pkgs += 1
            else:
                active_pkgs += 1

        task_counts = {k: 0 for k in TASK_STATUS_KEYS}
        for t in tasks_all:
            task_counts[t.status] = task_counts.get(t.status, 0) + 1

        data = {
            "rounds": {"count": closed, "open": open_round},
            "cards": {
                "pending": cards.get("pending", 0),
                "approved": cards.get("approved", 0),
                "rejected": cards.get("rejected", 0),
            },
            "packages": {"done": done_pkgs, "active": active_pkgs},
            "tasks": task_counts,
        }
    return data
