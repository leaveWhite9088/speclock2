"""模型 → 对外 JSON：id 一律字符串，时间为 ISO 8601 带时区。"""

from __future__ import annotations

from . import models


def project_out(p: models.Project) -> dict:
    return {"slug": p.slug, "name": p.name, "created_at": p.created_at, "status": p.status}


def domain_out(d: models.Domain) -> dict:
    return {"id": str(d.id), "title": d.title, "created_at": d.created_at}


def document_out(doc: models.Document) -> dict:
    return {
        "id": str(doc.id),
        "domain_id": str(doc.domain_id),
        "title": doc.title,
        "created_at": doc.created_at,
    }


def block_summary(b: models.Block) -> dict:
    """树节点用的模块摘要：含 status / 版本号。"""
    return {
        "id": str(b.id),
        "title": b.title,
        "status": b.status,
        "current_published_version": b.current_published_version,
    }


def draft_out(b: models.Block) -> dict:
    return {
        "content_md": b.draft_content_md,
        "rules": b.draft_rules_json,
        "apis": b.draft_apis_json,
        "nfr_md": b.draft_nfr_md,
    }


def version_out(v: models.BlockVersion) -> dict:
    return {
        "version": v.version,
        "round": v.round,
        "statement": v.statement,
        "delta_summary": (v.delta_json or {}).get("summary"),
    }


def block_out(b: models.Block, versions: list[models.BlockVersion]) -> dict:
    data = block_summary(b)
    data["draft"] = draft_out(b)
    data["versions"] = [version_out(v) for v in versions]
    return data


def card_out(c: models.ApprovalCard) -> dict:
    """open_card 摘要（S0 阶段恒为 null，S2/S3 充实）。"""
    return {"card_id": str(c.id), "round": c.round, "status": c.status}
