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
import sys
from pathlib import Path

from .pi_runtime import resolve_pi_command

DEFAULT_MASTER_HARNESS = "sl2-fake"


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
    harnesses["claude-code"] = {
        "command": "claude",
        "args": ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"],
        "prompt_mode": "inline",
        "resume_args": ["--resume", "{session_id}"],
    }
    harnesses["codex"] = {
        "command": "codex",
        "args": ["exec", "--json", "{prompt}"],
        "prompt_mode": "inline",
    }
    # 核心代理已配真模型 → 主代理默认真 CLI；否则替身（保证无 key 环境开箱可测）
    default_master = "pi" if (_chief_configured() and "pi" in harnesses) else DEFAULT_MASTER_HARNESS
    return {
        "watchdog_minutes_default": 60,
        "masters": {"backend": default_master, "frontend": default_master},
        "harnesses": harnesses,
    }


def load_or_create(data_dir: Path) -> dict:
    path = data_dir / "harness-map.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
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


def build_argv(harness_cfg: dict, prompt: str) -> list[str]:
    """命令行参数：{prompt} 占位符替换（arg 模式追加为尾参）。"""
    args = [str(a).replace("{prompt}", prompt) for a in (harness_cfg.get("args") or [])]
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
