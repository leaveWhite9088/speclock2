"""请求体模型（契约 v0）。"""

from __future__ import annotations

from pydantic import BaseModel


class ProjectCreate(BaseModel):
    slug: str
    name: str
    working_dir: str | None = None  # 绑定目标仓库目录（必须存在且为目录）
    chief_provider: str | None = None  # 项目级核心代理 provider（空 = 跟随全局 env）
    chief_model: str | None = None


class ProjectPatch(BaseModel):
    """PATCH /api/p/{slug}：只更新显式传入的字段（显式 "" 清空）。"""

    working_dir: str | None = None
    chief_provider: str | None = None
    chief_model: str | None = None


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
