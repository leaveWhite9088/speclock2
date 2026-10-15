"""/api/projects：全局注册表（registry.db）。"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Request
from sqlalchemy import select

from .. import models, schemas, serialize
from ..errors import ApiError
from ..utils import now_iso

router = APIRouter()

# slug 同时用作账本文件名：限制字符集，防路径穿越（契约未定义字符集，见回执"契约疑问"）
SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def validate_working_dir(value: str | None) -> str | None:
    """working_dir 校验：空 = 未绑定；非空必须存在且为目录，落库为绝对路径。"""
    v = (value or "").strip()
    if not v:
        return None
    p = Path(v).expanduser()
    if not p.is_dir():
        raise ApiError(422, "validation_error", f"working_dir 不存在或不是目录：{v}")
    return str(p.resolve())


@router.get("/api/projects")
def list_projects(request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        rows = session.scalars(
            select(models.Project).order_by(models.Project.created_at, models.Project.slug)
        ).all()
    return {"items": [serialize.project_out(p) for p in rows]}


@router.delete("/api/projects/{slug}", status_code=200)
async def delete_project(slug: str, request: Request) -> dict:
    """删除项目（调整单 1）：注册表删行；账本不物理删除，改名 .deleted 可手工恢复。"""
    db = request.app.state.db
    with db.registry_session() as session:
        project = session.get(models.Project, slug)
        if project is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")
        session.delete(project)
        session.commit()
    await request.app.state.pi.stop(slug)  # 核心代理会话一并停（有则停，无则跳过）
    db.close_ledger(slug)  # 释放连接，否则 Windows 下文件改名被锁
    ledger = db.settings.ledger_path(slug)
    deleted = ledger.with_suffix(".db.deleted")
    if ledger.exists():
        deleted.unlink(missing_ok=True)  # 上一次删除残留的 .deleted 让位
        ledger.rename(deleted)
    return {"ok": True, "slug": slug, "ledger": deleted.name if deleted.exists() else None}


@router.post("/api/projects", status_code=201)
def create_project(body: schemas.ProjectCreate, request: Request) -> dict:
    if not SLUG_RE.match(body.slug or ""):
        raise ApiError(422, "validation_error", "slug 只允许字母、数字、-、_，长度 1~64")
    working_dir = validate_working_dir(body.working_dir)
    db = request.app.state.db
    with db.registry_session() as session:
        if session.get(models.Project, body.slug) is not None:
            raise ApiError(409, "conflict", f"slug 已存在：{body.slug}")
        project = models.Project(
            slug=body.slug, name=body.name, created_at=now_iso(), status="active",
            working_dir=working_dir,
            chief_provider=(body.chief_provider or "").strip() or None,
            chief_model=(body.chief_model or "").strip() or None,
        )
        session.add(project)
        session.commit()
        session.refresh(project)
        data = serialize.project_out(project)
    db.ledger_engine(body.slug)  # 创建即初始化独立账本文件（物理隔离，DESIGN.md §14.1）
    return data
