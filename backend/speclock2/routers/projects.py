"""/api/projects：全局注册表（registry.db）。"""

from __future__ import annotations

import re

from fastapi import APIRouter, Request
from sqlalchemy import select

from .. import models, schemas, serialize
from ..errors import ApiError
from ..utils import now_iso

router = APIRouter()

# slug 同时用作账本文件名：限制字符集，防路径穿越（契约未定义字符集，见回执"契约疑问"）
SLUG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@router.get("/api/projects")
def list_projects(request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        rows = session.scalars(
            select(models.Project).order_by(models.Project.created_at, models.Project.slug)
        ).all()
    return {"items": [serialize.project_out(p) for p in rows]}


@router.post("/api/projects", status_code=201)
def create_project(body: schemas.ProjectCreate, request: Request) -> dict:
    if not SLUG_RE.match(body.slug or ""):
        raise ApiError(422, "validation_error", "slug 只允许字母、数字、-、_，长度 1~64")
    db = request.app.state.db
    with db.registry_session() as session:
        if session.get(models.Project, body.slug) is not None:
            raise ApiError(409, "conflict", f"slug 已存在：{body.slug}")
        project = models.Project(slug=body.slug, name=body.name, created_at=now_iso(), status="active")
        session.add(project)
        session.commit()
        session.refresh(project)
        data = serialize.project_out(project)
    db.ledger_engine(body.slug)  # 创建即初始化独立账本文件（物理隔离，DESIGN.md §14.1）
    return data
