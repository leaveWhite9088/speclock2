"""数据模型：全局注册表（registry.db）+ 每项目账本（ledgers/{slug}.db）。

表名与 DESIGN.md §17 严格对齐；S0 字段最小化，只保证主键/外键关系正确，
字段与约束由后续切片（S1~S5）充实。
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class RegistryBase(DeclarativeBase):
    """全局注册表基类：项目清单 + Harness×模型登记，不存业务数据（DESIGN.md §14.1）。"""


class LedgerBase(DeclarativeBase):
    """每项目账本基类：15 张表物理隔离在各自 .db 文件里。"""


# ---------- 全局注册表 ----------


class Project(RegistryBase):
    __tablename__ = "projects"

    slug: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    name: Mapped[str] = mapped_column(sa.Text)
    created_at: Mapped[str] = mapped_column(sa.Text)
    status: Mapped[str] = mapped_column(sa.Text, default="active")
    # 项目绑定（契约 v0.4）：目标仓库目录 + 项目级核心代理模型（空 = 跟随全局 env）
    working_dir: Mapped[str | None] = mapped_column(sa.Text)
    chief_provider: Mapped[str | None] = mapped_column(sa.Text)
    chief_model: Mapped[str | None] = mapped_column(sa.Text)


class ModelEntry(RegistryBase):
    """Harness×模型登记：纯信息记录（工作台只唤醒 Harness，不替它配置模型）。

    「这个 Harness 有哪些模型」由人工登记，添加主代理时 harness+model
    只能从这里选（登记与选用的一致性由创建端点校验）。
    """

    __tablename__ = "model_entries"
    __table_args__ = (sa.UniqueConstraint("harness", "model", name="uq_harness_model"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    harness: Mapped[str] = mapped_column(sa.Text)
    model: Mapped[str] = mapped_column(sa.Text)
    # LLM 供应商名，按 harness 各用各方言（修复单 21）：pi 用 minimax-cn、
    # mcode 用 minimax。词表校验仅对 pi 条目生效；空 = 只作 harness 绑定，
    # 不出现在核心代理 /model 列表
    provider: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[str] = mapped_column(sa.Text)


# ---------- 账本：文档系统（DESIGN.md §5） ----------


class Domain(LedgerBase):
    __tablename__ = "domains"

    id: Mapped[int] = mapped_column(primary_key=True)
    # v1 单库遗留字段：独立账本内无引用对象，S0 仅保留列（见回执"契约疑问"）
    project_id: Mapped[int | None] = mapped_column(sa.Integer)
    title: Mapped[str] = mapped_column(sa.Text)
    created_at: Mapped[str] = mapped_column(sa.Text)


class Document(LedgerBase):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    domain_id: Mapped[int] = mapped_column(sa.ForeignKey("domains.id"))
    title: Mapped[str] = mapped_column(sa.Text)
    created_at: Mapped[str] = mapped_column(sa.Text)


class Block(LedgerBase):
    __tablename__ = "blocks"

    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(sa.ForeignKey("documents.id"))
    title: Mapped[str] = mapped_column(sa.Text)
    status: Mapped[str] = mapped_column(sa.Text, default="draft")  # draft | published
    current_published_version: Mapped[str | None] = mapped_column(sa.Text)
    # 草稿四件套（DESIGN.md §5.2）；PUT 只写这里，批准时才产生版本
    draft_content_md: Mapped[str] = mapped_column(sa.Text, default="")
    draft_rules_json: Mapped[list] = mapped_column(sa.JSON, default=list)
    draft_apis_json: Mapped[list] = mapped_column(sa.JSON, default=list)
    draft_nfr_md: Mapped[str] = mapped_column(sa.Text, default="")
    # 规则稳定 id 计数器（DESIGN.md §5.3）：已分配过的历史最大值，删除规则不回退、永不复用
    rule_seq: Mapped[int] = mapped_column(sa.Integer, default=0)
    created_at: Mapped[str] = mapped_column(sa.Text)
    updated_at: Mapped[str] = mapped_column(sa.Text)


class BlockVersion(LedgerBase):
    __tablename__ = "block_versions"  # 不可变快照（DESIGN.md §6.1）

    id: Mapped[int] = mapped_column(primary_key=True)
    block_id: Mapped[int] = mapped_column(sa.ForeignKey("blocks.id"))
    version: Mapped[str] = mapped_column(sa.Text)  # semver
    round: Mapped[int] = mapped_column(sa.Integer)
    statement: Mapped[dict] = mapped_column(sa.JSON)  # 业务变更说明书
    content_md: Mapped[str] = mapped_column(sa.Text)
    rules_json: Mapped[list] = mapped_column(sa.JSON)
    apis_json: Mapped[list] = mapped_column(sa.JSON)
    nfr_md: Mapped[str] = mapped_column(sa.Text)
    delta_json: Mapped[dict] = mapped_column(sa.JSON)
    change_note: Mapped[str | None] = mapped_column(sa.Text)
    published_by: Mapped[str] = mapped_column(sa.Text)
    published_at: Mapped[str] = mapped_column(sa.Text)


# ---------- 全局约定（DESIGN.md §5.5） ----------


class Convention(LedgerBase):
    __tablename__ = "conventions"  # 项目内全局唯一一份

    id: Mapped[int] = mapped_column(primary_key=True)
    draft_md: Mapped[str | None] = mapped_column(sa.Text)  # 待批准草稿
    created_at: Mapped[str] = mapped_column(sa.Text)


class ConventionVersion(LedgerBase):
    __tablename__ = "convention_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    convention_id: Mapped[int] = mapped_column(sa.ForeignKey("conventions.id"))
    version: Mapped[str] = mapped_column(sa.Text)
    content: Mapped[dict] = mapped_column(sa.JSON)
    round: Mapped[int] = mapped_column(sa.Integer)
    statement: Mapped[dict] = mapped_column(sa.JSON)
    published_at: Mapped[str] = mapped_column(sa.Text)


# ---------- 轮次与事件（DESIGN.md §7） ----------


class Round(LedgerBase):
    __tablename__ = "rounds"

    id: Mapped[int] = mapped_column(primary_key=True)
    n: Mapped[int] = mapped_column(sa.Integer, unique=True)
    opened_at: Mapped[str] = mapped_column(sa.Text)
    closed_at: Mapped[str | None] = mapped_column(sa.Text)
    approval_card_id: Mapped[int | None] = mapped_column(sa.ForeignKey("approval_cards.id"))
    versions_manifest: Mapped[dict | None] = mapped_column(sa.JSON)


class Event(LedgerBase):
    __tablename__ = "events"  # append-only，永不清除（DESIGN.md §7.2）

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[str] = mapped_column(sa.Text)
    round: Mapped[int] = mapped_column(sa.Integer)
    actor: Mapped[str] = mapped_column(sa.Text)
    type: Mapped[str] = mapped_column(sa.Text)
    ref: Mapped[dict] = mapped_column(sa.JSON)
    payload: Mapped[dict] = mapped_column(sa.JSON)


class ApprovalCard(LedgerBase):
    __tablename__ = "approval_cards"  # DESIGN.md §8.2

    id: Mapped[int] = mapped_column(primary_key=True)
    round: Mapped[int] = mapped_column(sa.Integer)
    status: Mapped[str] = mapped_column(sa.Text)  # pending | approved | rejected
    statement: Mapped[dict] = mapped_column(sa.JSON)
    rule_ops: Mapped[list] = mapped_column(sa.JSON, default=list)
    api_ops: Mapped[list] = mapped_column(sa.JSON, default=list)
    convention_ops: Mapped[list] = mapped_column(sa.JSON, default=list)
    breaking_count: Mapped[int] = mapped_column(sa.Integer, default=0)
    impact: Mapped[list] = mapped_column(sa.JSON, default=list)
    task_preview: Mapped[list] = mapped_column(sa.JSON, default=list)
    risk: Mapped[dict | None] = mapped_column(sa.JSON)
    narration_event: Mapped[str | None] = mapped_column(sa.Text)
    decision: Mapped[dict | None] = mapped_column(sa.JSON)
    created_at: Mapped[str] = mapped_column(sa.Text)


# ---------- 任务包与队列（DESIGN.md §9） ----------


class TaskPackage(LedgerBase):
    __tablename__ = "task_packages"

    id: Mapped[int] = mapped_column(primary_key=True)
    origin: Mapped[str] = mapped_column(sa.Text, default="approval")  # approval | tech（§9.1 双入口）
    round: Mapped[int] = mapped_column(sa.Integer)
    version_refs: Mapped[dict] = mapped_column(sa.JSON)
    created_at: Mapped[str] = mapped_column(sa.Text)


class Task(LedgerBase):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    package_id: Mapped[int] = mapped_column(sa.ForeignKey("task_packages.id"))
    master: Mapped[str | None] = mapped_column(sa.Text)  # 技术单任务 master 待定（null）
    depends_on: Mapped[list] = mapped_column(sa.JSON, default=list)
    status: Mapped[str] = mapped_column(sa.Text, default="queued")
    harness: Mapped[str | None] = mapped_column(sa.Text)
    session_ref: Mapped[str | None] = mapped_column(sa.Text)
    dispatch_prompt_event: Mapped[str | None] = mapped_column(sa.Text)
    watchdog_deadline: Mapped[str | None] = mapped_column(sa.Text)
    # 看门狗重启重建（追加项 9）：定时器是内存态，派发时刻与时长落库，
    # 启动时按 deadline 重武装（老数据只有 deadline 也兼容）
    dispatched_at: Mapped[str | None] = mapped_column(sa.Text)
    watchdog_minutes: Mapped[float | None] = mapped_column(sa.Float)
    # 过程输出尾部（追加单 5）：派发期间滚动保留最后 4KB stdout
    output_tail: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[str] = mapped_column(sa.Text)
    updated_at: Mapped[str] = mapped_column(sa.Text)


# ---------- 投诉 / 验收 / 回执（DESIGN.md §10、§11、§13.4） ----------


class Complaint(LedgerBase):
    __tablename__ = "complaints"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(sa.ForeignKey("tasks.id"))
    master: Mapped[str] = mapped_column(sa.Text)
    claim: Mapped[str] = mapped_column(sa.Text)
    evidence: Mapped[list] = mapped_column(sa.JSON, default=list)
    verdict: Mapped[dict | None] = mapped_column(sa.JSON)
    verdict_by: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[str] = mapped_column(sa.Text)


class AuditRun(LedgerBase):
    __tablename__ = "audit_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(sa.ForeignKey("tasks.id"))
    level: Mapped[str] = mapped_column(sa.Text)  # machine | llm
    result: Mapped[str] = mapped_column(sa.Text)
    details: Mapped[dict | None] = mapped_column(sa.JSON)
    created_at: Mapped[str] = mapped_column(sa.Text)


class Receipt(LedgerBase):
    __tablename__ = "receipts"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(sa.ForeignKey("tasks.id"))
    files_changed: Mapped[list] = mapped_column(sa.JSON, default=list)
    self_check: Mapped[str] = mapped_column(sa.Text)
    summary: Mapped[str] = mapped_column(sa.Text)
    telemetry: Mapped[dict | None] = mapped_column(sa.JSON)
    created_at: Mapped[str] = mapped_column(sa.Text)


# ---------- 主代理注册表（DESIGN.md §17） ----------


class Master(LedgerBase):
    __tablename__ = "masters"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(sa.Text)
    role: Mapped[str] = mapped_column(sa.Text)
    harness: Mapped[str] = mapped_column(sa.Text)
    model: Mapped[str | None] = mapped_column(sa.Text)
    # LLM 供应商名，跟随所绑 harness 的方言（修复单 21）：pi 主代理是 minimax-cn、
    # mcode 主代理是 minimax；派发 --model 组合 provider/model 时原样使用
    provider: Mapped[str | None] = mapped_column(sa.Text)
    working_dir: Mapped[str | None] = mapped_column(sa.Text)
    agents_md: Mapped[str | None] = mapped_column(sa.Text)
    session_policy: Mapped[dict | None] = mapped_column(sa.JSON)
    created_at: Mapped[str] = mapped_column(sa.Text)


class TechOrder(LedgerBase):
    """技术任务单（DESIGN.md §6.4）：不动业务的变更走此通道，不进版本链。"""

    __tablename__ = "tech_orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    intent: Mapped[str] = mapped_column(sa.Text)
    scope: Mapped[list] = mapped_column(sa.JSON, default=list)  # 范围声明 = 技术任务的"契约"
    baseline: Mapped[dict | None] = mapped_column(sa.JSON)
    acceptance: Mapped[list] = mapped_column(sa.JSON, default=list)
    package_id: Mapped[int] = mapped_column(sa.ForeignKey("task_packages.id"))
    created_at: Mapped[str] = mapped_column(sa.Text)
