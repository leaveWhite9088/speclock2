"""草稿校验与规则稳定 id 分配（DESIGN.md §5.3/5.4，校验思想沿用 v1 diffing.py）。

- rules：{id?, name, detail}；name/detail 非空；无 id 条目由服务端分配
  稳定 id（"R" + block 级单调计数器，永不复用）；带 id 条目必须匹配当前
  草稿中的既有规则（已删除的 id 不可再使用）；
- apis：ApiEntry（api 形如 "METHOD /path"、desc 非空）+ ApiField 递归校验
  （name 非空、type 受限、children 仅允许挂在 object/array 下）；
  模块内 method+path 唯一；
- 全部错误收集为 [{"field", "message"}] 一次返回（v1"逐条缺失清单"），
  校验通过前不落库（事务性由调用方保证：先校验后赋值）。
"""

from __future__ import annotations

import re

FIELD_TYPES = ("string", "number", "integer", "boolean", "array", "object")
CONTAINER_TYPES = ("object", "array")
HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

RULE_ID_RE = re.compile(r"^R(\d+)$")


class DraftValidationError(Exception):
    """携带逐条错误清单（[{"field": "...", "message": "..."}]）的校验异常。"""

    def __init__(self, errors: list[dict]) -> None:
        super().__init__("草稿校验失败")
        self.errors = errors


def _err(errors: list[dict], field: str, message: str) -> None:
    errors.append({"field": field, "message": message})


# ---------- 规则：校验 + 稳定 id 分配 ----------


def validate_rules(
    rules: list, existing_rules: list[dict], seq: int
) -> tuple[list[dict], int]:
    """校验并归一化规则清单，返回 (新规则列表, 新计数器)。

    existing_rules：当前草稿中的规则（带已分配 id）；seq：block 级已分配
    计数器（历史最大，删除不回退）。带 id 条目须匹配 existing_rules 中的 id。
    """
    errors: list[dict] = []
    normalized: list[dict] = []
    existing = {r["id"]: r for r in existing_rules if isinstance(r, dict) and r.get("id")}
    seen_ids: set[str] = set()

    for i, entry in enumerate(rules):
        base = f"rules[{i}]"
        if not isinstance(entry, dict):
            _err(errors, base, "规则必须是对象")
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            _err(errors, f"{base}.name", "规则名 name 不能为空")
        detail = entry.get("detail")
        if not isinstance(detail, str) or not detail.strip():
            _err(errors, f"{base}.detail", "规则详述 detail 不能为空")

        rid = entry.get("id")
        if rid is None:
            seq += 1  # 新增：分配下一个稳定 id，永不复用
            rid = f"R{seq}"
        else:
            if not isinstance(rid, str) or not RULE_ID_RE.match(rid):
                _err(errors, f"{base}.id", f"规则 id 必须形如 R<数字>，got {rid!r}")
                continue
            if rid not in existing:
                _err(
                    errors,
                    f"{base}.id",
                    f"规则 id {rid} 在本模块不存在（或已删除，id 不复用）",
                )
                continue
            if rid in seen_ids:
                _err(errors, f"{base}.id", f"规则 id {rid} 在本次提交中重复")
                continue
            seen_ids.add(rid)
        normalized.append({"id": rid, "name": (name or "").strip(), "detail": (detail or "").strip()})

    if errors:
        raise DraftValidationError(errors)
    return normalized, seq


# ---------- 契约：ApiEntry / ApiField 递归校验 ----------


def parse_api_name(api: object, field: str, errors: list[dict]) -> tuple[str, str] | None:
    """'GET /api/x' -> ('GET', '/api/x')；非法时记录错误并返回 None。"""
    if not isinstance(api, str):
        _err(errors, field, f"api 必须是形如 'GET /api/x' 的字符串，got {api!r}")
        return None
    parts = api.strip().split(None, 1)
    if len(parts) != 2:
        _err(errors, field, f"api 必须形如 '方法 路径'，got {api!r}")
        return None
    method, path = parts[0], parts[1].strip()
    if method not in HTTP_METHODS:
        if method.upper() in HTTP_METHODS:
            _err(errors, field, f"HTTP 方法必须大写：{method!r} 应为 {method.upper()!r}")
        else:
            _err(errors, field, f"HTTP 方法必须大写且属于 {HTTP_METHODS}，got {method!r}")
        return None
    if not path.startswith("/"):
        _err(errors, field, f"路径必须以 / 开头，got {path!r}")
        return None
    return method, path


def _validate_field(field: object, path: str, errors: list[dict]) -> None:
    if not isinstance(field, dict):
        _err(errors, path, "字段行必须是对象")
        return
    name = field.get("name")
    name_ok = isinstance(name, str) and bool(name.strip())
    if not name_ok:
        _err(errors, f"{path}.name", "字段名 name 不能为空")
    ftype = field.get("type")
    if ftype not in FIELD_TYPES:
        _err(errors, f"{path}.type", f"字段类型必须是 {FIELD_TYPES} 之一，got {ftype!r}")
        return
    children = field.get("children")
    if children is None:
        children = []
    if not isinstance(children, list):
        _err(errors, f"{path}.children", "children 必须是数组")
        return
    # 空 children 视为无 children（往返会带空数组，不报错）；标量带非空 children 才拒绝（v1 同款）
    if children and ftype not in CONTAINER_TYPES:
        _err(
            errors,
            f"{path}.children",
            f"字段 {name!r} 是 {ftype} 类型，不允许有 children（仅 object/array 可挂载）",
        )
        return
    required = field.get("required", False)
    if not isinstance(required, bool):
        _err(errors, f"{path}.required", f"required 必须是布尔，got {required!r}")
    for j, child in enumerate(children):
        _validate_field(child, f"{path}.children[{j}]", errors)


def validate_apis(apis: list) -> list[dict]:
    """校验并归一化 API 契约清单（写入口径：desc 必填）。"""
    errors: list[dict] = []
    normalized: list[dict] = []
    seen_keys: dict[tuple[str, str], str] = {}  # (method, path) -> 定位

    for i, entry in enumerate(apis):
        base = f"apis[{i}]"
        if not isinstance(entry, dict):
            _err(errors, base, "API 条目必须是对象")
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            _err(errors, f"{base}.name", "API 名称 name 不能为空")
        desc = entry.get("desc")
        if not isinstance(desc, str) or not desc.strip():
            _err(errors, f"{base}.desc", "端点语义 desc 不能为空（谁调用、做什么）")

        parsed = parse_api_name(entry.get("api"), f"{base}.api", errors)
        if parsed is not None:
            key = (parsed[0], parsed[1])
            if key in seen_keys:
                _err(
                    errors,
                    f"{base}.api",
                    f"方法+路径 {key[0]} {key[1]} 与 {seen_keys[key]} 重复（模块内必须唯一）",
                )
            else:
                seen_keys[key] = base

        for kind in ("request", "response"):
            fields = entry.get(kind)
            if fields is None:
                fields = []
            if not isinstance(fields, list):
                _err(errors, f"{base}.{kind}", f"{kind} 必须是数组")
                continue
            for j, f in enumerate(fields):
                _validate_field(f, f"{base}.{kind}[{j}]", errors)

        normalized.append(
            {
                "name": (name or "").strip(),
                "api": f"{parsed[0]} {parsed[1]}" if parsed else str(entry.get("api", "")),
                "desc": (desc or "").strip(),
                "request": entry.get("request") or [],
                "response": entry.get("response") or [],
            }
        )

    if errors:
        raise DraftValidationError(errors)
    return normalized
