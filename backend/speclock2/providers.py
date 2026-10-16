"""模型服务商钥匙管理（派单）：存取、环境变量映射、pi 探测。

钥匙只写不读：落地 <data_dir>/providers.json（data/ 已被仓库 .gitignore 排除），
任何响应与日志只出现 has_key 布尔，不回显钥匙本体。
pi 的钥匙来源只走环境变量（docs/providers.md 约定，见 PROVIDER_ENV）：
拉起核心代理会话时把已存钥匙注入进程环境；存取后需重建会话才生效（A1 会话可弃）。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

PROVIDER_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
PROVIDERS_FILE = "providers.json"
PROBE_TIMEOUT_SECONDS = 10

# pi docs/providers.md 的环境变量约定（本工作台可登记的服务商子集）
PROVIDER_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "google": "GEMINI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "groq": "GROQ_API_KEY",
    "xai": "XAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "zai": "ZAI_API_KEY",
    "moonshot": "MOONSHOT_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    "qwen": "QWEN_TOKEN_PLAN_API_KEY",
}


def validate_name(name: str) -> str | None:
    """合法返回 None；不合法返回错误原因（只允许小写字母、数字、连字符）。"""
    if not name:
        return "服务商名不能为空"
    if not PROVIDER_NAME_RE.match(name):
        return f"服务商名 {name!r} 只允许小写字母、数字、连字符"
    return None


def store_path(settings) -> Path:
    return settings.data_dir / PROVIDERS_FILE


def load_keys(settings) -> dict[str, str]:
    p = store_path(settings)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}  # 钥匙文件损坏按没有处理，绝不带病上岗


def save_key(settings, name: str, api_key: str) -> None:
    keys = load_keys(settings)
    keys[name] = api_key
    p = store_path(settings)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")


def delete_key(settings, name: str) -> bool:
    keys = load_keys(settings)
    if name not in keys:
        return False
    del keys[name]
    store_path(settings).write_text(json.dumps(keys, ensure_ascii=False, indent=2), encoding="utf-8")
    return True


def env_var_for(name: str) -> str:
    """pi 环境变量约定；未收录的服务商按大写+下划线推导（第二期收录后转正）。"""
    return PROVIDER_ENV.get(name, name.upper().replace("-", "_") + "_API_KEY")


def has_key(settings, name: str) -> bool:
    """已存钥匙或进程环境里已有对应变量（如 .env 的 MINIMAX_CN_API_KEY）都算有。"""
    if name in load_keys(settings):
        return True
    return bool(os.environ.get(env_var_for(name)))


def known_providers(settings) -> list[str]:
    """当前有钥匙的服务商名单（存储 ∪ 进程环境），排序。"""
    names = set(load_keys(settings))
    names.update(p for p, var in PROVIDER_ENV.items() if os.environ.get(var))
    return sorted(names)


def injection_env(settings) -> dict[str, str]:
    """拉起 pi 会话时注入的钥匙环境变量（只含已存钥匙；.env 的键已在 os.environ 里）。"""
    return {env_var_for(name): key for name, key in load_keys(settings).items()}


def parse_model_table(stdout: str) -> list[dict]:
    """解析 `pi --list-models` 的定宽表：provider/model/context/max-out/thinking/images。"""
    out: list[dict] = []
    for line in (stdout or "").splitlines():
        cols = re.split(r"\s{2,}", line.strip())
        if len(cols) < 5 or cols[0] == "provider" or " " in cols[0]:
            continue  # 表头/横幅/「No models available」
        out.append({"id": cols[1], "thinking": cols[4].lower() == "yes"})
    return out


def probe(pi_cmd: list[str], provider: str, api_key: str | None) -> dict:
    """探测：带钥匙跑 `pi --list-models`（10 秒超时）。失败 ok=false，绝不抛。
    探测环境只留目标服务商的钥匙——清掉其他服务商的环境变量，清单才是「它的」。"""
    var = env_var_for(provider)
    if not api_key and not os.environ.get(var):
        return {"ok": False, "models": [], "error": f"{provider} 未存钥匙"}
    other_vars = {v for p, v in PROVIDER_ENV.items() if p != provider}
    env = {k: v for k, v in os.environ.items() if k not in other_vars}
    env[var] = api_key or os.environ.get(var, "")
    if not pi_cmd:
        return {"ok": False, "models": [], "error": "未找到 pi 可执行文件"}
    try:
        proc = subprocess.run([*pi_cmd, "--list-models"], capture_output=True, text=True,
                              timeout=PROBE_TIMEOUT_SECONDS, env=env)
    except subprocess.TimeoutExpired:
        return {"ok": False, "models": [], "error": f"pi --list-models 超时（{PROBE_TIMEOUT_SECONDS}s）"}
    except OSError as e:
        return {"ok": False, "models": [], "error": f"pi 无法启动：{e}"}
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-200:]
        return {"ok": False, "models": [], "error": f"pi 退出码 {proc.returncode}：{tail}"}
    if "No models available" in (proc.stdout or ""):
        return {"ok": True, "models": [],
                "error": f"pi 不认识 {provider} 的钥匙（catalog 未收录或钥匙无效）"}
    return {"ok": True, "models": parse_model_table(proc.stdout), "error": None}
