"""任务落定通知（慢工单）：chief 没有同步跟单时，把结果送回对话流。

后台派发与看门狗收尸都不经过 chief 的工具回合——没有这条腿，chief 对
master 的结果一无所知（会误判「通道不可用」、会编造任务号）。通知是
尽力而为：chief 会话没在跑就跳过（不主动唤醒），回合失败静默放弃。

实现：threading.Queue + 轮询 worker。入队方有看门狗定时器线程（无事件
循环），用 asyncio.Queue 会绑错 loop；轮询 0.5s 的延迟对通知无感。
"""

from __future__ import annotations

import asyncio
import queue as queue_mod

NOTIFY_TURN_TIMEOUT = 120  # 通知回合上限（秒）：chief 只需转述，不做重活
POLL_SECONDS = 0.5


def enqueue(app, slug: str, text: str) -> None:
    """线程安全入队；队列未就绪（停机中）则放弃。"""
    q = getattr(app.state, "chief_notify", None)
    if q is None:
        return
    try:
        q.put_nowait((slug, text))
    except Exception:
        pass


async def worker(app) -> None:
    """轮询消费通知：给运行中的 chief 会话发一个转述回合。"""
    q: queue_mod.Queue = app.state.chief_notify
    while True:
        await asyncio.sleep(POLL_SECONDS)
        while True:
            try:
                slug, text = q.get_nowait()
            except queue_mod.Empty:
                break
            try:
                session = app.state.pi.get(slug)
                if session is None or not session.running:
                    continue  # chief 未运行：不唤醒、不通知（账本仍是事实源）
                await asyncio.wait_for(session.prompt(text), timeout=NOTIFY_TURN_TIMEOUT)
            except asyncio.CancelledError:
                raise
            except Exception:
                continue  # 通知尽力而为，不影响派发主链
