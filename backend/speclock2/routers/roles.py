"""角色文档端点（契约 v0.6 §3.4）：核心代理与主代理的角色文档读写、预览。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

from .. import models
from ..errors import ApiError
from ..protocol import brief as brief_mod
from ..roles import compose, store

router = APIRouter(prefix="/api/p/{slug}")


class RoleBody(BaseModel):
    content: str = ""


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


def needs_restart(app, slug: str) -> bool:
    """核心代理会话在运行，且角色文档在会话启动后被改过。"""
    session = app.state.pi.get(slug)
    if session is None:
        return False
    started_with = getattr(session, "role_hash", None)
    return started_with is not None and started_with != compose.chief_hash(app.state.settings, slug)


def _chief_out(app, slug: str) -> dict:
    content, is_default = store.get_chief(app.state.settings, slug)
    return {"name": "chief", "content": content, "is_default": is_default,
            "needs_restart": needs_restart(app, slug)}


def _master_out(app, slug: str, name: str) -> dict:
    content, is_default = store.get_master(app.state.db, slug, name)
    return {"name": name, "content": content, "is_default": is_default, "needs_restart": False}


@router.get("/roles")
def list_roles(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    app = request.app
    chief = _chief_out(app, slug)
    masters = []
    for name in store.list_master_names(app.state.db, slug):
        m = _master_out(app, slug, name)
        masters.append({"name": name, "content": m["content"], "is_default": m["is_default"]})
    return {
        "chief": {"content": chief["content"], "is_default": chief["is_default"],
                  "needs_restart": chief["needs_restart"]},
        "masters": masters,
    }


@router.get("/roles/chief")
def get_chief(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    return _chief_out(request.app, slug)


@router.put("/roles/chief")
def put_chief(slug: str, body: RoleBody, request: Request) -> dict:
    _project_or_404(request, slug)
    store.set_chief(request.app.state.settings, slug, body.content)
    return _chief_out(request.app, slug)


@router.delete("/roles/chief")
def delete_chief(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    store.reset_chief(request.app.state.settings, slug)
    return _chief_out(request.app, slug)


@router.get("/roles/chief/preview")
def preview_chief(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    settings = request.app.state.settings
    editable, protocol = compose.chief_parts(settings, slug)
    return {"composed": compose.compose_chief_prompt(settings, slug, write=False),
            "editable_chars": len(editable), "protocol_chars": len(protocol)}


@router.get("/roles/masters/{name}")
def get_master(slug: str, name: str, request: Request) -> dict:
    _project_or_404(request, slug)
    return _master_out(request.app, slug, name)


@router.put("/roles/masters/{name}")
def put_master(slug: str, name: str, body: RoleBody, request: Request) -> dict:
    _project_or_404(request, slug)
    store.set_master(request.app.state.db, slug, name, body.content)
    return _master_out(request.app, slug, name)


@router.delete("/roles/masters/{name}")
def delete_master(slug: str, name: str, request: Request) -> dict:
    _project_or_404(request, slug)
    store.reset_master(request.app.state.db, slug, name)
    return _master_out(request.app, slug, name)


@router.get("/roles/masters/{name}/preview")
def preview_master(slug: str, name: str, request: Request) -> dict:
    _project_or_404(request, slug)
    db = request.app.state.db
    store.get_master(db, slug, name)  # 名册校验：不在名册 404
    editable, protocol = compose.master_parts(db, slug, name)
    brief = brief_mod.build_brief("（示例意图）", brief_mod.PLACEHOLDER_INSTRUCTIONS, [], [])
    return {"composed": compose.compose_master_prompt(db, slug, name, brief),
            "editable_chars": len(editable), "protocol_chars": len(protocol)}
