"""/api/cli-sessions：读取 CLI（pi）内部的会话列表，主代理创建时绑定其一。

清单是探测结果不是配置：扫 CLI 自己的会话目录（见 cli_sessions 模块），
目录不存在/为空就如实返回空清单。
"""

from __future__ import annotations

from fastapi import APIRouter

from .. import cli_sessions

router = APIRouter()


@router.get("/api/cli-sessions")
def list_cli_sessions() -> dict:
    return {"items": cli_sessions.scan()}
