"""配置：数据目录解析（默认 backend/data/，环境变量 SPECLOCK2_DATA_DIR 覆盖）。"""

from __future__ import annotations

import os
from pathlib import Path


def load_env_file(path: Path) -> None:
    """加载 KEY=VALUE 本地环境文件（backend/.env，含密钥不入库）；已存在的环境变量优先。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(Path(__file__).resolve().parent.parent / ".env")


def resolve_data_dir() -> Path:
    override = os.environ.get("SPECLOCK2_DATA_DIR")
    if override:
        return Path(override).resolve()
    # speclock2/config.py -> backend/data/
    return Path(__file__).resolve().parent.parent / "data"


class Settings:
    def __init__(self) -> None:
        self.data_dir = resolve_data_dir()
        self.registry_path = self.data_dir / "registry.db"
        self.ledgers_dir = self.data_dir / "ledgers"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.ledgers_dir.mkdir(parents=True, exist_ok=True)

    def ledger_path(self, slug: str) -> Path:
        return self.ledgers_dir / f"{slug}.db"
