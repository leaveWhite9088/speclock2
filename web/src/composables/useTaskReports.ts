import { ref } from 'vue'
import type { ApiClient, TaskReportEvent } from '../api/client'
import type { ReportItem } from '../types'

/**
 * 任务报告（task.report）的前端状态：历史来自 events?type=task.report，
 * 实时来自 SSE task_report。同一个 task_id 只保留一项。
 */
export function useTaskReports() {
  const reports = ref<ReportItem[]>([])

  function upsert(item: ReportItem, authoritative: boolean): void {
    const i = reports.value.findIndex((r) => r.payload.task_id === item.payload.task_id)
    if (i < 0) {
      reports.value = [...reports.value, item]
    } else {
      // 历史事件带真实时间与轮次，覆盖位置；SSE 重复推送只更新内容，不挪位置
      const next = [...reports.value]
      next[i] = authoritative ? item : { ...next[i], payload: item.payload }
      reports.value = next
    }
  }

  function isReport(v: unknown): v is TaskReportEvent {
    return !!v && typeof v === 'object' && typeof (v as { task_id?: unknown }).task_id === 'string'
  }

  /** 实时：收到 SSE task_report（data 为 JSON 文本）。round 取当前进行中的轮次 */
  function pushSse(data: string, round: number): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (!isReport(parsed)) return
    upsert({ round, ts: Date.now(), payload: normalize(parsed) }, false)
  }

  /** 历史：全量拉取并合并；SSE 已收到而历史里尚没有的项保留 */
  async function load(client: ApiClient, slug: string, isCurrent: () => boolean): Promise<void> {
    try {
      const { items } = await client.listEvents(slug, { type: 'task.report' })
      if (!isCurrent()) return
      const fromHistory = new Map<string, ReportItem>()
      for (const e of items) {
        if (!isReport(e.payload)) continue
        fromHistory.set(e.payload.task_id, { round: e.round, ts: Date.parse(e.ts), payload: normalize(e.payload) })
      }
      const sseOnly = reports.value.filter((r) => !fromHistory.has(r.payload.task_id))
      reports.value = [...fromHistory.values(), ...sseOnly]
    } catch {
      /* 事件日志暂不可用：保持现状 */
    }
  }

  function reset(): void {
    reports.value = []
  }

  return { reports, pushSse, load, reset }
}

/** 缺省字段兜底：后端漏字段时卡片也能渲染 */
function normalize(p: TaskReportEvent): TaskReportEvent {
  return {
    ...p,
    summary: p.summary ?? '',
    files_changed: Array.isArray(p.files_changed) ? p.files_changed : [],
    issues: Array.isArray(p.issues) ? p.issues : [],
    duration_ms: p.duration_ms ?? null,
    token_source: p.token_source ?? null,
  }
}
