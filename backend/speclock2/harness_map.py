"""harness 映射配置：master → harness → 命令行（data/harness-map.json，首次自动生成默认）。

映射形状（{"prompt} 占位符不经 shell 替换，防注入）：
{
  "watchdog_minutes_default": 60,
  "masters":   {"backend": "sl2-fake", "frontend": "sl2-fake"},
  "harnesses": {"sl2-fake": {"command": "...", "args": [...], "prompt_mode": "arg"|"inline"}}
}
- prompt_mode=arg：prompt 追加为最后一个参数；
- prompt_mode=inline：args 中 "{prompt}" 占位符替换（pi/claude/codex 的官方 headless 形态）。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from .pi_runtime import resolve_pi_command

DEFAULT_MASTER_HARNESS = "sl2-fake"


def master_model() -> str | None:
    """主代理模型：优先 SPECLOCK2_MASTER_MODEL，否则沿用核心代理的 provider/model。"""
    m = os.environ.get("SPECLOCK2_MASTER_MODEL")
    if m:
        return m
    provider = os.environ.get("SPECLOCK2_CHIEF_PROVIDER", "")
    model = os.environ.get("SPECLOCK2_CHIEF_MODEL", "")
    if provider and model:
        return f"{provider}/{model}"
    return model or None


def default_map() -> dict:
    """默认映射：配置了真模型 → 主代理直接唤醒 pi（真 CLI，继承 provider key）；
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
    model = master_model()
    pi_cmd = resolve_pi_command()
    if pi_cmd and pi_cmd[0].lower().endswith(("node", "node.exe")):  # node 直启 cli.js，避开 .cmd
        pi_args = [*pi_cmd[1:], "--mode", "json", "-p", "{prompt}", "--no-session"]
        if model:
            pi_args += ["--model", model]
        harnesses["pi"] = {
            "command": pi_cmd[0],
            "args": pi_args,
            "prompt_mode": "inline",
        }
    harnesses["claude-code"] = {
        "command": "claude",
        "args": ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"],
        "prompt_mode": "inline",
    }
    harnesses["codex"] = {
        "command": "codex",
        "args": ["exec", "--json", "{prompt}"],
        "prompt_mode": "inline",
    }
    # 有真模型 → 主代理默认真 CLI；否则替身（保证无 key 环境开箱可测）
    default_master = "pi" if (model and "pi" in harnesses) else DEFAULT_MASTER_HARNESS
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


def resolve_harness(cfg: dict, master: str | None) -> dict:
    """master → harness 配置；未命中依次退到：默认替身 → 配置内第一个 harness。"""
    harnesses = cfg.get("harnesses") or {}
    name = (cfg.get("masters") or {}).get(master or "") or DEFAULT_MASTER_HARNESS
    resolved = harnesses.get(name) or harnesses.get(DEFAULT_MASTER_HARNESS)
    if resolved is None and harnesses:
        resolved = next(iter(harnesses.values()))
    return resolved or {}


def build_argv(harness_cfg: dict, prompt: str) -> list[str]:
    """命令行参数：{prompt} 占位符替换（arg 模式追加为尾参）。"""
    args = [str(a).replace("{prompt}", prompt) for a in (harness_cfg.get("args") or [])]
    if harness_cfg.get("prompt_mode", "arg") == "arg":
        args.append(prompt)
    return [harness_cfg["command"], *args]
