"""harness 映射配置：master → harness → 命令行（data/harness-map.json，首次自动生成默认）。

映射形状（{"prompt} 占位符不经 shell 替换，防注入）：
{
  "watchdog_minutes_default": 60,
  "masters":   {"backend": "sl2-fake", "frontend": "sl2-fake"},
  "harnesses": {"sl2-fake": {"command": "...", "args": [...], "prompt_mode": "arg"|"inline",
                             "resume_args": ["--session-id", "{session_id}", ...]}}
}
- prompt_mode=arg：prompt 追加为最后一个参数；
- prompt_mode=inline：args 中 "{prompt}" 占位符替换（pi/claude/codex 的官方 headless 形态）；
- resume_args：主代理绑定 CLI 会话时追加的接续参数模板，{session_id}/{session_dir} 占位。

工作台不替 Harness 做模型选择（用户原则）：这里不出现任何 --model 注入，
harness 用它自己配置的模型；「某 Harness 有哪些模型」只在 /api/models 登记。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from .pi_runtime import resolve_pi_command

DEFAULT_MASTER_HARNESS = "sl2-fake"
# 工作台支持的 harness 全集（派单：收敛为三件套 + 内部替身）
ALLOWED_HARNESSES = ("pi", "mcode", "opencode")
RETIRED_HARNESSES = ("claude-code", "codex", "kimicode")  # 已收敛删除的旧条目


def resolve_mcode_command() -> list[str] | None:
    """mcode（Minimax Code CLI）启动命令。

    必须用 mcode 自带的 Node 运行时（~/.minimax-code/runtime/node-*）：其
    better-sqlite3 原生模块按自带版本编译，系统 Node 版本不同即报
    NODE_MODULE_VERSION 不匹配。SPECLOCK2_MCODE_CMD 可整体覆盖。
    """
    override = os.environ.get("SPECLOCK2_MCODE_CMD")
    if override:
        return override.split()
    home = Path.home()
    pkg_cli = home / ".minimax-code" / "node_modules" / "@minimax-ai" / "code" / "cli.js"
    if pkg_cli.exists():
        for runtime_node in sorted((home / ".minimax-code" / "runtime").glob("node-*/node.exe")):
            return [str(runtime_node), str(pkg_cli)]
        node = shutil.which("node")
        if node:  # 无自带运行时的异常安装：退系统 node（可能因原生模块版本失败）
            return [node, str(pkg_cli)]
    which = shutil.which("mcode")
    if not which:
        return None
    if which.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", which]
    return None  # POSIX shell shim：工作台 spawn 不了，宁可如实缺席


def resolve_opencode_command() -> str | None:
    """opencode（npm 全局）启动命令：Windows 是 .cmd 垫片，executor 按扩展名包 cmd /c。

    只用 shutil.which（毫秒级）——load_or_create 的升级路径会调它，
    不得走 npm 子进程（resolve_pi_command 那种秒级探测会阻塞事件循环）。
    """
    return shutil.which("opencode")


def _opencode_entry(cmd: str) -> dict:
    return {
        # opencode run（1.19.1 实测）：默认格式即纯文本 stdout（无事件流）；
        # -m provider/model 显式指定模型（全局配置可能为空，不能依赖默认模型）；
        # --auto 免权限确认（无人值守写文件）。会话接续用 -s <id>，仅证同目录才接。
        "command": cmd,
        "args": ["run", "--auto", "-m", "{model}", "{prompt}"],
        "prompt_mode": "inline",
        "resume_args": ["-s", "{session_id}"],
        "output": "text",
        "note": "DeepSeek 等 provider 经登记组合注入 -m；不要依赖全局默认模型",
    }


def _chief_configured() -> bool:
    """核心代理已配真模型 → 主代理默认唤醒真 pi（key 复用）；否则替身兜底。"""
    return bool(os.environ.get("SPECLOCK2_CHIEF_PROVIDER") and os.environ.get("SPECLOCK2_CHIEF_MODEL"))


def default_map() -> dict:
    """默认映射：核对了 provider key 的环境主代理直接唤醒 pi；
    未配置 → 落到零依赖替身，无 key 也能全链自测。"""
    backend_dir = Path(__file__).resolve().parent.parent
    fake = backend_dir / "scripts" / "fake_harness.py"
    harnesses: dict[str, dict] = {
        DEFAULT_MASTER_HARNESS: {
            "command": sys.executable,
            "args": [str(fake)],
            "prompt_mode": "arg",
            "note": "被派发 harness 替身：无 key 自测用；主代理默认走 pi，本条仅兜底",
        },
    }
    pi_cmd = resolve_pi_command()
    if pi_cmd and pi_cmd[0].lower().endswith(("node", "node.exe")):  # node 直启 cli.js，避开 .cmd
        harnesses["pi"] = {
            "command": pi_cmd[0],
            # {model} 占位：派发时按名册登记模型注入，无登记则用项目核心代理模型兜底
            # （修"被派发 pi 落 harness 默认模型"的漂移；模板不烤任何具体模型名）
            "args": [*pi_cmd[1:], "--model", "{model}",
                     "--mode", "json", "-p", "{prompt}", "--no-session"],
            "prompt_mode": "inline",
            # 接续会话：按文件头 id 定位（--session-dir 传会话文件所在目录）
            "resume_args": ["--session-id", "{session_id}", "--session-dir", "{session_dir}"],
        }
    mcode_cmd = resolve_mcode_command()
    if mcode_cmd:
        harnesses["mcode"] = {
            "command": mcode_cmd[0],
            # mcode exec：纯文本 stdout（无事件流）；{cwd} 由唤醒计划填绑定目录；
            # 模型须 provider/model 全名（如 minimax/MiniMax-M3）；token 不暴露 → 估算
            "args": [*mcode_cmd[1:], "exec", "{prompt}", "--model", "{model}",
                     "--permission", "full", "--cwd", "{cwd}"],
            "prompt_mode": "inline",
            "resume_args": ["--session", "{session_id}"],
            "output": "text",
        }
    oc_cmd = resolve_opencode_command()
    if oc_cmd:
        harnesses["opencode"] = _opencode_entry(oc_cmd)
    # 核心代理已配真模型 → 主代理默认真 CLI；否则替身（保证无 key 环境开箱可测）
    default_master = "pi" if (_chief_configured() and "pi" in harnesses) else DEFAULT_MASTER_HARNESS
    return {
        "watchdog_minutes_default": 60,
        "masters": {"backend": default_master, "frontend": default_master},
        "harnesses": harnesses,
    }


def load_or_create(data_dir: Path) -> dict:
    """加载实例映射；缺失即生成默认。升级路径（派单：harness 收敛）：
    旧文件里残留已退役条目（claude-code/codex/kimicode）自动剔除；
    支持集（opencode 等）缺失且本机可解析时自动补齐——存量 JSON 不用手改。"""
    path = data_dir / "harness-map.json"
    if path.exists():
        cfg = json.loads(path.read_text(encoding="utf-8"))
        changed = False
        harnesses = cfg.get("harnesses") or {}
        for retired in RETIRED_HARNESSES:
            if retired in harnesses:
                harnesses.pop(retired)
                changed = True
        if "opencode" not in harnesses:
            oc = resolve_opencode_command()  # 毫秒级 which，不得走 npm 子进程（会阻塞事件循环）
            if oc:
                harnesses["opencode"] = _opencode_entry(oc)
                changed = True
        if changed:
            cfg["harnesses"] = harnesses
            path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return cfg
    path.parent.mkdir(parents=True, exist_ok=True)
    cfg = default_map()
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


def resolve_harness_name(cfg: dict, master: str | None) -> str:
    """master → harness 名；未命中依次退到：默认替身 → 配置内第一个 harness。"""
    harnesses = cfg.get("harnesses") or {}
    name = (cfg.get("masters") or {}).get(master or "") or DEFAULT_MASTER_HARNESS
    if name not in harnesses:
        name = DEFAULT_MASTER_HARNESS if DEFAULT_MASTER_HARNESS in harnesses else (next(iter(harnesses), name))
    return name


def resolve_harness(cfg: dict, master: str | None) -> dict:
    return (cfg.get("harnesses") or {}).get(resolve_harness_name(cfg, master)) or {}


def build_argv(harness_cfg: dict, prompt: str, cwd: str | None = None) -> list[str]:
    """命令行参数：{prompt} 占位符替换（arg 模式追加为尾参）；{cwd} 有值才替换。"""
    args = [str(a).replace("{prompt}", prompt) for a in (harness_cfg.get("args") or [])]
    if cwd is not None:
        args = [a.replace("{cwd}", cwd) for a in args]
    if harness_cfg.get("prompt_mode", "arg") == "arg":
        args.append(prompt)
    return [harness_cfg["command"], *args]


def apply_model(args: list[str], model: str | None) -> list[str]:
    """{model} 占位替换（契约 v0.4）：有模型 → 原位替换；无模型 → 连同前置 flag 一起摘除。

    约定 {model} 总是单独占一个参数位、跟在它的 flag 后面（如 ["--model", "{model}"]）。
    """
    if model:
        return [a.replace("{model}", model) for a in args]
    out: list[str] = []
    prev_is_flag = False
    for a in args:
        if "{model}" in a:
            if prev_is_flag:
                out.pop()  # 摘掉裸占位前面的 flag（如 --model）
            prev_is_flag = False
            continue
        out.append(a)
        prev_is_flag = a.startswith("--")
    return out


def build_resume_args(harness_cfg: dict, session_id: str, session_dir: str | None) -> list[str] | None:
    """会话接续参数：模板含 {session_dir} 但目录没探到时返回 None（放弃接续，新会话照常）。"""
    template = harness_cfg.get("resume_args") or []
    if not template:
        return None
    if any("{session_dir}" in str(a) for a in template) and not session_dir:
        return None
    return [
        str(a).replace("{session_id}", session_id).replace("{session_dir}", session_dir or "")
        for a in template
    ]
