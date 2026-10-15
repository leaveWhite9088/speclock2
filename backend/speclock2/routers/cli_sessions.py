"""/api/cli-sessions：读取 CLI（pi/mcode）内部的会话列表，主代理创建时绑定其一。

清单是探测结果不是配置：扫各 CLI 自己的会话目录（见 cli_sessions 模块），
目录不存在/为空就如实返回空清单；?cwd= 按会话所属工作目录过滤（修复单 3）。
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from .. import cli_sessions

router = APIRouter()


@router.get("/api/cli-sessions")
def list_cli_sessions(cwd: str = Query(default=None)) -> dict:
    return {"items": cli_sessions.scan(cwd=cwd)}
