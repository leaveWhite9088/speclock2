"""pytest 夹具：每个用例独立的临时数据目录 + 全新应用实例。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    monkeypatch.setenv("SPECLOCK2_DATA_DIR", str(d))
    # 隔离开发机 backend/.env 的本地配置（key/模型配置不进测试环境）
    for key in ("SPECLOCK2_CHIEF_PROVIDER", "SPECLOCK2_CHIEF_MODEL", "SPECLOCK2_MASTER_MODEL",
                "MINIMAX_CN_API_KEY", "MINIMAX_API_KEY", "SPECLOCK2_PI_CMD"):
        monkeypatch.delenv(key, raising=False)
    return d


@pytest.fixture()
def client(data_dir):
    # create_app 在调用时读取 SPECLOCK2_DATA_DIR，故先设环境变量再建应用
    from speclock2.app import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
