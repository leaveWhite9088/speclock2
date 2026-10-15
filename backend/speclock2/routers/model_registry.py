"""/api/models：Harness×模型登记（全局注册表，不挂项目）。

工作台只唤醒 Harness，不替它配置模型——本表是纯信息登记：
「这个 Harness 有哪些模型」人工录入，添加主代理时 harness+model
只能从这里选（masters 创建端点据此校验）。
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from .. import models
from ..errors import ApiError
from ..utils import now_iso

router = APIRouter()

# pi 已知供应商（来源：pi docs/providers.md；chief 实际走 minimax-cn 路由）。
# 空 provider 合法（= 只作 harness 绑定，不进核心代理 /model 列表）。
KNOWN_PROVIDERS = {
    "minimax-cn", "anthropic", "openai", "google", "deepseek", "zai",
    "moonshot", "qwen", "openrouter", "xai", "groq", "mistral",
}


class RegisterModelBody(BaseModel):
    harness: str = ""
    model: str = ""
    provider: str | None = None  # LLM 供应商名（如 minimax-cn）；空 = 只作 harness 绑定


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
    if provider and provider not in KNOWN_PROVIDERS:
        raise ApiError(422, "validation_error",
                       f"provider {provider!r} 不是合法的 LLM 供应商（合法值：{', '.join(sorted(KNOWN_PROVIDERS))}；留空 = 只作 harness 绑定）")
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
