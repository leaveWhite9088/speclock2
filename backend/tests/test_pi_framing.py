"""pi_runtime 分帧与会话测试：U+2028/U+2029 陷阱、假 pi 子进程全回合、mock 会话。"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from speclock2.pi_runtime import (
    MockSession,
    PiSession,
    parse_record,
    resolve_pi_command,
    split_records,
)

FAKE_PI = Path(__file__).parent / "fake_pi.py"


def test_split_records_keeps_u2028_inside_string():
    """U+2028/U+2029 是 JSON 字符串合法内容，分帧只认 LF。"""
    payload = '{"a":"xy","b":"uv"}\n{"ok":1}\n'
    raw = payload.encode("utf-8")
    lines, rest = split_records(raw)
    assert rest == b""
    assert len(lines) == 2
    first = parse_record(lines[0])
    assert first == {"a": "xy", "b": "uv"}  # 分隔符完整保留在字符串内，未断帧
    assert parse_record(lines[1]) == {"ok": 1}


def test_split_records_partial_buffer():
    data = b'{"a":1}\n{"b":2'
    lines, rest = split_records(data)
    assert lines == [b'{"a":1}']
    assert rest == b'{"b":2'
    lines2, rest2 = split_records(rest + b'}\n')
    assert lines2 == [b'{"b":2}']
    assert rest2 == b""


def test_split_records_crlf_tolerated():
    lines, _ = split_records(b'{"a":1}\r\n{"b":2}\r\n')
    assert lines == [b'{"a":1}', b'{"b":2}']


def test_parse_record_ignores_garbage():
    assert parse_record(b"not-json") is None
    assert parse_record(b"   ") is None


def test_resolve_pi_command_finds_pi():
    cmd = resolve_pi_command()
    assert cmd is not None and len(cmd) >= 1


def test_fake_pi_full_round():
    """假 pi 子进程全链路：prompt 回合（含 U+2028 事件不炸）、delta 广播、stats、stop。"""
    from speclock2.config import Settings

    async def run() -> tuple[str, list[dict], dict, dict]:
        settings = Settings()
        session = PiSession("t", settings, pi_cmd=[sys.executable, str(FAKE_PI)])
        queue = session.subscribe()
        await session.start()
        try:
            reply = await session.prompt("你好")
            deltas = []
            while not queue.empty():
                item = queue.get_nowait()
                if item["event"] == "message_delta":
                    deltas.append(item["data"]["delta"])
            stats = (await session.stats()) or {}
            state = {"running": session.running, "model": session.model}
            return reply, deltas, stats, state
        finally:
            await session.stop()

    reply, deltas, stats, state = asyncio.run(run())
    assert reply == "最终回复：行内分隔已处理"  # message_end 的 authoritative 文本
    assert any("你好" in d for d in deltas)  # text_delta 经 SSE 通道广播
    assert stats["contextUsage"]["percent"] == 85
    assert state["running"] is True
    assert state["model"]  # 模型标识非空


def test_mock_session_streams_and_card():
    """mock 核心代理：分段流式广播 + 模拟 draft_card 建卡。"""
    created = []

    async def fake_create(slug, draft):
        card = {"card_id": "C-0001", "round": 1, "statement": draft["statement"]}
        created.append((slug, draft))
        return card

    async def run():
        session = MockSession("a", fake_create)
        queue = session.subscribe()
        reply = await session.prompt("请起草", draft={
            "statement": {"说明": "导出支持 Excel", "动机": "财务需要"},
            "rule_ops": [], "api_ops": [],
        })
        events = []
        while not queue.empty():
            events.append(queue.get_nowait())
        return reply, events

    reply, events = asyncio.run(run())
    assert created[0][0] == "a"
    kinds = [e["event"] for e in events]
    assert "card_proposed" in kinds
    assert "message_delta" in kinds
    assert "C-0001" in reply
    assert "导出支持 Excel" in reply
