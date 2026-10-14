"""全局约定（DESIGN.md §5.5）：当前版 + 草稿、草稿写入、批准产生 ConventionVersion。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import flow, models, serialize
from ..errors import ApiError
from ..utils import now_iso

router = APIRouter(prefix="/api/p/{slug}")


class DraftBody(BaseModel):
    content_md: str


class ApproveBody(BaseModel):
    statement: dict


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


def _convention_row(session) -> models.Convention:
    """项目内全局唯一一份（§5.5），惰性建行。"""
    row = session.scalars(select(models.Convention).limit(1)).first()
    if row is None:
        row = models.Convention(created_at=now_iso())
        session.add(row)
        session.flush()
    return row


def _latest_version(session) -> models.ConventionVersion | None:
    return session.scalars(
        select(models.ConventionVersion).order_by(models.ConventionVersion.id.desc()).limit(1)
    ).first()


def _bump_patch(version: str) -> str:
    major, minor, patch = (int(p) for p in version.split("."))
    return f"{major}.{minor}.{patch + 1}"


@router.get("/conventions")
def get_conventions(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    with request.app.state.db.ledger_session(slug) as session:
        conv = _convention_row(session)
        latest = _latest_version(session)
        data = {
            "version": latest.version if latest else None,
            "content_md": latest.content.get("content_md") if latest else None,
            "draft_md": conv.draft_md,
            "statement": latest.statement if latest else None,
        }
    return data


@router.put("/conventions/draft")
def put_draft(slug: str, body: DraftBody, request: Request) -> dict:
    _project_or_404(request, slug)
    if not isinstance(body.content_md, str) or not body.content_md.strip():
        raise ApiError(422, "validation_error", "content_md 不能为空")
    with request.app.state.db.ledger_session(slug) as session:
        conv = _convention_row(session)
        conv.draft_md = body.content_md
        session.commit()
        latest = _latest_version(session)
        data = {
            "version": latest.version if latest else None,
            "content_md": latest.content.get("content_md") if latest else None,
            "draft_md": conv.draft_md,
            "statement": latest.statement if latest else None,
        }
    return data


@router.post("/conventions/approve")
def approve_conventions(slug: str, body: ApproveBody, request: Request) -> dict:
    _project_or_404(request, slug)
    stmt = body.statement or {}
    errors = []
    for key in ("说明", "动机"):
        v = stmt.get(key) if isinstance(stmt, dict) else None
        if not isinstance(v, str) or not v.strip():
            errors.append({"field": f"statement.{key}", "message": f"statement.{key} 不能为空"})
    if errors:
        raise ApiError(422, "validation_error", "约定批准校验失败", details={"errors": errors})

    with request.app.state.db.ledger_session(slug) as session:
        conv = _convention_row(session)
        if not (conv.draft_md or "").strip():
            raise ApiError(422, "validation_error", "没有待批准的约定草稿，先 PUT /conventions/draft")

        latest = _latest_version(session)
        # 约定是纯文本，无结构化 diff：首版 1.0.0，后续一律 PATCH（见回执"契约疑问"）
        round_ = flow.get_open_round(session)
        version = "1.0.0" if latest is None else _bump_patch(latest.version)
        cv = models.ConventionVersion(
            convention_id=conv.id,
            version=version,
            content={"content_md": conv.draft_md},
            round=round_.n if round_ else 0,
            statement={"说明": stmt["说明"].strip(), "动机": stmt["动机"].strip()},
            published_at=now_iso(),
        )
        session.add(cv)
        conv.draft_md = None  # 批准后草稿清空
        session.flush()

        flow.add_event(
            session, round_.n if round_ else 0, "human", "convention.published",
            {"version": version}, {"statement": cv.statement},
        )
        session.commit()
        session.refresh(cv)
        data = {
            "version": cv.version,
            "content_md": cv.content.get("content_md"),
            "draft_md": None,
            "statement": cv.statement,
        }
    return data
