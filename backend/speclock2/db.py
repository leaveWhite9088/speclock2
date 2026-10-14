"""数据库连接管理：注册表引擎 + 按需打开的账本引擎（进程内缓存）。

无迁移框架：启动时建注册表，打开账本时幂等建表（沿用 v1 做法）。
"""

from __future__ import annotations

import threading
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.orm import Session

from . import models
from .config import Settings


def make_engine(db_path: Path) -> sa.Engine:
    # check_same_thread=False：FastAPI 同步端点跑在线程池，连接可能跨线程使用
    return sa.create_engine(f"sqlite:///{db_path.as_posix()}", connect_args={"check_same_thread": False})


class Database:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.registry_engine = make_engine(settings.registry_path)
        self._ledger_engines: dict[str, sa.Engine] = {}
        self._lock = threading.Lock()

    def init_registry(self) -> None:
        models.RegistryBase.metadata.create_all(self.registry_engine)

    def ledger_engine(self, slug: str) -> sa.Engine:
        """打开（必要时创建）项目账本文件；建表幂等。"""
        with self._lock:
            engine = self._ledger_engines.get(slug)
            if engine is None:
                engine = make_engine(self.settings.ledger_path(slug))
                models.LedgerBase.metadata.create_all(engine)
                self._ledger_engines[slug] = engine
            return engine

    def registry_session(self) -> Session:
        return Session(self.registry_engine)

    def ledger_session(self, slug: str) -> Session:
        return Session(self.ledger_engine(slug))
