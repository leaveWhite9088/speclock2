"""/api/p/{slug}/...：项目详情、三层树、domain/document/block 草稿态创建、草稿四件套读写。

卡片/轮次/事件/队列/约定/统计端点在 cards.py / timeline.py / queue.py /
conventions.py / stats.py（S2 实现）。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import func, select

from .. import models, schemas, serialize, validation
from ..errors import ApiError
from ..utils import now_iso, parse_int_id, parse_int_or_none

router = APIRouter(prefix="/api/p/{slug}")


def _project_or_404(session, slug: str) -> models.Project:
    project = session.get(models.Project, slug)
    if project is None:
        raise ApiError(404, "not_found", f"项目不存在：{slug}")
    return project


def _block_or_404(session, block_id: str) -> models.Block:
    block = session.get(models.Block, parse_int_or_none(block_id))
    if block is None:
        raise ApiError(404, "not_found", f"模块不存在：{block_id}")
    return block


def _versions_of(session, block_id: int) -> list[models.BlockVersion]:
    return (
        session.scalars(
            select(models.BlockVersion)
            .where(models.BlockVersion.block_id == block_id)
            .order_by(models.BlockVersion.id)
        )
        .all()
    )


# ---------- S0 真实现 ----------


@router.get("")
def project_detail(slug: str, request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        project = serialize.project_out(_project_or_404(session, slug))
    with db.ledger_session(slug) as session:
        current_round = session.scalar(select(func.max(models.Round.n))) or 0
        pending = session.scalars(
            select(models.ApprovalCard).where(models.ApprovalCard.decision.is_(None)).limit(1)
        ).first()
    project["current_round"] = current_round
    project["open_card"] = serialize.card_out(pending) if pending else None
    return project


@router.get("/tree")
def project_tree(slug: str, request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        _project_or_404(session, slug)
    with db.ledger_session(slug) as session:
        domains = session.scalars(select(models.Domain).order_by(models.Domain.id)).all()
        documents = session.scalars(select(models.Document).order_by(models.Document.id)).all()
        blocks = session.scalars(select(models.Block).order_by(models.Block.id)).all()

    docs_by_domain: dict[int, list[models.Document]] = {}
    for doc in documents:
        docs_by_domain.setdefault(doc.domain_id, []).append(doc)
    blocks_by_doc: dict[int, list[models.Block]] = {}
    for blk in blocks:
        blocks_by_doc.setdefault(blk.document_id, []).append(blk)

    items = []
    for d in domains:
        docs = [
            {
                "id": str(doc.id),
                "title": doc.title,
                "blocks": [serialize.block_summary(b) for b in blocks_by_doc.get(doc.id, [])],
            }
            for doc in docs_by_domain.get(d.id, [])
        ]
        items.append({"id": str(d.id), "title": d.title, "documents": docs})
    return {"items": items}


@router.post("/domains", status_code=201)
def create_domain(slug: str, body: schemas.DomainCreate, request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        _project_or_404(session, slug)
    with db.ledger_session(slug) as session:
        domain = models.Domain(title=body.title, created_at=now_iso())
        session.add(domain)
        session.commit()
        session.refresh(domain)
        data = serialize.domain_out(domain)
    return data


@router.post("/documents", status_code=201)
def create_document(slug: str, body: schemas.DocumentCreate, request: Request) -> dict:
    domain_id = parse_int_id(body.domain_id, "domain_id")
    db = request.app.state.db
    with db.registry_session() as session:
        _project_or_404(session, slug)
    with db.ledger_session(slug) as session:
        if session.get(models.Domain, domain_id) is None:
            raise ApiError(404, "not_found", f"domain 不存在：{body.domain_id}")
        doc = models.Document(domain_id=domain_id, title=body.title, created_at=now_iso())
        session.add(doc)
        session.commit()
        session.refresh(doc)
        data = serialize.document_out(doc)
    return data


@router.post("/blocks", status_code=201)
def create_block(slug: str, body: schemas.BlockCreate, request: Request) -> dict:
    document_id = parse_int_id(body.document_id, "document_id")
    db = request.app.state.db
    with db.registry_session() as session:
        _project_or_404(session, slug)
    with db.ledger_session(slug) as session:
        if session.get(models.Document, document_id) is None:
            raise ApiError(404, "not_found", f"document 不存在：{body.document_id}")
        block = models.Block(document_id=document_id, title=body.title, created_at=now_iso(), updated_at=now_iso())
        session.add(block)
        session.commit()
        session.refresh(block)
        data = serialize.block_out(block, [])
    return data


@router.get("/blocks/{block_id}")
def get_block(slug: str, block_id: str, request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        _project_or_404(session, slug)
    with db.ledger_session(slug) as session:
        block = _block_or_404(session, block_id)
        versions = _versions_of(session, block.id)
        data = serialize.block_out(block, versions)
    return data


@router.put("/blocks/{block_id}")
def update_block_draft(slug: str, block_id: str, body: schemas.BlockDraftUpdate, request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        _project_or_404(session, slug)
    with db.ledger_session(slug) as session:
        block = _block_or_404(session, block_id)
        # 先整体校验再落库：任一条非法则整次 PUT 拒绝，草稿保持原样（事务性）
        errors: list[dict] = []
        new_rules = block.draft_rules_json or []
        new_apis = block.draft_apis_json or []
        new_seq = block.rule_seq or 0
        if body.rules is not None:
            try:
                new_rules, new_seq = validation.validate_rules(
                    body.rules, block.draft_rules_json or [], block.rule_seq or 0
                )
            except validation.DraftValidationError as exc:
                errors.extend(exc.errors)
        if body.apis is not None:
            try:
                new_apis = validation.validate_apis(body.apis)
            except validation.DraftValidationError as exc:
                errors.extend(exc.errors)
        if errors:
            raise ApiError(422, "validation_error", "草稿校验失败", details={"errors": errors})
        # 只存草稿，不产生任何版本；版本只在批准时产生（DESIGN.md §6.1）
        # 批准后再编辑草稿 → 模块回到草稿态（有未发布改动）
        block.status = "draft"
        if body.content_md is not None:
            block.draft_content_md = body.content_md
        if body.rules is not None:
            block.draft_rules_json = new_rules
            block.rule_seq = new_seq
        if body.apis is not None:
            block.draft_apis_json = new_apis
        if body.nfr_md is not None:
            block.draft_nfr_md = body.nfr_md
        block.updated_at = now_iso()
        session.commit()
        session.refresh(block)
        versions = _versions_of(session, block.id)
        data = serialize.block_out(block, versions)
    return data
