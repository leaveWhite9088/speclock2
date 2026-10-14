"""卡片：起草（校验 ops + 落 draft.proposed 事件）、批准（快照/轮次/任务包）、打回。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import flow, models, serialize, validation, versioning
from ..errors import ApiError
from ..utils import fmt_id, now_iso

router = APIRouter(prefix="/api/p/{slug}")


class CardCreate(BaseModel):
    statement: dict
    rule_ops: list = []
    api_ops: list = []
    impact: list = ["backend", "frontend"]
    risk: dict | None = None


class RejectBody(BaseModel):
    reason: str | None = None


def _card_or_404(session, card_id: str) -> models.ApprovalCard:
    from ..utils import parse_prefixed_id

    card = session.get(models.ApprovalCard, parse_prefixed_id(card_id, "C"))
    if card is None:
        raise ApiError(404, "not_found", f"卡片不存在：{card_id}")
    return card


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


@router.post("/cards", status_code=201)
def create_card(slug: str, body: CardCreate, request: Request) -> dict:
    _project_or_404(request, slug)
    errors: list[dict] = []
    stmt = body.statement or {}
    for key in ("说明", "动机"):
        v = stmt.get(key) if isinstance(stmt, dict) else None
        if not isinstance(v, str) or not v.strip():
            errors.append({"field": f"statement.{key}", "message": f"statement.{key} 不能为空"})
    if errors:
        raise ApiError(422, "validation_error", "卡片校验失败", details={"errors": errors})

    db = request.app.state.db
    with db.ledger_session(slug) as session:
        _, op_errors = flow.validate_card_ops(session, body.rule_ops, body.api_ops)
        if op_errors:
            raise ApiError(422, "validation_error", "卡片校验失败", details={"errors": op_errors})

        round_ = flow.open_round(session, 1)  # 首张卡片开启第 1 轮（§7.3：轮次从活动开始）
        breaking_count = sum(
            1 for op in body.api_ops
            if isinstance(op, dict) and (op.get("op") == "remove" or op.get("breaking") is True)
        )
        card = models.ApprovalCard(
            round=round_.n,
            status="pending",
            statement={"说明": stmt["说明"].strip(), "动机": stmt["动机"].strip()},
            rule_ops=body.rule_ops,
            api_ops=body.api_ops,
            impact=body.impact,
            task_preview=[{"master": m} for m in body.impact],
            risk=body.risk,
            created_at=now_iso(),
        )
        session.add(card)
        session.flush()
        flow.add_event(
            session,
            round_=round_.n,
            actor="human",  # M1 人工模拟主主代理起草
            type_="draft.proposed",
            ref={"card": fmt_id("C", card.id)},
            payload={"card": serialize.card_out(card)},
        )
        session.commit()
        session.refresh(card)
        data = serialize.card_out(card)
    return data


@router.get("/cards")
def list_cards(slug: str, request: Request, status: str | None = Query(default=None)) -> dict:
    _project_or_404(request, slug)
    db = request.app.state.db
    with db.ledger_session(slug) as session:
        stmt = select(models.ApprovalCard).order_by(models.ApprovalCard.id)
        if status is not None:
            stmt = stmt.where(models.ApprovalCard.status == status)
        cards = session.scalars(stmt).all()
        data = [serialize.card_out(c) for c in cards]
    return {"items": data}


@router.post("/cards/{card_id}/approve")
def approve_card(slug: str, card_id: str, request: Request) -> dict:
    _project_or_404(request, slug)
    db = request.app.state.db
    with db.ledger_session(slug) as session:
        card = _card_or_404(session, card_id)
        if card.status != "pending":
            raise ApiError(409, "conflict", f"卡片状态为 {card.status}，只有 pending 可批准")

        # 批准时重新校验（防御：提交后草稿可能已变）
        blocks, op_errors = flow.validate_card_ops(session, card.rule_ops or [], card.api_ops or [])
        if op_errors:
            raise ApiError(422, "validation_error", "卡片 ops 与当前草稿不匹配（基底已变化）", details={"errors": op_errors})

        round_ = flow.get_open_round(session)
        if round_ is None:
            raise ApiError(409, "conflict", "无开启中的轮次")

        # ---- 应用 ops → 生成不可变快照（DESIGN.md §6.1/6.3） ----
        rule_ops = card.rule_ops or []
        api_ops = card.api_ops or []
        versions_manifest: dict[str, str] = {}
        published: list[dict] = []
        for bid_str, block in blocks.items():
            r_ops = [o for o in rule_ops if str(o.get("block_id", "")).strip() == str(bid_str)]
            a_ops = [o for o in api_ops if str(o.get("block_id", "")).strip() == str(bid_str)]
            new_rules, new_seq = validation.validate_rules(
                versioning.apply_rule_ops(block.draft_rules_json or [], r_ops),
                block.draft_rules_json or [],
                block.rule_seq or 0,
            )
            new_apis = validation.validate_apis(versioning.apply_api_ops(block.draft_apis_json or [], a_ops))

            last = session.scalars(
                select(models.BlockVersion)
                .where(models.BlockVersion.block_id == block.id)
                .order_by(models.BlockVersion.id.desc())
                .limit(1)
            ).first()
            old_apis = last.apis_json if last else []
            old_rules = last.rules_json if last else []
            a_delta = versioning.apis_delta(old_apis, new_apis)
            r_delta = versioning.rules_delta(old_rules, new_rules)
            version, level, breaking = versioning.next_version(
                block.current_published_version, a_delta, r_delta
            )
            summary = versioning.make_delta_summary(a_delta, r_delta, breaking)

            block.draft_rules_json = new_rules
            block.rule_seq = new_seq
            block.draft_apis_json = new_apis
            block.status = "published"
            block.current_published_version = version
            session.add(models.BlockVersion(
                block_id=block.id,
                version=version,
                round=round_.n,
                statement=card.statement,
                content_md=block.draft_content_md,
                rules_json=new_rules,
                apis_json=new_apis,
                nfr_md=block.draft_nfr_md,
                delta_json={"apis": a_delta, "rules": r_delta, "summary": summary},
                published_by="human",
                published_at=now_iso(),
            ))
            versions_manifest[str(block.id)] = version
            published.append({"block_id": str(block.id), "version": version, "breaking": breaking})

        # ---- 轮次推进：批准属于它关闭的那一轮（§7.3） ----
        flow.close_round(session, round_, card.id, versions_manifest)

        # ---- 事件链：批准 + 版本 + 任务包（同一轮，批准的原子后果） ----
        decision = {"result": "approved", "at": now_iso()}
        flow.add_event(session, round_.n, "human", "approval.granted",
                       {"card": fmt_id("C", card.id)}, {"decision": decision})
        for p in published:
            flow.add_event(session, round_.n, "system", "version.published",
                           {"block": p["block_id"], "version": p["version"]},
                           {"statement": card.statement})
        package = models.TaskPackage(
            origin="approval", round=round_.n, version_refs=versions_manifest, created_at=now_iso()
        )
        session.add(package)
        session.flush()
        for master in card.impact or []:
            session.add(models.Task(package_id=package.id, master=master, status="queued",
                                    created_at=now_iso(), updated_at=now_iso()))
        flow.add_event(session, round_.n, "system", "package.created",
                       {"package": fmt_id("P", package.id)},
                       {"origin": "approval", "round": round_.n, "version_refs": versions_manifest,
                        "masters": list(card.impact or [])})

        card.status = "approved"
        card.decision = decision
        session.commit()
        response = {
            "versions": published,
            "closed_round": round_.n,
            "package_id": fmt_id("P", package.id),
        }
    return response


@router.post("/cards/{card_id}/reject")
def reject_card(slug: str, card_id: str, body: RejectBody, request: Request) -> dict:
    _project_or_404(request, slug)
    db = request.app.state.db
    with db.ledger_session(slug) as session:
        card = _card_or_404(session, card_id)
        if card.status != "pending":
            raise ApiError(409, "conflict", f"卡片状态为 {card.status}，只有 pending 可打回")
        round_ = flow.get_open_round(session)
        n = round_.n if round_ else card.round
        decision = {"result": "rejected", "reason": body.reason, "at": now_iso()}
        flow.add_event(session, n, "human", "approval.rejected",
                       {"card": fmt_id("C", card.id)}, {"decision": decision})
        card.status = "rejected"
        card.decision = decision
        session.commit()
        data = serialize.card_out(card)
    return data
