"""派单：harness 模型发现端点——GET /api/harness-models?harness={name}。

契约：{"harness", "models", "source"}；source ∈ discovered/static/none。
发现失败/超时（5 秒）/未知 harness 一律 200 + 空清单 + none。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

HARNESS_MODELS = "/api/harness-models"


def test_mcode_static_fallback(client):
    """mcode 没有列模型命令 → 静态兜底（安装包路由表）。"""
    r = client.get(HARNESS_MODELS, params={"harness": "mcode"})
    assert r.status_code == 200
    body = r.json()
    assert body == {"harness": "mcode",
                    "models": ["MiniMax-M3", "MiniMax-M2.7-highspeed", "MiniMax-M2.7"],
                    "source": "static"}


def test_pi_and_unknown_return_none(client):
    """pi 走登记手工维护（无发现）；未知/缺失 harness 一律 200 + 空 + none。"""
    for name in ("pi", "sl2-fake", "claude-code", "no-such", ""):
        r = client.get(HARNESS_MODELS, params={"harness": name})
        assert r.status_code == 200, name
        assert r.json() == {"harness": name, "models": [], "source": "none"}, name


def test_opencode_discovered(client, tmp_path, monkeypatch):
    """opencode 实查：假命令每行输出一个模型 id → discovered + 解析结果。"""
    script = tmp_path / "fake_oc.py"
    script.write_text(
        "import sys\n"
        "print('opencode/free-gateway')\n"
        "print('deepseek/deepseek-flash')\n"
        "print('')\n"               # 空行跳过
        "print('no-slash-noise')\n"  # 不含 "/" 的噪声跳过
        "sys.exit(0)\n", encoding="utf-8")
    import speclock2.harness_map as hm

    monkeypatch.setattr(hm, "resolve_opencode_command", lambda: [sys.executable, str(script)])
    r = client.get(HARNESS_MODELS, params={"harness": "opencode"})
    assert r.status_code == 200
    body = r.json()
    assert body == {"harness": "opencode",
                    "models": ["opencode/free-gateway", "deepseek/deepseek-flash"],
                    "source": "discovered"}


def test_opencode_not_installed_returns_none(client, monkeypatch):
    """本机没装 opencode（解析不到命令）→ 200 + 空 + none。"""
    import speclock2.harness_map as hm

    monkeypatch.setattr(hm, "resolve_opencode_command", lambda: None)
    r = client.get(HARNESS_MODELS, params={"harness": "opencode"})
    assert r.status_code == 200
    assert r.json() == {"harness": "opencode", "models": [], "source": "none"}


def test_opencode_command_fails_returns_none(client, tmp_path, monkeypatch):
    """发现命令非零退出 → 200 + 空 + none（不 5xx）。"""
    script = tmp_path / "fail_oc.py"
    script.write_text("import sys\nsys.exit(3)\n", encoding="utf-8")
    import speclock2.harness_map as hm

    monkeypatch.setattr(hm, "resolve_opencode_command", lambda: [sys.executable, str(script)])
    r = client.get(HARNESS_MODELS, params={"harness": "opencode"})
    assert r.status_code == 200
    assert r.json()["source"] == "none" and r.json()["models"] == []


def test_opencode_timeout_returns_none(client, tmp_path, monkeypatch):
    """发现命令超时（>5 秒）→ 200 + 空 + none，且端点在时限附近返回。"""
    script = tmp_path / "slow_oc.py"
    script.write_text("import time\ntime.sleep(30)\n", encoding="utf-8")
    import speclock2.harness_map as hm

    monkeypatch.setattr(hm, "resolve_opencode_command", lambda: [sys.executable, str(script)])
    t0 = time.time()
    r = client.get(HARNESS_MODELS, params={"harness": "opencode"})
    elapsed = time.time() - t0
    assert r.status_code == 200
    assert r.json() == {"harness": "opencode", "models": [], "source": "none"}
    assert elapsed < 15  # 5 秒超时生效（留进程回收余量），不是干等 30 秒
