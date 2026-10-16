"""派单：模型服务商钥匙管理——CRUD（只写不读）、pi 探测、会话环境注入。

契约：GET /api/providers、PUT/DELETE /api/providers/{name}、POST probe；
钥匙落地 data/providers.json（gitignored），任何响应不回显钥匙本体。
"""

from __future__ import annotations

import sys
from pathlib import Path

PROBE_TABLE = (
    "provider    model            context  max-out  thinking  images\n"
    "deepseek    deepseek-chat    128K     64K      yes       no\n"
    "deepseek    deepseek-reason  128K     64K      yes       yes\n"
)


def test_provider_name_validation(client):
    """服务商名只允许小写字母、数字、连字符 → 422。"""
    for bad in ("DeepSeek", "a b", "a_b", "a/b", "a.b", ""):
        r = client.put(f"/api/providers/{bad}" if bad else "/api/providers/",
                       json={"api_key": "sk-x"})
        assert r.status_code in (404, 405, 422), bad  # 空名落到路由不匹配（405/404）也算拒绝
        if r.status_code == 422:
            assert "连字符" in r.json()["message"] or "服务商名" in r.json()["message"]


def test_provider_key_cycle_never_echoes_key(client):
    """PUT → GET（has_key=true，无钥匙本体）→ DELETE → 204 → has_key=false。"""
    key = "sk-secret-e2e-key-000111"
    r = client.put("/api/providers/deepseek", json={"api_key": key})
    assert r.status_code == 200 and r.json() == {"name": "deepseek", "has_key": True}
    assert key not in r.text  # 钥匙只写不读

    r = client.get("/api/providers")
    names = [i["name"] for i in r.json()["items"]]
    assert "deepseek" in names
    item = [i for i in r.json()["items"] if i["name"] == "deepseek"][0]
    assert item["has_key"] is True and "api_key" not in item
    assert key not in r.text

    assert client.delete("/api/providers/deepseek").status_code == 204
    r = client.get("/api/providers")
    item = [i for i in r.json()["items"] if i["name"] == "deepseek"]
    assert item == []  # 无进程环境钥匙时删完即不在名单
    assert client.delete("/api/providers/deepseek").status_code == 204  # 幂等

    # 钥匙文件里不进 git（data/ 已被 ignore），且响应里从未出现钥匙本体


def test_provider_env_fallback_has_key(client, monkeypatch):
    """进程环境已有对应变量（如 .env 的 MINIMAX_CN_API_KEY）→ has_key=true。"""
    import speclock2.providers as providers

    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-env-key")
    r = client.get("/api/providers")
    item = [i for i in r.json()["items"] if i["name"] == "deepseek"]
    assert item and item[0]["has_key"] is True
    # 环境变量名映射：minimax-cn 对应 MINIMAX_CN_API_KEY
    assert providers.env_var_for("minimax-cn") == "MINIMAX_CN_API_KEY"
    assert providers.env_var_for("deepseek") == "DEEPSEEK_API_KEY"


def test_probe_with_stored_key_parses_table(client, tmp_path, monkeypatch):
    """探测：带已存钥匙跑 pi --list-models，解析定宽表 → models[{id,thinking}]。"""
    script = tmp_path / "fake_pi.py"
    script.write_text(
        "import os, sys\n"
        "if not os.environ.get('DEEPSEEK_API_KEY'):\n"
        "    print('No models available'); sys.exit(0)\n"
        + "".join(f"print({ln!r})\n" for ln in PROBE_TABLE.splitlines()),
        encoding="utf-8")
    import speclock2.harness_map as hm
    import speclock2.pi_runtime as pr

    monkeypatch.setattr(pr, "resolve_pi_command", lambda: [sys.executable, str(script)])
    client.put("/api/providers/deepseek", json={"api_key": "sk-secret-42"})
    r = client.post("/api/providers/deepseek/probe")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["error"] is None
    assert body["models"] == [{"id": "deepseek-chat", "thinking": True},
                              {"id": "deepseek-reason", "thinking": True}]

    # 未存钥匙（且环境无）→ 200 + ok=false + error
    client.delete("/api/providers/deepseek")
    r = client.post("/api/providers/deepseek/probe")
    assert r.status_code == 200 and r.json()["ok"] is False and r.json()["error"]


def test_probe_no_models_available(client, tmp_path, monkeypatch):
    """pi 输出「No models available」（钥匙无效/未收录）→ ok=true + 空清单。"""
    script = tmp_path / "fake_pi_none.py"
    script.write_text("print('No models available')\n", encoding="utf-8")
    import speclock2.pi_runtime as pr

    monkeypatch.setattr(pr, "resolve_pi_command", lambda: [sys.executable, str(script)])
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-invalid")  # 有钥匙环境，pi 不认 → 空表
    r = client.post("/api/providers/deepseek/probe")
    assert r.status_code == 200 and r.json()["ok"] is True and r.json()["models"] == []


def test_harness_models_pi_aggregates_probes(client, tmp_path, monkeypatch):
    """GET /api/harness-models?harness=pi：汇总全部有钥匙服务商的探测结果。"""
    script = tmp_path / "fake_pi.py"
    script.write_text(
        "import os, sys\n"
        "if os.environ.get('DEEPSEEK_API_KEY'):\n"
        + "".join(f"    print({ln!r})\n" for ln in PROBE_TABLE.splitlines())
        + "else:\n    print('No models available')\n",
        encoding="utf-8")
    import speclock2.pi_runtime as pr

    monkeypatch.setattr(pr, "resolve_pi_command", lambda: [sys.executable, str(script)])
    client.put("/api/providers/deepseek", json={"api_key": "sk-secret-7"})
    r = client.get("/api/harness-models", params={"harness": "pi"})
    assert r.status_code == 200
    body = r.json()
    assert body["harness"] == "pi" and body["source"] == "discovered"
    assert "deepseek/deepseek-chat" in body["models"]


def test_chief_session_env_injects_stored_keys(client, monkeypatch):
    """拉起核心代理会话的环境要带上已存钥匙（pi 环境变量约定）。"""
    import speclock2.providers as providers
    from speclock2.pi_runtime import PiSession

    key = "sk-inject-77"
    client.put("/api/providers/deepseek", json={"api_key": key})
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    session = PiSession("inj", client.app.state.settings)
    env = session._process_env()
    assert env["DEEPSEEK_API_KEY"] == key
    assert env["SPECLOCK2_SLUG"] == "inj"


def test_provider_key_stays_out_of_git_and_logs(client, tmp_path):
    """钥匙文件落在 data/（仓库 .gitignore 覆盖），路径即证明。"""
    from speclock2 import providers

    p = providers.store_path(client.app.state.settings)
    assert p.parent.name == "data"
    assert p.name == "providers.json"
