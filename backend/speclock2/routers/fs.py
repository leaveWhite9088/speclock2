"""/api/fs/dirs：本机目录浏览（供前端目录选择器，契约 v0.4）。

仅本机单用户工具（无鉴权，README 已注明不要暴露到公网）：
只读列子目录，不读文件内容，不做任何写操作。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Query, Request

from ..errors import ApiError

router = APIRouter()


@router.get("/api/fs/dirs")
def list_dirs(request: Request, path: str = Query(..., description="绝对路径")) -> dict:
    p = Path(path).expanduser()
    if not p.is_dir():
        raise ApiError(422, "validation_error", f"路径不存在或不是目录：{path}")
    try:
        dirs = sorted((e for e in p.iterdir() if e.is_dir()), key=lambda e: e.name.lower())
    except OSError as exc:
        raise ApiError(422, "validation_error", f"目录不可读：{exc}")
    return {"items": [{"name": e.name, "path": str(e)} for e in dirs]}
