"""时间线：轮次清单、轮次详情（events+versions+cards 聚合）、事件增量回放。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from sqlalchemy import select

from .. import models, serialize
from ..errors import ApiError
from ..utils import parse_prefixed_id

router = APIRouter(prefix="/api/p/{slug}")


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


@router.get("/rounds")
def list_rounds(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    with request.app.state.db.ledger_session(slug) as session:
        rounds = session.scalars(select(models.Round).order_by(models.Round.n)).all()
        data = [serialize.round_out(r) for r in rounds]
    return {"items": data}


@router.get("/rounds/{n}")
def round_detail(slug: str, n: str, request: Request) -> dict:
    _project_or_404(request, slug)
    try:
        no = int(n)
    except ValueError:
        raise ApiError(404, "not_found", f"轮次不存在：{n}")
    with request.app.state.db.ledger_session(slug) as session:
        round_ = session.scalars(select(models.Round).where(models.Round.n == no).limit(1)).first()
        if round_ is None:
            raise ApiError(404, "not_found", f"轮次不存在：{no}")
        events = session.scalars(
            select(models.Event).where(models.Event.round == no).order_by(models.Event.id)
        ).all()
        versions = session.scalars(
            select(models.BlockVersion).where(models.BlockVersion.round == no).order_by(models.BlockVersion.id)
        ).all()
        cards = session.scalars(
            select(models.ApprovalCard).where(models.ApprovalCard.round == no).order_by(models.ApprovalCard.id)
        ).all()
        data = {
            "round": serialize.round_out(round_),
            "events": [serialize.event_out(e) for e in events],
            "versions": [
                {**serialize.version_out(v), "block_id": str(v.block_id)} for v in versions
            ],
            "cards": [serialize.card_out(c) for c in cards],
        }
    return data


@router.get("/events")
def list_events(
    slug: str,
    request: Request,
    since: str | None = Query(default=None),
    type_: str | None = Query(default=None, alias="type"),
) -> dict:
    """append-only 事件流的增量回放：since 为对外事件 id（如 E-0012），返回其后的全部事件。"""
    _project_or_404(request, slug)
    since_id = parse_prefixed_id(since, "E") if since else None
    if since is not None and since_id is None:
        raise ApiError(422, "validation_error", f"since 不是合法的事件 id：{since!r}")
    with request.app.state.db.ledger_session(slug) as session:
        stmt = select(models.Event).order_by(models.Event.id)
        if since_id is not None:
            stmt = stmt.where(models.Event.id > since_id)
        if type_ is not None:
            stmt = stmt.where(models.Event.type == type_)
        events = session.scalars(stmt).all()
        data = [serialize.event_out(e) for e in events]
    return {"items": data}
