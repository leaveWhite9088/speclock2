"""/api/p/{slug}/masters：项目主代理名册（列表/创建/编辑/删除）。

主代理 = 名字 + 职责 + 目录所有权 + Harness×模型（只能从全局登记里选）+
绑定的 CLI 会话（唤醒后接续该会话工作）。工作台不替 Harness 配置模型，
harness/model 是登记信息的引用，创建与编辑时强校验。
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
    # LLM 供应商名，按 harness 方言（pi=minimax-cn、mcode=minimax，修复单 21）；
    # 缺省从登记条目推断
    provider: str | None = None
    session: str = ""


class PatchMasterBody(BaseModel):
    """PATCH：只更新显式传入的字段。"""

    name: str | None = None
    duty: str | None = None
    dir: str | None = None
    harness: str | None = None
    model: str | None = None
    provider: str | None = None
    session: str | None = None


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
        "provider": row.provider or "",
        "session": policy.get("cli_session"),
        "session_title": policy.get("session_title"),
    }


def _find_registration(db, harness: str, model: str):
    """登记匹配：model 原样，或「登记.provider/登记.model」组合（兼容旧全串写法）。"""
    with db.registry_session() as registry:
        entries = registry.scalars(
            select(models.ModelEntry).where(models.ModelEntry.harness == harness)
        ).all()
    for entry in entries:
        if entry.model == model:
            return entry
        if entry.provider and f"{entry.provider}/{entry.model}" == model:
            return entry
    return None


def _validate_binding(db, harness: str, model: str) -> models.ModelEntry:
    if not harness or not model:
        raise ApiError(422, "validation_error", "Harness 与模型必选（从「模型」登记里选）")
    entry = _find_registration(db, harness, model)
    if entry is None:
        raise ApiError(
            422, "validation_error",
            f"{harness} × {model} 未在「模型」登记，请先在右上角「模型」里登记",
        )
    return entry


def _validate_session(session_id: str) -> str | None:
    """会话绑定可选（修复单 22）：空 = 开始新对话，不绑定、不校验；
    提供了 id 才要求存在于 CLI 会话清单。返回会话标题或 None。"""
    if not session_id:
        return None
    sessions = cli_sessions.scan()
    hit = next((s for s in sessions if s["id"] == session_id), None)
    if hit is None:
        raise ApiError(422, "validation_error", f"CLI 会话不存在：{session_id}（请刷新会话列表）")
    return hit["title"]


def _session_policy(session_id: str, title: str | None) -> dict:
    """session_policy：绑定会话时落 {cli_session, session_title}；未绑定落 {}。"""
    sid = (session_id or "").strip()
    return {"cli_session": sid, "session_title": title} if sid else {}


def _master_or_404(session, master_id: str) -> models.Master:
    row = session.get(models.Master, parse_master_id(master_id))
    if row is None:
        raise ApiError(404, "not_found", f"主代理不存在：{master_id}")
    return row


def parse_master_id(value: str) -> int:
    from ..utils import parse_int_id

    return parse_int_id(value, "master_id")


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
    if not name or not duty:
        raise ApiError(422, "validation_error", "名称与职责必填")

    db = request.app.state.db
    entry = _validate_binding(db, harness, model)
    provider = (body.provider or "").strip() or (entry.provider or "")
    session_title = _validate_session((body.session or "").strip())

    with db.ledger_session(slug) as session:
        exists = session.scalars(select(models.Master).where(models.Master.name == name)).first()
        if exists is not None:
            raise ApiError(409, "conflict", f"同名主代理已存在：{name}")
        row = models.Master(
            name=name,
            role=duty,
            harness=harness,
            model=model,
            provider=provider or None,
            working_dir=(body.dir or "").strip(),
            session_policy=_session_policy(body.session, session_title),
            created_at=now_iso(),
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return master_out(row)


@router.patch("/masters/{master_id}")
def patch_master(body: PatchMasterBody, slug: str, master_id: str, request: Request) -> dict:
    """编辑主代理（调整单 3）：只动显式传入的字段；harness/model 变更时校验同创建。"""
    _project_or_404(request, slug)
    db = request.app.state.db
    with db.ledger_session(slug) as session:
        row = _master_or_404(session, master_id)
        fields = body.model_fields_set

        if "name" in fields:
            name = (body.name or "").strip()
            if not name:
                raise ApiError(422, "validation_error", "名称不能为空")
            dup = session.scalars(
                select(models.Master).where(models.Master.name == name)
            ).first()
            if dup is not None and dup.id != row.id:
                raise ApiError(409, "conflict", f"同名主代理已存在：{name}")
            row.name = name
        if "duty" in fields:
            duty = (body.duty or "").strip()
            if not duty:
                raise ApiError(422, "validation_error", "职责不能为空")
            row.role = duty
        if "harness" in fields or "model" in fields:
            harness = (body.harness if "harness" in fields else row.harness or "").strip()
            model = (body.model if "model" in fields else row.model or "").strip()
            entry = _validate_binding(db, harness, model)
            row.harness, row.model = harness, model
            if "provider" not in fields:
                row.provider = entry.provider or None  # 换绑登记时跟随登记的 provider
        if "provider" in fields:
            row.provider = (body.provider or "").strip() or None
        if "dir" in fields:
            row.working_dir = (body.dir or "").strip()
        if "session" in fields:
            title = _validate_session((body.session or "").strip())
            row.session_policy = _session_policy(body.session, title)
        session.commit()
        session.refresh(row)
        return master_out(row)


@router.delete("/masters/{master_id}")
def delete_master(slug: str, master_id: str, request: Request) -> dict:
    """删除主代理：有 dispatched/running 任务时 409（先处理在跑的任务）。"""
    _project_or_404(request, slug)
    db = request.app.state.db
    with db.ledger_session(slug) as session:
        row = _master_or_404(session, master_id)
        busy = session.scalars(
            select(models.Task).where(
                models.Task.master == row.name,
                models.Task.status.in_(("dispatched", "running")),
            )
        ).first()
        if busy is not None:
            raise ApiError(409, "conflict",
                           f"主代理 {row.name} 有在跑的任务（T-{busy.id:04d}），先处理再删除")
        session.delete(row)
        session.commit()
    return {}
