"""请求体模型（契约 v0）。"""

from __future__ import annotations

from pydantic import BaseModel


class ProjectCreate(BaseModel):
    slug: str
    name: str


class DomainCreate(BaseModel):
    title: str


class DocumentCreate(BaseModel):
    domain_id: str  # 对外 id 一律字符串
    title: str


class BlockCreate(BaseModel):
    document_id: str
    title: str


class BlockDraftUpdate(BaseModel):
    """草稿四件套：只传需要更新的字段，未传字段保持原值（S0 不做 rules/apis 深度校验，S1 充实）。"""

    content_md: str | None = None
    rules: list | None = None
    apis: list | None = None
    nfr_md: str | None = None
