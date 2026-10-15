"""对话与核心代理会话（契约 v0.3）：chat / SSE / agent 状态与启停。

对话入库：人消息落 chat.human，核心代理完成的回复落 chat.chief（A5：对话流
是事件日志的投影之一）。SSE 事件：message_delta / message_final /
card_proposed / agent_error。
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import flow, models, pi_runtime
from ..errors import ApiError
from ..utils import now_iso
from .cards import CardCreate, create_card_service

router = APIRouter(prefix="/api/p/{slug}")


class ChatBody(BaseModel):
    message: str
    # 仅 mock 模式生效：模拟核心代理经 draft_card 工具产出的卡片内容（真实模式忽略）
    draft: dict | None = None


class AgentStartBody(BaseModel):
    model: str | None = None


def _project_or_404(request: Request, slug: str) -> None:
    with request.app.state.db.registry_session() as session:
        if session.get(models.Project, slug) is None:
            raise ApiError(404, "not_found", f"项目不存在：{slug}")


def make_create_card_fn(app) -> object:
    """mock 核心代理的 draft_card 工具效果：服务端直接建卡。"""

    async def _create(slug: str, draft: dict):
        body = CardCreate(
            statement=draft.get("statement") or {},
            rule_ops=draft.get("rule_ops") or [],
            api_ops=draft.get("api_ops") or [],
            impact=draft.get("impact") or ["backend", "frontend"],
            risk=draft.get("risk"),
        )
        return create_card_service(app.state.db, slug, body)

    return _create


def make_dispatch_fn(app) -> object:
    """mock 核心代理的 dispatch 工具效果：真实派发链（spawn harness → 遥测/回执）。"""

    async def _dispatch(slug: str, package_id: int):
        from .. import dispatcher

        return await dispatcher.run_package(app, slug, package_id)

    return _dispatch


@asynccontextmanager
async def lifespan(app):
    from .queue import rearm_watchdogs

    # 重启重建看门狗（追加项 9）：定时器是内存态，按落库 deadline 重武装/收尸
    rearm_watchdogs(app.state.db, app.state.timers, app.state.settings.ledgers_dir)
    yield
    await app.state.pi.stop_all()  # 有序关闭全部核心代理会话（会话 JSONL 已持久化）


@router.post("/chat")
async def chat(slug: str, body: ChatBody, request: Request) -> dict:
    _project_or_404(request, slug)
    if not body.message.strip():
        raise ApiError(422, "validation_error", "message 不能为空")
    if body.draft is not None and not pi_runtime.mock_enabled():
        body.draft = None  # draft 仅 mock 模式有效（真实卡片必须经 draft_card 工具）

    manager = request.app.state.pi
    session = await manager.ensure(slug)

    db = request.app.state.db
    with db.ledger_session(slug) as s:
        round_ = flow.open_round(s, 1)  # 对话是轮次内容：首轮对话即开启第 1 轮
        flow.add_event(s, round_.n, "human", "chat.human", {}, {"message": body.message})
        s.commit()

    try:
        reply = await session.prompt(body.message, body.draft)
    except ApiError:
        raise  # mock 模拟 draft_card 的校验错误按原状态码透传
    except Exception as exc:
        session.broadcast("agent_error", {"error": str(exc)})
        raise ApiError(502, "agent_error", f"核心代理回合失败：{exc}")

    with db.ledger_session(slug) as s:
        round_ = flow.get_open_round(s)
        flow.add_event(s, round_.n if round_ else 0, "chief", "chat.chief", {}, {"message": reply})
        s.commit()
    session.broadcast("message_final", {"message": reply})
    return {"ok": True, "reply": reply}


@router.get("/chat/stream")
async def chat_stream(slug: str, request: Request) -> StreamingResponse:
    _project_or_404(request, slug)
    session = await request.app.state.pi.ensure(slug)
    queue = session.subscribe()

    async def gen():
        yield "event: ready\ndata: {}\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                data = json.dumps(item["data"], ensure_ascii=False)
                yield f"event: {item['event']}\ndata: {data}\n\n"
        finally:
            session.unsubscribe(queue)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/agent")
async def agent_status(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    chief = pi_runtime.effective_chief(request.app.state.db, slug)  # 生效值（含来源 project|env）
    session = request.app.state.pi.get(slug)
    if session is None:
        return {"running": False, "model": None, "context_usage_percent": None,
                "session_id": f"speclock2-{slug}", "chief": chief}
    stats = (await session.stats()) or {}
    percent = (stats.get("contextUsage") or {}).get("percent")
    _warn_context_usage(request, slug, session, percent)
    return {"running": True, "model": session.model,
            "context_usage_percent": percent, "session_id": session.session_id,
            "chief": chief}


def _warn_context_usage(request: Request, slug: str, session, percent) -> None:
    """context_usage_percent > 80 → 落一条告警事件（会话退化信号，DESIGN §12.3）。"""
    if percent is None:
        return
    warned = getattr(session, "_warned", False)
    if percent > pi_runtime.STATS_WARN_PERCENT and not warned:
        with request.app.state.db.ledger_session(slug) as s:
            round_ = flow.get_open_round(s)
            flow.add_event(
                s, round_.n if round_ else 0, "system", "chief.context_warning",
                {"session": session.session_id},
                {"context_usage_percent": percent,
                 "hint": "核心代理上下文占用超过阈值，建议重建会话（A1：账本可重建一切）"},
            )
            s.commit()
        session._warned = True
    elif percent < 70 and warned:
        session._warned = False  # 回落后重置，允许再次告警


@router.post("/agent/start")
async def agent_start(slug: str, body: AgentStartBody, request: Request) -> dict:
    _project_or_404(request, slug)
    try:
        session = await request.app.state.pi.ensure(slug, body.model)
    except Exception as exc:
        raise ApiError(502, "agent_error", f"核心代理启动失败：{exc}")
    return {"running": True, "model": session.model, "session_id": session.session_id}


class AgentModelBody(BaseModel):
    provider: str | None = None
    model: str = ""


@router.post("/agent/model")
async def agent_set_model(slug: str, body: AgentModelBody, request: Request) -> dict:
    """切换核心代理当前会话模型（契约 v0.5）：pi RPC set_model，会话内持久。

    会话未运行 → 409（先 /agent/start）；模型名非法由 pi 报错透传 502。
    """
    _project_or_404(request, slug)
    model = (body.model or "").strip()
    if not model:
        raise ApiError(422, "validation_error", "model 不能为空")
    provider = (body.provider or "").strip()
    # model 可能带来源前缀（如登记里的 mcode 条目 "minimax/MiniMax-M3"）：
    # pi 的 modelId 不含 "/"，剥掉取最后段，供应商以 provider 参数为准
    model_id = model.rpartition("/")[2] if "/" in model else model
    target = f"{provider}/{model_id}" if provider else model_id
    session = request.app.state.pi.get(slug)
    if session is None or not session.running:
        raise ApiError(409, "conflict", "核心代理会话未运行，无法切换模型（先 POST /agent/start）")
    try:
        result = await session.set_model(target)
    except NotImplementedError:
        raise ApiError(501, "not_implemented", "当前会话类型不支持切换模型")
    except Exception as exc:
        raise ApiError(502, "agent_error",
                       f"切换模型失败：{exc}（请检查模型登记的 provider 是否为 pi 供应商名）")
    return {"ok": True, "model": result.get("model", target)}


@router.post("/agent/stop")
async def agent_stop(slug: str, request: Request) -> dict:
    _project_or_404(request, slug)
    await request.app.state.pi.stop(slug)
    return {"running": False, "model": None, "session_id": f"speclock2-{slug}"}
