"""角色文档存储。对外是统一接口：调用方不关心文档存在哪里。

- 核心代理文档：data/roles/{slug}/chief.md（没有文件就用默认模板）。
- 主代理文档：账本 masters.agents_md 字段（为空就用默认模板）。
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import select

from .. import models
from ..errors import ApiError

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"


def default_template(kind: str) -> str:
    return (TEMPLATES_DIR / f"{kind}.md").read_text(encoding="utf-8")


def chief_path(settings, slug: str) -> Path:
    return settings.data_dir / "roles" / slug / "chief.md"


def composed_chief_path(settings, slug: str) -> Path:
    return settings.data_dir / "roles" / slug / "chief.composed.md"


def require_content(content: str | None) -> str:
    if not isinstance(content, str) or not content.strip():
        raise ApiError(422, "validation_error", "content 不能为空")
    return content


# ---------- 核心代理 ----------


def get_chief(settings, slug: str) -> tuple[str, bool]:
    """返回 (内容, 是否默认模板)。"""
    p = chief_path(settings, slug)
    if p.exists():
        text = p.read_text(encoding="utf-8")
        if text.strip():
            return text, False
    return default_template("chief"), True


def set_chief(settings, slug: str, content: str) -> None:
    p = chief_path(settings, slug)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(require_content(content), encoding="utf-8")


def reset_chief(settings, slug: str) -> None:
    p = chief_path(settings, slug)
    if p.exists():
        p.unlink()


# ---------- 主代理 ----------


def _master_row(session, name: str) -> models.Master:
    row = session.scalars(select(models.Master).where(models.Master.name == name)).first()
    if row is None:
        raise ApiError(404, "not_found", f"主代理不在名册：{name}")
    return row


def list_master_names(db, slug: str) -> list[str]:
    with db.ledger_session(slug) as session:
        return list(session.scalars(select(models.Master.name).order_by(models.Master.id)).all())


def get_master(db, slug: str, name: str) -> tuple[str, bool]:
    with db.ledger_session(slug) as session:
        row = _master_row(session, name)
        text = row.agents_md
    if text and text.strip():
        return text, False
    return default_template("master"), True


def get_master_or_default(db, slug: str, name: str | None) -> str:
    """派发用：主代理不在名册（纯替身自测）时退回默认模板，不报错。"""
    if name:
        try:
            return get_master(db, slug, name)[0]
        except ApiError:
            pass
    return default_template("master")


def set_master(db, slug: str, name: str, content: str) -> None:
    require_content(content)
    with db.ledger_session(slug) as session:
        row = _master_row(session, name)
        row.agents_md = content
        session.commit()


def reset_master(db, slug: str, name: str) -> None:
    with db.ledger_session(slug) as session:
        row = _master_row(session, name)
        row.agents_md = None
        session.commit()
