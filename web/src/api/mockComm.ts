/**
 * mock 模式的通讯协议数据（契约 v0.6）：角色文档、协议文本、任务报告事件。
 * 与 mock.ts 分文件，避免继续加长它。
 */
import { ApiError } from './client'
import type {
  Event,
  ProtocolText,
  Report,
  RoleDoc,
  RolePreview,
  RolesOverview,
  RoleTarget,
  TaskReportEvent,
} from './client'

/* ---------- 协议文本（GET /api/protocol） ---------- */

export const MOCK_PROTOCOL: ProtocolText = {
  report_format: [
    '任务结束时，在输出末尾写一个报告块：',
    '<<<REPORT',
    '{"status":"done|partial|blocked|failed","summary":"最多 300 字","files_changed":["..."],"issues":["..."]}',
    'REPORT>>>',
  ].join('\n'),
  human_report_format: '给人的汇报：一句话说清状态，再列文件数量与问题。数字由系统渲染，不由代理转述。',
}

/* ---------- 角色文档（GET/PUT/DELETE /api/p/{slug}/roles…） ---------- */

const CHIEF_DEFAULT = '# 核心代理\n\n你是 SpecLock 2 的核心代理，唯一与人对话的入口。\n\n1. 先澄清需求，再起草审批卡片。\n2. 不写代码。\n3. 业务变更必须经人批准。\n'
const MASTER_DEFAULT = (name: string): string => `# ${name}\n\n你是主代理「${name}」，只改自己负责的目录。\n\n1. 按任务包实现代码。\n2. 发现契约问题，走投诉通道。\n3. 任务结束时输出报告块。\n`
const PROTOCOL_APPENDIX = '\n\n--- 系统协议段（自动追加，不可编辑）---\n'

function key(slug: string, target: RoleTarget): string {
  return `${slug}:${target.kind === 'chief' ? 'chief' : `master:${target.name}`}`
}

/** mock 角色文档仓库；isAgentRunning 供 needs_restart 判断 */
export function createMockRoles(isAgentRunning: () => boolean) {
  const docs = new Map<string, string>()
  /** 核心代理会话启动后被改过的项目（needs_restart 的来源） */
  const dirtyChief = new Set<string>()

  const defaultOf = (target: RoleTarget): string =>
    target.kind === 'chief' ? CHIEF_DEFAULT : MASTER_DEFAULT(target.name)
  const contentOf = (slug: string, target: RoleTarget): string => docs.get(key(slug, target)) ?? defaultOf(target)
  const toDoc = (slug: string, target: RoleTarget): RoleDoc => ({
    name: target.kind === 'chief' ? 'chief' : target.name,
    content: contentOf(slug, target),
    is_default: !docs.has(key(slug, target)),
    needs_restart: target.kind === 'chief' && isAgentRunning() && dirtyChief.has(slug),
  })

  return {
    /** 会话重启（启动/重建）后清除“需要重建”标记 */
    onSessionRestart(slug?: string): void {
      if (slug) dirtyChief.delete(slug)
      else dirtyChief.clear()
    },
    async listRoles(slug: string, masterNames: string[]): Promise<RolesOverview> {
      const chief = toDoc(slug, { kind: 'chief' })
      return {
        chief: { content: chief.content, is_default: chief.is_default, needs_restart: chief.needs_restart },
        masters: masterNames.map((name) => {
          const d = toDoc(slug, { kind: 'master', name })
          return { name, content: d.content, is_default: d.is_default }
        }),
      }
    },
    async getRole(slug: string, target: RoleTarget): Promise<RoleDoc> {
      return toDoc(slug, target)
    },
    async putRole(slug: string, target: RoleTarget, content: string): Promise<RoleDoc> {
      if (!content.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: 'content 不能为空白' })
      }
      docs.set(key(slug, target), content)
      if (target.kind === 'chief' && isAgentRunning()) dirtyChief.add(slug)
      return toDoc(slug, target)
    },
    async resetRole(slug: string, target: RoleTarget): Promise<void> {
      docs.delete(key(slug, target))
      if (target.kind === 'chief' && isAgentRunning()) dirtyChief.add(slug)
    },
    async previewRole(slug: string, target: RoleTarget): Promise<RolePreview> {
      const editable = contentOf(slug, target)
      const protocol = `${PROTOCOL_APPENDIX}${MOCK_PROTOCOL.report_format}\n${MOCK_PROTOCOL.human_report_format}`
      return {
        composed: `${editable}${protocol}`,
        editable_chars: editable.length,
        protocol_chars: protocol.length,
      }
    },
  }
}

