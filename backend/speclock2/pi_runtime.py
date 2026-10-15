"""pi RPC 适配层（DESIGN.md §13、PI-ASSESSMENT）。

- 严格 LF 二进制分帧：只在 b"\\n" 上切分再 decode（禁 str.splitlines——
  U+2028/U+2029 在 JSON 字符串里合法，readline/splitlines 会错误断帧）；
- 回合完成判据 = agent_settled；text_delta 转发 SSE；
- get_session_stats 的 contextUsage.percent 超 80 落告警事件（§12.3）；
- SPECLOCK2_CHIEF_MOCK=1 时走 MockSession：本地模拟核心代理（含 draft_card
  工具效果），保证无 provider key 也能全流程自测。
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

from .config import Settings

PROMPT_TIMEOUT = 600  # 单回合兜底超时（秒）：真模型多轮工具调用（含派发等待）耗时较长
STATS_WARN_PERCENT = 80


# ---------- 分帧（纯函数，可单测） ----------


def split_records(buffer: bytes) -> tuple[list[bytes], bytes]:
    """按 LF 切分已缓冲的字节，返回 (完整行列表, 剩余不完整缓冲)。CRLF 容忍。"""
    lines = buffer.split(b"\n")
    rest = lines.pop()  # 最后一段可能不完整，留在缓冲
    return [line.rstrip(b"\r") for line in lines], rest


def parse_record(line: bytes) -> dict | None:
    if not line.strip():
        return None
    try:
        return json.loads(line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None  # 协议外输出（如诊断行）直接忽略，不炸读循环


# ---------- pi 命令行解析 ----------


def resolve_pi_command() -> list[str] | None:
    """解析 pi 启动命令：优先 node + cli.js（Windows 无 .cmd 问题），兜底 pi.cmd。"""
    override = os.environ.get("SPECLOCK2_PI_CMD")
    if override:
        return override.split()
    try:
        npm = shutil.which("npm")  # Windows 下 subprocess 不解析 .cmd，须经 which 拿全名
        if npm:
            root = subprocess.run(
                [npm, "root", "-g"], capture_output=True, text=True, timeout=30
            ).stdout.strip()
            pkg_dir = Path(root) / "@earendil-works" / "pi-coding-agent"
            pkg = pkg_dir / "package.json"
            if pkg.exists():
                bin_js = pkg_dir / json.loads(pkg.read_text(encoding="utf-8"))["bin"]["pi"]
                node = shutil.which("node")
                if node and bin_js.exists():
                    return [node, str(bin_js)]
    except Exception:
        pass
    which = shutil.which("pi")
    if not which:
        return None
    if which.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", which]  # .cmd 只能经 cmd /c 执行
    return [which]


def chief_model_args() -> list[str]:
    provider = os.environ.get("SPECLOCK2_CHIEF_PROVIDER", "")
    model = os.environ.get("SPECLOCK2_CHIEF_MODEL", "")
    if provider and model:
        return ["--model", f"{provider}/{model}"]
    if model:
        return ["--model", model]
    return []


def effective_chief(db, slug: str) -> dict:
    """项目核心代理生效配置（契约 v0.4）：项目字段优先，空回退全局 env。

    返回 {"provider", "model", "source"}；source = project（项目提供了任一字段）
    或 env（完全跟随全局）。
    """
    proj_provider = proj_model = ""
    try:
        from . import models

        with db.registry_session() as session:
            project = session.get(models.Project, slug)
        if project is not None:
            proj_provider = (project.chief_provider or "").strip()
            proj_model = (project.chief_model or "").strip()
    except Exception:
        pass  # db 不可用时按纯 env 处理（会话仍可启动）
    env_provider = os.environ.get("SPECLOCK2_CHIEF_PROVIDER", "")
    env_model = os.environ.get("SPECLOCK2_CHIEF_MODEL", "")
    if proj_provider or proj_model:
        return {"provider": proj_provider or env_provider or None,
                "model": proj_model or env_model or None, "source": "project"}
    return {"provider": env_provider or None, "model": env_model or None, "source": "env"}


def effective_chief_model_str(db, slug: str) -> str | None:
    """生效模型字符串（pi --model 形态：provider/model 或 model）；未配置返回 None。"""
    chief = effective_chief(db, slug)
    provider, model = chief["provider"] or "", chief["model"] or ""
    if provider and model:
        return f"{provider}/{model}"
    return model or None


# ---------- 会话基类 ----------


class BaseSession:
    """统一接口：prompt / SSE 订阅 / stats / stop。"""

    session_id: str = ""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    def broadcast(self, event: str, data: dict) -> None:
        for q in self._subscribers:
            try:
                q.put_nowait({"event": event, "data": data})
            except asyncio.QueueFull:
                pass  # 慢消费者丢弃，不阻塞会话

    @property
    def running(self) -> bool:
        return True

    @property
    def model(self) -> str:
        raise NotImplementedError

    async def prompt(self, message: str, draft: dict | None = None) -> str:
        raise NotImplementedError

    async def stats(self) -> dict | None:
        return None

    async def stop(self) -> None:
        return None


# ---------- 真实 pi 会话（RPC 子进程） ----------


class PiSession(BaseSession):
    def __init__(self, slug: str, settings: Settings, model_args: list[str] | None = None,
                 pi_cmd: list[str] | None = None) -> None:
        super().__init__()
        self.slug = slug
        self.session_id = f"speclock2-{slug}"
        self.settings = settings
        self.proc: asyncio.subprocess.Process | None = None
        self._next_id = 0
        self._pending: dict[str, asyncio.Future] = {}
        self._lock = asyncio.Lock()  # 回合串行
        self._settled: asyncio.Event | None = None
        self._turn_deltas: list[str] = []
        self._final_text: str | None = None
        self.last_stats: dict | None = None
        self._warned = False
        self._repo_root = Path(__file__).resolve().parent.parent.parent  # speclock2/../.. = 仓库根
        self._cmd = pi_cmd or (resolve_pi_command() or [])
        self._model_args = model_args if model_args is not None else chief_model_args()

    def _full_command(self) -> list[str]:
        session_dir = self.settings.data_dir / "pi-sessions"
        session_dir.mkdir(parents=True, exist_ok=True)
        return self._cmd + [
            "--mode", "rpc",
            "--session-id", self.session_id,
            "--session-dir", str(session_dir),
            "-e", str(self._repo_root / "chief" / "extension" / "index.ts"),
            "--append-system-prompt", str(self._repo_root / "chief" / "constitution.md"),
            *self._model_args,
        ]

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    @property
    def model(self) -> str:
        """生效模型展示值：优先显式 --model 参数，否则 env 兜底显示。"""
        if len(self._model_args) >= 2 and self._model_args[0] == "--model":
            return self._model_args[1]
        m = os.environ.get("SPECLOCK2_CHIEF_MODEL", "")
        p = os.environ.get("SPECLOCK2_CHIEF_PROVIDER", "")
        return f"{p}/{m}" if p and m else (m or "pi-default")

    async def start(self) -> None:
        if self.running:
            return
        if not self._cmd:
            raise RuntimeError("未找到 pi 可执行文件（npm i -g @earendil-works/pi-coding-agent）")
        self.proc = await asyncio.create_subprocess_exec(
            *self._full_command(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "SPECLOCK2_SLUG": self.slug,
                 "SPECLOCK2_REPO_ROOT": str(self._repo_root)},
        )
        asyncio.create_task(self._read_stdout())
        asyncio.create_task(self._drain_stderr())

    async def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        buffer = b""
        while True:
            chunk = await self.proc.stdout.read(4096)  # 持续读：防 pi 背压阻塞
            if not chunk:
                break
            buffer += chunk
            lines, buffer = split_records(buffer)
            for line in lines:
                self._dispatch(parse_record(line))
        if self._settled:  # 进程意外退出：解除等待方
            self._settled.set()

    async def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while True:
            chunk = await self.proc.stderr.read(4096)
            if not chunk:
                break

    def _dispatch(self, record: dict | None) -> None:
        if record is None:
            return
        rtype = record.get("type")
        rid = record.get("id")
        if rtype == "response" and rid in self._pending and not self._pending[rid].done():
            self._pending[rid].set_result(record)
            return
        if rtype == "message_update":
            event = record.get("assistantMessageEvent") or {}
            if event.get("type") == "text_delta" and event.get("delta"):
                self._turn_deltas.append(event["delta"])
                self.broadcast("message_delta", {"delta": event["delta"]})
        elif rtype == "message_end":
            message = record.get("message") or {}
            if message.get("role") == "assistant":
                self._final_text = "".join(
                    block.get("text", "")
                    for block in message.get("content", [])
                    if isinstance(block, dict) and block.get("type") == "text"
                )
        elif rtype == "agent_settled":
            if self._settled:
                self._settled.set()

    async def _send(self, payload: dict) -> dict:
        assert self.proc and self.proc.stdin
        self._next_id += 1
        rid = f"sl2-{self._next_id}"
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[rid] = future
        payload = {"id": rid, **payload}
        self.proc.stdin.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        await self.proc.stdin.drain()
        response = await future
        del self._pending[rid]
        return response

    async def prompt(self, message: str, draft: dict | None = None) -> str:
        assert draft is None, "draft 仅 mock 模式支持（真实核心代理经 draft_card 工具起草）"
        async with self._lock:
            self._turn_deltas = []
            self._final_text = None
            self._settled = asyncio.Event()
            response = await self._send({"type": "prompt", "message": message})
            if not response.get("success"):
                raise RuntimeError(f"pi prompt 失败：{response.get('error')}")
            try:
                await asyncio.wait_for(self._settled.wait(), timeout=PROMPT_TIMEOUT)
            except asyncio.TimeoutError:
                raise RuntimeError("核心代理回合超时（agent_settled 未到达）")
            return self._final_text if self._final_text is not None else "".join(self._turn_deltas)

    async def stats(self) -> dict | None:
        if not self.running:
            return self.last_stats
        response = await self._send({"type": "get_session_stats"})
        if response.get("success"):
            self.last_stats = response.get("data") or {}
        return self.last_stats

    async def stop(self) -> None:
        if self.proc and self.proc.stdin:
            try:
                self.proc.stdin.close()  # 官方关闭协议：close stdin 请求有序退出
            except Exception:
                pass
        if self.proc:
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.proc.kill()


# ---------- Mock 会话（无 provider key 的全链路自测） ----------


class MockSession(BaseSession):
    """模拟核心代理：流式回复 + 模拟 draft_card/dispatch 工具效果（服务端执行）。"""

    def __init__(self, slug: str, create_card_fn=None, dispatch_fn=None) -> None:
        super().__init__()
        self.slug = slug
        self.session_id = f"mock-{slug}"
        self.create_card_fn = create_card_fn  # async (slug, draft) -> card dict
        self.dispatch_fn = dispatch_fn  # async (slug, package_id) -> [task 结果]

    @property
    def model(self) -> str:
        return "mock"

    @property
    def running(self) -> bool:
        return True

    async def prompt(self, message: str, draft: dict | None = None) -> str:
        # 模拟 dispatch 工具：批准通知消息触发真实派发链（§13.2）
        if "请派发" in message and self.dispatch_fn is not None:
            import re
            m = re.search(r"P-(\d+)", message)
            if m:
                package_id = int(m.group(1))
                results = await self.dispatch_fn(self.slug, package_id)
                summary = "；".join(
                    f"T-{r['task_id']:04d}→{r['outcome']}" for r in results
                ) or "无可派发任务"
                reply = f"任务包 P-{package_id:04d} 已派发：{summary}。"
                self.broadcast("message_delta", {"delta": reply[: len(reply) // 2]})
                await asyncio.sleep(0.01)
                self.broadcast("message_delta", {"delta": reply[len(reply) // 2:]})
                return reply

        card = None
        if draft is not None:
            if self.create_card_fn is None:
                raise RuntimeError("mock 会话未注入 create_card_fn")
            card = await self.create_card_fn(self.slug, draft)  # 模拟核心代理调用 draft_card 工具
            self.broadcast("card_proposed", {"card": card})

        if card:
            reply = (
                f"已起草审批卡片 {card['card_id']}（第 {card['round']} 轮）："
                f"{card['statement']['说明']}。请在工作台批准。"
            )
        else:
            head = message.strip()[:80]
            reply = f"收到需求：{head}。我已理解，等待进一步指示或起草指令。"

        # 分段流式输出，模拟 text_delta
        for i in range(0, len(reply), 8):
            self.broadcast("message_delta", {"delta": reply[i : i + 8]})
            await asyncio.sleep(0.01)
        return reply

    async def stats(self) -> dict:
        return {"contextUsage": {"percent": 0, "tokens": 0, "contextWindow": 0}}


# ---------- 管理器 ----------


def mock_enabled() -> bool:
    return os.environ.get("SPECLOCK2_CHIEF_MOCK", "") == "1"


class PiManager:
    """每项目一个核心代理会话（A8/A1：会话可丢，账本永恒）。"""

    def __init__(self, settings: Settings, create_card_fn=None, dispatch_fn=None, db=None) -> None:
        self.settings = settings
        self.db = db  # 项目级核心代理配置读取（effective_chief）
        self.sessions: dict[str, BaseSession] = {}
        self.create_card_fn = create_card_fn  # mock 的 draft_card 工具效果
        self.dispatch_fn = dispatch_fn  # mock 的 dispatch 工具效果（真实派发链）
        self._pi_cmd_cache: list[str] | None | None = None  # None=未解析

    def _resolve_cmd(self) -> list[str] | None:
        if self._pi_cmd_cache is None:
            self._pi_cmd_cache = resolve_pi_command()
        return self._pi_cmd_cache

    async def ensure(self, slug: str, model: str | None = None) -> BaseSession:
        session = self.sessions.get(slug)
        if session is not None and session.running:
            return session
        if mock_enabled():
            session = MockSession(slug, self.create_card_fn, self.dispatch_fn)
        else:
            session = PiSession(slug, self.settings)
            # 显式 model 参数（/agent/start 手动指定）> 项目绑定 > 全局 env（PiSession 默认）
            effective = model or (effective_chief_model_str(self.db, slug) if self.db else None)
            if effective:
                session._model_args = ["--model", effective]
            await session.start()
        self.sessions[slug] = session
        return session

    def get(self, slug: str) -> BaseSession | None:
        session = self.sessions.get(slug)
        if session and session.running:
            return session
        return None

    async def stop(self, slug: str) -> None:
        session = self.sessions.pop(slug, None)
        if session:
            await session.stop()

    async def stop_all(self) -> None:
        for slug in list(self.sessions):
            await self.stop(slug)
