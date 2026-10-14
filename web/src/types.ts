/**
 * 前端展示层共享类型与常量（非契约）。
 */
import type { Card, Event, FeedVersion, Package, RoundInfo, TaskStatus } from './api/client'

/** 顶栏右侧抽屉入口（文档是主区视图，不占抽屉） */
export type DrawerKey = 'queue' | 'convention' | 'models'

/** 当前会话：核心代理，或某个主代理的工作流视图 */
export type SessionTarget = { kind: 'core' } | { kind: 'master'; masterId: string }

/** 对话气泡（chat.human / chat.chief 事件的投影；error 为前端本地错误气泡） */
export interface ChatBubble {
  round: number
  who: 'human' | 'core' | 'error'
  text: string
}

/** 主代理过程流条目（M1 由 mock 模拟；R-M2 接真实遥测） */
export interface ActivityItem {
  id: string
  ts: string
  kind: 'thinking' | 'tool' | 'edit' | 'note' | 'message'
  text: string
  /** tool: 命令/结果摘要；edit: +N -M */
  meta?: string
}

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

/** 耗时展示：5.6 秒 / 41 分钟 / 1 小时 12 分 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1000)
    return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.round((ms % 3_600_000) / 60_000)
  return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/** token 展示（估算值，DESIGN §13.5）：180k / 1.2M */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return `${Math.round(tokens / 1000)}k`
}
