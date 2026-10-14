"""/api/p/{slug}/masters：项目主代理名册（列表/创建）。

主代理 = 名字 + 职责 + 目录所有权 + Harness×模型（只能从全局登记里选）+
绑定的 CLI 会话（唤醒后接续该会话工作）。工作台不替 Harness 配置模型，
harness/model 两个字段是登记信息的引用，创建时强校验。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import cli_sessions, models
from ..errors import ApiError
from ..utils import now_iso

router = APIRouter(prefix="/api/p/{slug}")


class CreateMasterBody(BaseModel):
    name: str = ""
    duty: str = ""
    dir: str = ""
    harness: str = ""
    model: str = ""
    session: str = ""


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


def master_out(row: models.Master) -> dict:
    policy = row.session_policy or {}
    return {
        "id": str(row.id),
        "name": row.name,
        "duty": row.role,
        "dir": row.working_dir or "",
        "harness": row.harness,
        "model": row.model,
        "session": policy.get("cli_session"),
        "session_title": policy.get("session_title"),
    }


@router.get("/masters")
def list_masters(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    db = request.app.state.db
    with db.ledger_session(slug) as session:
        rows = session.scalars(select(models.Master).order_by(models.Master.id)).all()
        return {"items": [master_out(r) for r in rows]}


@router.post("/masters", status_code=201)
def create_master(body: CreateMasterBody, slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    name = (body.name or "").strip()
    duty = (body.duty or "").strip()
    harness = (body.harness or "").strip()
    model = (body.model or "").strip()
    session_id = (body.session or "").strip()
    if not name or not duty:
        raise ApiError(422, "validation_error", "名称与职责必填")
    if not harness or not model:
        raise ApiError(422, "validation_error", "Harness 与模型必选（从「模型」登记里选）")

    db = request.app.state.db
    # 登记校验：harness×model 必须来自全局登记（不替 Harness 选模型，只引用登记）
    with db.registry_session() as registry:
        registered = registry.scalars(
            select(models.ModelEntry).where(
                models.ModelEntry.harness == harness, models.ModelEntry.model == model
            )
        ).first()
        if registered is None:
            raise ApiError(
                422, "validation_error",
                f"{harness} × {model} 未在「模型」登记，请先在右上角「模型」里登记",
            )
    # 会话探测：绑定必须真实存在（文件头 id 对得上）
    title = None
    if session_id:
        sessions = cli_sessions.scan()
        hit = next((s for s in sessions if s["id"] == session_id), None)
        if hit is None:
            raise ApiError(422, "validation_error", f"CLI 会话不存在：{session_id}（请刷新会话列表）")
        title = hit["title"]
    else:
        raise ApiError(422, "validation_error", "请选择要绑定的 CLI 会话")

    with db.ledger_session(slug) as session:
        exists = session.scalars(select(models.Master).where(models.Master.name == name)).first()
        if exists is not None:
            raise ApiError(409, "conflict", f"同名主代理已存在：{name}")
        row = models.Master(
            name=name,
            role=duty,
            harness=harness,
            model=model,
            working_dir=(body.dir or "").strip(),
            session_policy={"cli_session": session_id, "session_title": title},
            created_at=now_iso(),
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return master_out(row)
