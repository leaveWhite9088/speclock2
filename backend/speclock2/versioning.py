"""版本判定与卡片 ops 应用（v1 diffing 思路：flatten / delta / is_breaking / semver）。

- flatten/delta：契约字段级 diff，文案（name/desc/description）不参与——文案变更不算契约变更；
- is_breaking：modified 非空、删 API、删必填字段 → 破坏性（v1 同款）；
- next_version：首版 1.0.0；破坏性 → MAJOR；有新增（契约或规则）→ MINOR；其余 PATCH；
- apply_rule_ops / apply_api_ops：把卡片 ops 应用到草稿清单（未校验，调用方随后走 validation）。
"""

from __future__ import annotations

RULE_OPS = ("add", "modify", "remove")
API_OPS = ("upsert", "remove")


# ---------- 字段级 flatten / delta（v1 思路） ----------


def _flatten_fields(flat: dict[str, str], key: str, prefix: str, fields: list[dict]) -> None:
    for f in fields:
        path = f"{prefix}{f['name']}"
        flat[f"{key}:{path}"] = f"{f['type']}{' required' if f.get('required') else ''}"
        if f.get("children"):
            _flatten_fields(flat, key, path + ".", f["children"])


def flatten_apis(apis: list) -> dict[str, str]:
    """递归展平为 {点路径: 描述}；name/desc/description 刻意排除（不算契约变更）。"""
    flat: dict[str, str] = {}
    for entry in apis or []:
        key = str(entry.get("api", "")).strip()
        flat[f"api:{key}"] = "operation"
        for kind in ("request", "response"):
            _flatten_fields(flat, f"{kind}:{key}", "", entry.get(kind) or [])
    return flat


def apis_delta(old_apis: list, new_apis: list) -> dict[str, list[str]]:
    old, new = flatten_apis(old_apis), flatten_apis(new_apis)
    return {
        "added": sorted(new.keys() - old.keys()),
        "modified": sorted(
            f"{k}: {old[k]} -> {new[k]}" for k in old.keys() & new.keys() if old[k] != new[k]
        ),
        "removed": sorted(old.keys() - new.keys()),
    }


def rules_delta(old_rules: list, new_rules: list) -> dict[str, list[str]]:
    """规则按稳定 id 对比：name/detail 变了算 modified。规则变化不算破坏性（v1 同款）。"""
    old = {r["id"]: r for r in old_rules or [] if r.get("id")}
    new = {r["id"]: r for r in new_rules or [] if r.get("id")}
    return {
        "added": sorted(new.keys() - old.keys()),
        "modified": sorted(
            rid for rid in old.keys() & new.keys() if old[rid] != new[rid]
        ),
        "removed": sorted(old.keys() - new.keys()),
    }


def is_breaking(d: dict[str, list[str]]) -> bool:
    if d["modified"]:
        return True
    for entry in d["removed"]:
        if entry.startswith("api:"):
            return True
        if entry.rstrip().endswith("required"):
            return True
    return False


def _bump(version: str, level: str) -> str:
    major, minor, patch = (int(p) for p in version.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def next_version(
    current: str | None, a_delta: dict[str, list[str]], r_delta: dict[str, list[str]]
) -> tuple[str, str, bool]:
    """返回 (版本号, 级别, 是否破坏性)。版本号永不复用：始终基于上一版递增。"""
    if current is None:
        return "1.0.0", "initial", False
    breaking = is_breaking(a_delta)
    if breaking:
        return _bump(current, "major"), "major", True
    if a_delta["added"] or r_delta["added"]:
        return _bump(current, "minor"), "minor", False
    return _bump(current, "patch"), "patch", False


def make_delta_summary(a_delta: dict, r_delta: dict, breaking: bool) -> str:
    """卡片/版本上的中文摘要，如「契约 1改1增(1破坏)；规则 2改」。"""
    parts = []
    a = f"契约 {len(a_delta['modified'])}改{len(a_delta['added'])}增{len(a_delta['removed'])}删"
    if breaking:
        a += "（破坏性）"
    parts.append(a)
    if any(r_delta[k] for k in ("added", "modified", "removed")):
        parts.append(f"规则 {len(r_delta['modified'])}改{len(r_delta['added'])}增{len(r_delta['removed'])}删")
    return "；".join(parts)


# ---------- 卡片 ops 应用器 ----------


def apply_rule_ops(rules: list[dict], ops: list[dict]) -> list[dict]:
    """应用 rule_ops：add 追加（不带 id，批准时由 validate_rules 分配稳定 id）；
    modify 按 id 更新 name/detail；remove 按 id 删除。"""
    result = [dict(r) for r in rules or []]
    for op in ops or []:
        kind = op.get("op")
        rid = op.get("id")
        if kind == "add":
            after = op.get("after") or {}
            result.append({"name": after.get("name", ""), "detail": after.get("detail", "")})
        elif kind == "modify":
            after = op.get("after") or {}
            for r in result:
                if r.get("id") == rid:
                    r.update({k: v for k, v in after.items() if k in ("name", "detail")})
                    break
        elif kind == "remove":
            result = [r for r in result if r.get("id") != rid]
    return result


def apply_api_ops(apis: list[dict], ops: list[dict]) -> list[dict]:
    """应用 api_ops：upsert 按 method+path 替换或追加；remove 按 key 删除。"""
    result = [dict(a) for a in apis or []]
    for op in ops or []:
        kind = op.get("op")
        key = str(op.get("key") or "").strip()
        if kind == "upsert":
            entry = dict(op.get("entry") or {})
            entry["api"] = key
            for i, a in enumerate(result):
                if str(a.get("api", "")).strip() == key:
                    result[i] = entry
                    break
            else:
                result.append(entry)
        elif kind == "remove":
            result = [a for a in result if str(a.get("api", "")).strip() != key]
    return result