/* ---------- 任务报告事件（task.report） ---------- */

/** 由报告生成 task.report 的 payload */
export function buildReportPayload(
  taskId: string,
  master: string,
  report: Report,
  durationMs: number | null,
): TaskReportEvent {
  return {
    task_id: taskId,
    master,
    status: report.status,
    summary: report.summary,
    files_changed: report.files_changed,
    issues: report.issues,
    parse_quality: report.parse_quality,
    duration_ms: durationMs,
    token_source: durationMs == null ? null : 'estimated',
  }
}

/** 五种 parse_quality × 四种 status 的种子（含带空格路径），round 11 三条 + round 12 两条 */
export const SEED_REPORTS: Array<{ id: string; ts: string; round: number; payload: TaskReportEvent }> = [
  {
    id: 'E-0021',
    ts: '2026-10-13T11:13:00+08:00',
    round: 11,
    payload: {
      task_id: 'T-0044',
      master: 'backend',
      status: 'done',
      summary: '新增批量导出端点与日期区间校验',
      files_changed: ['backend/export.py'],
      issues: [],
      parse_quality: 'structured',
      duration_ms: 41 * 60_000,
      token_source: 'exact',
    },
  },
  {
    id: 'E-0022',
    ts: '2026-10-13T11:14:00+08:00',
    round: 11,
    payload: {
      task_id: 'T-0050',
      master: 'frontend',
      status: 'partial',
      summary: '导出页面完成了表单，下载按钮未接通。状态由旧 FILES 行推断。',
      files_changed: [
        'web/src/pages/导出 页面.vue',
        'web/src/api/export client.ts',
        'web/src/components/DateRange.vue',
        'web/src/components/FormatSelect.vue',
        'web/src/styles/export.css',
        'web/src/router.ts',
      ],
      issues: ['下载按钮未接通'],
      parse_quality: 'legacy',
      duration_ms: 18 * 60_000 + 20_000,
      token_source: 'estimated',
    },
  },
  {
    id: 'E-0023',
    ts: '2026-10-13T11:15:00+08:00',
    round: 11,
    payload: {
      task_id: 'T-0051',
      master: 'backend',
      status: 'blocked',
      summary: '报告块的 JSON 非法，内容不可信。',
      files_changed: ['backend/db.py'],
      issues: ['契约缺少 format 字段的枚举值', '数据库迁移脚本缺失'],
      parse_quality: 'invalid',
      duration_ms: 5 * 60_000,
      token_source: 'estimated',
    },
  },
  {
    id: 'E-0024',
    ts: '2026-10-14T09:06:00+08:00',
    round: 12,
    payload: {
      task_id: 'T-0052',
      master: 'backend',
      status: 'failed',
      summary: '进程以退出码 1 结束：找不到 harness 可执行文件。',
      files_changed: [],
      issues: [],
      parse_quality: 'none',
      duration_ms: 1_200,
      token_source: null,
    },
  },
  {
    id: 'E-0025',
    ts: '2026-10-14T09:10:00+08:00',
    round: 12,
    payload: {
      task_id: 'T-0053',
      master: 'frontend',
      status: 'done',
      summary: '人工回执：导出按钮样式已调整。',
      files_changed: ['web/src/components/ExportButton.vue'],
      issues: [],
      parse_quality: 'manual',
      duration_ms: null,
      token_source: null,
    },
  },
]

export function seedReportEvents(): Event[] {
  return SEED_REPORTS.map((s) => ({
    id: s.id,
    ts: s.ts,
    round: s.round,
    actor: `master:${s.payload.master}` as Event['actor'],
    type: 'task.report',
    ref: { task: s.payload.task_id },
    payload: { ...s.payload },
  }))
}
