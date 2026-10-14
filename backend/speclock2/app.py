"""FastAPI 应用工厂。"""

from __future__ import annotations

from fastapi import FastAPI

from .config import Settings
from .db import Database
from .errors import register_error_handlers
from .routers import cards, conventions, health, project, projects, queue, stats, timeline


def create_app() -> FastAPI:
    # 配置在工厂调用时读取环境变量，测试可用 SPECLOCK2_DATA_DIR 指向临时目录
    settings = Settings()
    settings.ensure_dirs()

    # 关闭 /docs、/openapi.json 等框架自带端点：不加契约之外的端点
    app = FastAPI(title="SpecLock2 Backend", version="0.1.0", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.db = Database(settings)
    app.state.db.init_registry()  # 启动时建表
    app.state.timers = set()  # 看门狗定时器（防 GC）

    register_error_handlers(app)
    app.include_router(health.router)
    app.include_router(projects.router)
    app.include_router(project.router)
    app.include_router(cards.router)
    app.include_router(timeline.router)
    app.include_router(queue.router)
    app.include_router(conventions.router)
    app.include_router(stats.router)
    return app
