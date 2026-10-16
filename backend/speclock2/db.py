"""数据库连接管理：注册表引擎 + 按需打开的账本引擎（进程内缓存）。

无迁移框架：启动时建注册表，打开账本时幂等建表；已存在的表缺列时
补 ALTER TABLE ADD COLUMN（列清单见各 *_COLUMNS）。
"""

from __future__ import annotations

import threading
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.orm import Session

from . import models
from .config import Settings

# 已发布表的增量列（表名 → [(列名, SQL 类型)]）；create_all 不改已有表，缺列在此补齐
_REGISTRY_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "projects": [("working_dir", "TEXT"), ("chief_provider", "TEXT"), ("chief_model", "TEXT")],
    "model_entries": [("provider", "TEXT")],
}
_LEDGER_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "tasks": [("dispatched_at", "TEXT"), ("watchdog_minutes", "REAL"), ("output_tail", "TEXT")],
    "masters": [("provider", "TEXT")],
}


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
        self._ensure_columns(self.registry_engine, _REGISTRY_COLUMNS)
        self._migrate_model_entries()

    def _migrate_model_entries(self) -> None:
        """旧登记条目迁移：model 带 provider/model 前缀则拆出，否则置空；
        坏值修正只针对 pi 条目（修复单 21 按 harness 分治）：pi 词表里的合法值
        是 minimax-cn，"minimax" 是 mcode 自己的供应商方言——非 pi 条目的
        provider 一律不动。幂等。"""
        with self.registry_engine.connect() as conn:
            rows = conn.exec_driver_sql(
                "SELECT id, harness, model FROM model_entries WHERE provider IS NULL OR provider = ''"
            ).fetchall()
            for row_id, harness, model in rows:
                provider, _, bare = str(model).partition("/")
                if not bare:  # 无前缀：provider 保持空
                    conn.exec_driver_sql(
                        "UPDATE model_entries SET provider = '' WHERE id = ?", (row_id,)
                    )
                    continue
                # 拆分目标 (harness, bare) 已存在 → 不拆（唯一约束）；整串条目原样保留，
                # masters 的组合匹配仍能命中（修复：拆分撞库曾让应用启动即崩）
                exists = conn.exec_driver_sql(
                    "SELECT 1 FROM model_entries WHERE harness = ? AND model = ? AND id != ?",
                    (harness, bare, row_id),
                ).fetchone()
                if exists:
                    continue
                conn.exec_driver_sql(
                    "UPDATE model_entries SET provider = ?, model = ? WHERE id = ?",
                    (provider, bare, row_id),
                )
            conn.exec_driver_sql(
                "UPDATE model_entries SET provider = 'minimax-cn' "
                "WHERE provider = 'minimax' AND harness = 'pi'"
            )
            conn.commit()

    def _ensure_columns(self, engine: sa.Engine, wanted: dict[str, list[tuple[str, str]]]) -> None:
        """幂等补列：已存在的表按 PRAGMA table_info 对账，缺的 ALTER TABLE ADD COLUMN。"""
        with engine.connect() as conn:
            for table, columns in wanted.items():
                existing = {
                    row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")
                }
                for name, sql_type in columns:
                    if name not in existing:
                        conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")
            conn.commit()

    def ledger_engine(self, slug: str) -> sa.Engine:
        """打开（必要时创建）项目账本文件；建表幂等 + 增量补列。"""
        with self._lock:
            engine = self._ledger_engines.get(slug)
            if engine is None:
                engine = make_engine(self.settings.ledger_path(slug))
                models.LedgerBase.metadata.create_all(engine)
                self._ensure_columns(engine, _LEDGER_COLUMNS)
                self._ledger_engines[slug] = engine
            return engine

    def registry_session(self) -> Session:
        return Session(self.registry_engine)

    def ledger_session(self, slug: str) -> Session:
        return Session(self.ledger_engine(slug))

    def close_ledger(self, slug: str) -> None:
        """逐出账本引擎并释放连接（删除项目改文件名前必须调用，否则 Windows 文件锁）。"""
        with self._lock:
            engine = self._ledger_engines.pop(slug, None)
        if engine is not None:
            engine.dispose()
