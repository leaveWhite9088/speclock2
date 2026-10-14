"""账本流程公共逻辑：事件写入、轮次开启/关闭、卡片 ops 校验预演。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models, validation, versioning
from .errors import ApiError
from .utils import now_iso


def add_event(session: Session, round_: int, actor: str, type_: str, ref: dict, payload: dict) -> models.Event:
    """追加事件（append-only）。round 语义见 DESIGN.md §7.3：批准及其原子后果属于被关闭的轮次。"""
    event = models.Event(ts=now_iso(), round=round_, actor=actor, type=type_, ref=ref, payload=payload)
    session.add(event)
    session.flush()  # 取自增 id
    return event


def get_open_round(session: Session) -> models.Round | None:
    return session.scalars(
        select(models.Round).where(models.Round.closed_at.is_(None)).order_by(models.Round.n.desc()).limit(1)
    ).first()


def open_round(session: Session, n: int) -> models.Round:
    """开启第 n 轮（不存在时）。返回当前开启轮次。"""
    current = get_open_round(session)
    if current is not None:
        return current
    round_ = models.Round(n=n, opened_at=now_iso())
    session.add(round_)
    session.flush()
    return round_


def current_round_no(session: Session) -> int:
    round_ = get_open_round(session)
    return round_.n if round_ else 0


def close_round(session: Session, round_: models.Round, card_id: int, versions_manifest: dict) -> None:
    """关闭轮次并开启下一轮（§7.3：批准属于它关闭的那一轮，批准后的活动属于新一轮）。"""
    round_.closed_at = now_iso()
    round_.approval_card_id = card_id
    round_.versions_manifest = versions_manifest
    session.add(models.Round(n=round_.n + 1, opened_at=now_iso()))


def _card_op_errors(errors: list[dict], field: str, message: str) -> None:
    errors.append({"field": field, "message": message})


def validate_card_ops(
    session: Session, rule_ops: list, api_ops: list
) -> tuple[dict[int, models.Block], list[dict]]:
    """校验卡片 ops：op 形状、block_id 存在性、modify/remove 的可匹配性、upsert 唯一性预演。

    返回 (涉及的块 {block_id: Block}，错误清单)。预演采用与 approve 相同的应用+校验路径。
    """
    errors: list[dict] = []
    blocks: dict[int, models.Block] = {}

    def load_block(raw, field: str) -> models.Block | None:
        if raw is None:
            _card_op_errors(errors, field, "缺少 block_id")
            return None
        try:
            bid = int(str(raw).strip())
        except ValueError:
            _card_op_errors(errors, field, f"block_id 不是合法 id：{raw!r}")
            return None
        if bid not in blocks:
            block = session.get(models.Block, bid)
            if block is None:
                raise ApiError(404, "not_found", f"目标块不存在：{raw!r}")
            blocks[bid] = block
        return blocks[bid]

    for i, op in enumerate(rule_ops or []):
        base = f"rule_ops[{i}]"
        if not isinstance(op, dict):
            _card_op_errors(errors, base, "op 必须是对象")
            continue
        kind = op.get("op")
        if kind not in versioning.RULE_OPS:
            _card_op_errors(errors, f"{base}.op", f"rule op 必须是 {versioning.RULE_OPS} 之一，got {kind!r}")
            continue
        block = load_block(op.get("block_id"), f"{base}.block_id")
        if block is None:
            continue
        existing_ids = {r.get("id") for r in (block.draft_rules_json or [])}
        if kind in ("modify", "remove"):
            rid = op.get("id")
            if not isinstance(rid, str) or not rid:
                _card_op_errors(errors, f"{base}.id", f"{kind} 操作必须携带规则 id")
            elif rid not in existing_ids:
                _card_op_errors(errors, f"{base}.id", f"规则 id {rid} 在目标块中不存在")
        if kind in ("add", "modify"):
            after = op.get("after")
            if not isinstance(after, dict):
                _card_op_errors(errors, f"{base}.after", f"{kind} 操作必须携带 after")
            else:
                for key in ("name", "detail"):
                    v = after.get(key)
                    if not isinstance(v, str) or not v.strip():
                        _card_op_errors(errors, f"{base}.after.{key}", f"after.{key} 不能为空")

    for i, op in enumerate(api_ops or []):
        base = f"api_ops[{i}]"
        if not isinstance(op, dict):
            _card_op_errors(errors, base, "op 必须是对象")
            continue
        kind = op.get("op")
        if kind not in versioning.API_OPS:
            _card_op_errors(errors, f"{base}.op", f"api op 必须是 {versioning.API_OPS} 之一，got {kind!r}")
            continue
        block = load_block(op.get("block_id"), f"{base}.block_id")
        if block is None:
            continue
        key = op.get("key")
        if not isinstance(key, str):
            _card_op_errors(errors, f"{base}.key", "key 必须是形如 'GET /api/x' 的字符串")
            continue
        if validation.parse_api_name(key, f"{base}.key", errors) is None:
            continue
        existing_keys = {str(a.get("api", "")).strip() for a in (block.draft_apis_json or [])}
        if kind == "remove" and key.strip() not in existing_keys:
            _card_op_errors(errors, f"{base}.key", f"API {key!r} 在目标块中不存在，无法删除")
        if kind == "upsert":
            entry = op.get("entry")
            if not isinstance(entry, dict):
                _card_op_errors(errors, f"{base}.entry", "upsert 操作必须携带 entry")
                continue
            # 单条 entry 校验：把定位映射回 api_ops[i].entry
            try:
                validation.validate_apis([entry])
            except validation.DraftValidationError as exc:
                for e in exc.errors:
                    _card_op_errors(
                        errors,
                        e["field"].replace("apis[0]", f"{base}.entry", 1),
                        e["message"],
                    )

    # 预演：应用 ops 后整体校验（含 method+path 唯一性、规则完整性）
    if not errors:
        for bid, block in blocks.items():
            r_ops = [op for op in (rule_ops or []) if isinstance(op, dict) and str(op.get("block_id", "")).strip() == str(bid)]
            a_ops = [op for op in (api_ops or []) if isinstance(op, dict) and str(op.get("block_id", "")).strip() == str(bid)]
            try:
                new_rules, _ = validation.validate_rules(
                    versioning.apply_rule_ops(block.draft_rules_json or [], r_ops),
                    block.draft_rules_json or [],
                    block.rule_seq or 0,
                )
                validation.validate_apis(versioning.apply_api_ops(block.draft_apis_json or [], a_ops))
            except validation.DraftValidationError as exc:
                errors.extend(exc.errors)
    return blocks, errors
