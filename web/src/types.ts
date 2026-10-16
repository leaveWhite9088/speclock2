/**
 * 前端展示层共享类型与常量（非契约）。
 */
import type { Card, Event, FeedVersion, Package, ParseQuality, ReportStatus, RoundInfo, TaskReportEvent, TaskStatus } from './api/client'

/** 顶栏右侧抽屉入口（文档是主区视图，不占抽屉） */
export type DrawerKey = 'queue' | 'convention' | 'models'

/** 当前会话：核心代理，或某个主代理的工作流视图 */
export type SessionTarget = { kind: 'core' } | { kind: 'master'; masterId: string }

/** 对话气泡（chat.human / chat.chief 事件的投影）；system/error 为前端本地气泡，
 *  不入事件日志（/model 是命令不是消息，切模型的确认也只在本会话展示） */
export interface ChatBubble {
  round: number
  /** 毫秒时间戳：与任务报告卡片按事件时间交错排序 */
  ts: number
  who: 'human' | 'core' | 'system' | 'error'
  text: string
  /** 错误气泡的快捷动作：启动核心代理后重试模型切换 */
  action?: { kind: 'start-retry-model'; provider: string | null; model: string }
}

/** 模型选择项（/model 弹层与右上角弹层共用） */
export type ModelPick = { kind: 'default' } | { kind: 'entry'; provider: string; model: string }

/** 核心代理当前模型对应的登记条目：优先 provider/model 全串匹配，
 *  次「provider 前缀 + model 段」双匹配（同名模型挂多个 harness 时以此消歧），
 *  最后仅按 model 段匹配（GET /agent 只有合并串、无 harness 字段，契约缺口） */
export function findChiefEntry(
  current: string | null,
  entries: Array<{ harness: string; model: string; provider?: string | null }>,
): { harness: string; model: string; provider?: string | null } | null {
  if (!current) return null
  const direct = entries.find((e) => `${e.harness}/${e.model}` === current)
  if (direct) return direct
  const slash = current.indexOf('/')
  const providerPrefix = slash > 0 ? current.slice(0, slash) : null
  const short = slash > 0 ? current.slice(slash + 1) : current
  if (providerPrefix) {
    const both = entries.find((e) => e.provider === providerPrefix && e.model === short)
    if (both) return both
  }
  return entries.find((e) => e.model === short) ?? null
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

/** 任务报告（task.report）在对话流里的一项：round/ts 决定它在时间线上的位置 */
export interface ReportItem {
  round: number
  ts: number
  payload: TaskReportEvent
}

/** 报告状态标签与徽标样式（颜色沿用 base.css 的语义色） */
export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  done: '完成',
  partial: '部分完成',
  blocked: '受阻',
  failed: '失败',
}

export const REPORT_STATUS_BADGE: Record<ReportStatus, string> = {
  done: 'badge--done',
  partial: 'badge--reported',
  blocked: 'badge--rejected',
  failed: 'badge--timeout',
}

/** parse_quality 各取值的含义（悬停说明用） */
export const PARSE_QUALITY_HINTS: Record<ParseQuality, string> = {
  structured: '主代理按规定格式输出了报告，可信度最高。',
  legacy: '只找到旧的 FILES 行。文件清单可用，状态是推断的。',
  invalid: '报告块的 JSON 非法，内容不可信。',
  none: '没有找到任何报告，摘要是输出尾部或失败原因。',
  manual: '人工回执。',
}
