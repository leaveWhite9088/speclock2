/**
 * 前端展示层共享类型（非契约）。
 * 时间线骨架在 S0 由 mock 提供数据；S3 起改由 GET /api/p/{slug}/rounds/{n} 组装，
 * 届时这些类型与 api/client.ts 的 RoundDetail 对齐。
 */
import type { Card, ReceiptSubmission } from './api/client'

/** 顶栏右侧四个全局入口（S0 打开占位面板） */
export type PanelKey = 'queue' | 'dashboard' | 'convention' | 'masters'

/** 派发卡骨架输入（契约 v0 的任务明细属 S4，届时替换为 api/client.ts 的 Task） */
export interface TaskBrief {
  task_id: string
  master: string
  harness: string
  status: string
}

/** 裁决卡骨架输入（audit_runs / complaints 形状属 S3/S5，届时替换） */
export interface VerdictBrief {
  title: string
  result: 'pass' | 'fail'
  summary: string
  evidence: string[]
}

/** 轮次卡内的子卡片条目（按 kind 分发到对应组件） */
export type TimelineCardItem =
  | { kind: 'approval'; card: Card }
  | { kind: 'dispatch'; task: TaskBrief }
  | { kind: 'receipt'; receipt: ReceiptSubmission }
  | { kind: 'verdict'; verdict: VerdictBrief }

/** 轮次卡数据（DESIGN.md §7.3：轮次 N = 第 N-1 次批准到第 N 次批准之间的全部活动） */
export interface RoundFixture {
  n: number
  status: 'ongoing' | 'closed'
  openedAt: string
  closedAt: string | null
  summary: string
  cards: TimelineCardItem[]
}
