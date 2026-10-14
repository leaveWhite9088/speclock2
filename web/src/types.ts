/**
 * 前端展示层共享类型与常量（非契约）。
 * 对话流（chat-first）按轮次分段组装：轮次 = 对话流中的分段线（DESIGN.md §7.3/§15.1）。
 */
import type { Card, Event, FeedVersion, Package, RoundInfo, TaskStatus } from './api/client'

/** 顶栏四个全局入口面板 */
export type PanelKey = 'queue' | 'dashboard' | 'convention' | 'masters'

/** 对话流中的一个轮次分段：分段线 + 该轮的内联卡片 */
export interface FeedRound {
  info: RoundInfo
  /** 本轮审批卡片（含待批准/已批准/已打回） */
  cards: Card[]
  /** 本轮发布的版本（批准落档点） */
  versions: FeedVersion[]
  /** 本轮任务包（派发卡） */
  packages: Package[]
  /** 本轮审计裁决事件（裁决卡） */
  verdictEvents: Event[]
}

/** 任务状态徽标文案（§9.3 状态机） */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: '排队中',
  dispatched: '已派发',
  running: '运行中',
  reported: '已回执',
  auditing: '审计中',
  done: '完成',
  rejected: '已打回',
  timeout: '超时',
}

/** 主代理中文名（展示用；技术单任务派发前 master 为 null → 待定） */
export function masterLabel(master: string | null): string {
  if (master === null) return '待定'
  const map: Record<string, string> = { frontend: '前端', backend: '后端' }
  return map[master] ?? master
}
