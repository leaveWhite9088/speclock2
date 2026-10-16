"""模型 → 对外 JSON：id 一律字符串（事件/卡片/包/任务/技术单带前缀），时间为 ISO 8601 带时区。"""

from __future__ import annotations

from . import models
from .utils import fmt_id


def project_out(p: models.Project) -> dict:
    return {"slug": p.slug, "name": p.name, "created_at": p.created_at, "status": p.status,
            "working_dir": p.working_dir,
            "chief_provider": p.chief_provider, "chief_model": p.chief_model}


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


def event_out(e: models.Event) -> dict:
    return {
        "id": fmt_id("E", e.id),
        "ts": e.ts,
        "round": e.round,
        "actor": e.actor,
        "type": e.type,
        "ref": e.ref or {},
        "payload": e.payload or {},
    }


def card_out(c: models.ApprovalCard) -> dict:
    return {
        "card_id": fmt_id("C", c.id),
        "round": c.round,
        "status": c.status,
        "statement": c.statement,
        "rule_ops": c.rule_ops or [],
        "api_ops": c.api_ops or [],
        "convention_ops": c.convention_ops or [],
        "breaking_count": c.breaking_count,
        "impact": c.impact or [],
        "task_preview": c.task_preview or [],
        "risk": c.risk,
        "narration_event": c.narration_event,
        "decision": c.decision,
        "created_at": c.created_at,
    }


def receipt_out(r: models.Receipt) -> dict:
    return {
        "files_changed": r.files_changed or [],
        "self_check": r.self_check,
        "summary": r.summary,
        "telemetry": r.telemetry,  # 过程遥测（时长/token，§13.5）
        "report": r.report,  # 契约 v0.6 Report 对象；老账本回执为 null
        "created_at": r.created_at,
    }


def task_out(t: models.Task, receipt: models.Receipt | None = None) -> dict:
    return {
        "task_id": fmt_id("T", t.id),
        "master": t.master,
        "status": t.status,
        "watchdog_deadline": t.watchdog_deadline,
        "receipt": receipt_out(receipt) if receipt else None,
        "output_tail": t.output_tail,
    }


def package_out(p: models.TaskPackage, tasks: list[models.Task], receipts: dict[int, models.Receipt]) -> dict:
    return {
        "package_id": fmt_id("P", p.id),
        "origin": p.origin,
        "round": p.round,
        "version_refs": p.version_refs or {},
        "tasks": [task_out(t, receipts.get(t.id)) for t in tasks],
        "created_at": p.created_at,
    }


def round_out(r: models.Round) -> dict:
    return {
        "n": r.n,
        "opened_at": r.opened_at,
        "closed_at": r.closed_at,
        "approval_card_id": fmt_id("C", r.approval_card_id) if r.approval_card_id else None,
        "versions_manifest": r.versions_manifest or {},
    }


def tech_order_out(o: models.TechOrder) -> dict:
    return {
        "order_id": fmt_id("O", o.id),
        "intent": o.intent,
        "scope": o.scope or [],
        "baseline": o.baseline,
        "acceptance": o.acceptance or [],
        "package_id": fmt_id("P", o.package_id),
    }
