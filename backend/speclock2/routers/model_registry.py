"""/api/models：Harness×模型登记（全局注册表，不挂项目）。

工作台只唤醒 Harness，不替它配置模型——本表是纯信息登记：
「这个 Harness 有哪些模型」人工录入，添加主代理时 harness+model
只能从这里选（masters 创建端点据此校验）。
"""

from __future__ import annotations

import subprocess

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import models
from ..errors import ApiError
from ..utils import now_iso

router = APIRouter()

# 登记允许的 harness（派单：收敛为三件套）；sl2-fake 是内部替身，自测链用。
# masters 绑定经登记校验，这里守住入口即可。
from ..harness_map import ALLOWED_HARNESSES  # noqa: E402

REGISTERABLE_HARNESSES = (*ALLOWED_HARNESSES, "sl2-fake")

# pi 供应商词表（来源：pi docs/providers.md；chief 切模型消费的就是 pi 条目）。
# 只约束 harness=="pi" 的登记（修复单 21 按 harness 分治）：其他 harness 有
# 自己的供应商方言（如 mcode 用 minimax），工作台只登记不翻译，原样接受。
# 空 provider 合法（= 只作 harness 绑定，不进核心代理 /model 列表）。
KNOWN_PROVIDERS = {
    "minimax-cn", "anthropic", "openai", "google", "deepseek", "zai",
    "moonshot", "qwen", "openrouter", "xai", "groq", "mistral",
}


class RegisterModelBody(BaseModel):
    harness: str = ""
    model: str = ""
    # LLM 供应商名，按 harness 各用各方言：pi 用 minimax-cn，mcode 用 minimax。
    # 词表校验仅对 pi 条目生效；非 pi 条目只要求非空、不含 "/"。
    provider: str | None = None


# 模型发现（派单）：opencode 实查命令；mcode 无列模型命令，静态兜底
# （安装包路由表，2026-10-15 实测）；pi 走登记手工维护（catalog 查询太慢，不发现）
MCODE_STATIC_MODELS = ("MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.7")
DISCOVERY_TIMEOUT_SECONDS = 5


def _discover_opencode_models() -> tuple[list[str], str]:
    """`opencode models` 实查：每行一个模型 id（含 "/"）。失败/超时 → 空 + none。"""
    from ..harness_map import resolve_opencode_command

    base = resolve_opencode_command()
    if not base:
        return [], "none"
    if isinstance(base, list):  # 测试注入的可执行列表
        argv = [*base, "models"]
    elif base.lower().endswith((".cmd", ".bat")):  # npm 垫片：spawn 须经 cmd
        argv = ["cmd", "/c", base, "models"]
    else:
        argv = [base, "models"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True,
                              timeout=DISCOVERY_TIMEOUT_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        return [], "none"
    if proc.returncode != 0:
        return [], "none"
    ids = [line.strip() for line in (proc.stdout or "").splitlines()
           if "/" in line and not line.startswith((" ", "	"))]
    return ids, ("discovered" if ids else "none")


@router.get("/api/harness-models")
def harness_models(harness: str = "") -> dict:
    """harness 可用模型发现（与前端单共用契约）：{"harness", "models", "source"}。

    source：discovered（命令实查）/ static（静态兜底）/ none（没有）。
    发现失败、超时（5 秒）、未知 harness 一律 200 + 空清单 + none，绝不 5xx。
    """
    name = (harness or "").strip()
    if name == "opencode":
        models_list, source = _discover_opencode_models()
    elif name == "mcode":
        models_list, source = list(MCODE_STATIC_MODELS), "static"
    else:
        models_list, source = [], "none"
    return {"harness": name, "models": models_list, "source": source}


def _entry_out(row: models.ModelEntry) -> dict:
    return {"id": f"mdl-{row.id}", "harness": row.harness, "model": row.model,
            "provider": row.provider or ""}


@router.get("/api/models")
def list_models(request: Request) -> dict:
    db = request.app.state.db
    with db.registry_session() as session:
        rows = session.scalars(
            select(models.ModelEntry).order_by(models.ModelEntry.id)
        ).all()
    return {"items": [_entry_out(r) for r in rows]}


@router.post("/api/models", status_code=201)
def register_model(body: RegisterModelBody, request: Request) -> dict:
    harness = (body.harness or "").strip()
    model = (body.model or "").strip()
    provider = (body.provider or "").strip()
    if not harness or not model:
        raise ApiError(422, "validation_error", "Harness 与模型都要填（Harness 有什么模型就登记什么）")
    if harness not in REGISTERABLE_HARNESSES:
        raise ApiError(422, "validation_error",
                       f"harness {harness!r} 不在支持列表（{'、'.join(ALLOWED_HARNESSES)}；claude-code/codex/kimicode 已收敛删除）")
    # provider 校验按 harness 分治（修复单 21）：词表只管 pi 条目；
    # 非 pi 条目是各自 harness 的方言（如 mcode 的 minimax），原样接受
    if provider and harness == "pi" and provider not in KNOWN_PROVIDERS:
        raise ApiError(422, "validation_error",
                       f"provider {provider!r} 不是 pi 的合法供应商（合法值：{', '.join(sorted(KNOWN_PROVIDERS))}；留空 = 只作 harness 绑定；其他 harness 用各自的供应商名，不做词表校验）")
    if provider and "/" in provider:
        raise ApiError(422, "validation_error",
                       f"provider {provider!r} 不能包含 \"/\"（来源前缀属于 model 字段，登记时拆开填）")
    db = request.app.state.db
    with db.registry_session() as session:
        exists = session.scalars(
            select(models.ModelEntry).where(
                models.ModelEntry.harness == harness, models.ModelEntry.model == model
            )
        ).first()
        if exists is not None:
            raise ApiError(409, "conflict", f"{harness} 已登记过模型 {model}")
        row = models.ModelEntry(harness=harness, model=model, provider=provider or None,
                                created_at=now_iso())
        session.add(row)
        session.commit()
        session.refresh(row)
        return _entry_out(row)


@router.delete("/api/models/{entry_id}")
def remove_model(entry_id: str, request: Request) -> dict:
    try:
        numeric = int(entry_id.removeprefix("mdl-"))
    except ValueError:
        raise ApiError(404, "not_found", f"登记 {entry_id} 不存在")
    db = request.app.state.db
    with db.registry_session() as session:
        row = session.get(models.ModelEntry, numeric)
        if row is None:
            raise ApiError(404, "not_found", f"登记 {entry_id} 不存在")
        session.delete(row)
        session.commit()
    # 前端 request() 统一按 JSON 解析响应体，204 空体会炸，返回 200 + 空对象
    return {}
