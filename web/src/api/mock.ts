/**
 * mock 模式（M1-S0）：后端不可达时的内置数据与客户端。
 *
 * fixtures：两个项目（日报系统 / 费用报销）；「日报系统」时间线为轮次 #12，
 * 含一张待批准审批卡，数据照 DESIGN.md §8.1 的示例构造。
 * 时间线 fixture（getTimelineFixture）为前端展示层数据，非契约端点。
 */
import { ApiError } from './client'
import type { ApiClient, ApiEntry, Card, ProjectDetail, ProjectTree, Project } from './client'
import type { RoundFixture } from '../types'

/* ---------- fixtures ---------- */

const projects: Project[] = [
  { slug: 'daily-report', name: '日报系统', created_at: '2026-10-12T09:00:00+08:00', status: 'active' },
  { slug: 'expense', name: '费用报销', created_at: '2026-10-13T14:30:00+08:00', status: 'active' },
]

const exportEntry: ApiEntry = {
  name: '导出日报',
  api: 'GET /export',
  desc: '按日期导出日报文件',
  request: [
    { name: 'date', type: 'string', required: true, description: '导出日期 YYYY-MM-DD' },
    { name: 'format', type: 'string', required: false, description: '文件格式 csv | xlsx（本版新增）' },
  ],
  response: [
    { name: 'code', type: 'string', required: true, description: 'ok | export_failed（原枚举含 ok_old，本版删除）' },
    { name: 'file_url', type: 'string', required: false, description: '导出文件地址' },
  ],
}

const exportTaskEntry: ApiEntry = {
  name: '导出进度',
  api: 'GET /export/tasks/:id',
  desc: '查询导出任务进度',
  request: [{ name: 'id', type: 'string', required: true, description: '导出任务 ID' }],
  response: [
    { name: 'status', type: 'string', required: true, description: 'running | done | failed' },
    { name: 'file_url', type: 'string', required: false, description: '完成后的文件地址' },
  ],
}

/** 待批准卡片（DESIGN.md §8.1 示例：规则 2改1增 / 契约 1改1增 ⚠1 破坏性） */
const pendingCard: Card = {
  card_id: 'C-0031',
  round: 12,
  status: 'pending',
  statement: {
    说明: '导出支持 Excel',
    动机: '财务需要带格式的月报',
  },
  rule_ops: [
    {
      op: 'modify',
      id: 'R3',
      before: { id: 'R3', name: '导出格式', detail: '仅支持 CSV 一种格式' },
      after: { id: 'R3', name: '导出格式', detail: '支持 CSV 与 Excel(xlsx) 两种格式' },
    },
    {
      op: 'modify',
      id: 'R7',
      before: { id: 'R7', name: '文件命名', detail: '固定文件名 daily.csv' },
      after: { id: 'R7', name: '文件命名', detail: '文件名加日期后缀 daily-YYYYMMDD' },
    },
    {
      op: 'add',
      id: 'R9',
      before: null,
      after: { id: 'R9', name: '失败保留', detail: '导出失败时保留上次生成的文件' },
    },
  ],
  api_ops: [
    {
      op: 'upsert',
      key: 'GET /export',
      entry: exportEntry,
      breaking: true,
      existed: true,
      changes: ['请求 + format(string, 可选 csv|xlsx)'],
      breaking_changes: ['response.code 枚举删除 "ok_old"'],
    },
    {
      op: 'upsert',
      key: 'GET /export/tasks/:id',
      entry: exportTaskEntry,
      breaking: false,
      existed: false,
      changes: ['新增端点：查询导出进度'],
    },
  ],
  breaking_count: 1,
  impact: ['frontend', 'backend'],
  risk: { text: '旧枚举仅前端旧版本使用，已废弃', verified_by: 'audit' },
  convention_ops: [],
  task_preview: [{ master: 'backend' }, { master: 'frontend' }],
  narration_event: 'E-01040',
  decision: null,
}

const details: Record<string, ProjectDetail> = {
  'daily-report': { slug: 'daily-report', name: '日报系统', current_round: 12, open_card: pendingCard },
  expense: { slug: 'expense', name: '费用报销', current_round: 3, open_card: null },
}

const trees: Record<string, ProjectTree> = {
  'daily-report': {
    items: [
      {
        id: 'D-1',
        title: '报表域',
        documents: [
          {
            id: 'DOC-1',
            title: '日报',
            blocks: [
              { id: 'B-1', title: '导出', status: 'published', current_published_version: '1.2.0' },
              { id: 'B-2', title: '订阅', status: 'draft', current_published_version: null },
            ],
          },
        ],
      },
    ],
  },
  expense: {
    items: [
      {
        id: 'D-2',
        title: '报销域',
        documents: [
          {
            id: 'DOC-2',
            title: '报销单',
            blocks: [{ id: 'B-3', title: '提交', status: 'draft', current_published_version: null }],
          },
        ],
      },
    ],
  },
}

const timelines: Record<string, RoundFixture[]> = {
  'daily-report': [
    {
      n: 12,
      status: 'ongoing',
      openedAt: '2026-10-14T09:12:00+08:00',
      closedAt: null,
      summary: '导出支持 Excel（卡片待批准）',
      cards: [{ kind: 'approval', card: pendingCard }],
    },
  ],
  expense: [
    {
      n: 3,
      status: 'ongoing',
      openedAt: '2026-10-13T16:02:00+08:00',
      closedAt: null,
      summary: '等待新需求输入',
      cards: [],
    },
  ],
}

/** 时间线 fixture（展示层入口，S3 起由真实端点取代） */
export function getTimelineFixture(slug: string): RoundFixture[] {
  return timelines[slug] ?? []
}

/* ---------- mock 客户端 ---------- */

function notImplemented(endpoint: string): never {
  throw new ApiError(501, { code: 'not_implemented', message: `mock 模式未实现 ${endpoint}（属后续切片）` })
}

function mustFind<T>(record: Record<string, T>, key: string, what: string): T {
  const found = record[key]
  if (!found) throw new ApiError(404, { code: 'not_found', message: `${what} ${key} 不存在（mock）` })
  return found
}

export function createMockApiClient(): ApiClient {
  return {
    health: async () => ({ ok: true }),
    listProjects: async () => ({ items: projects.map((x) => ({ ...x })) }),
    createProject: async () => notImplemented('POST /api/projects'),
    getProject: async (slug) => ({ ...mustFind(details, slug, '项目') }),
    getTree: async (slug) => mustFind(trees, slug, '项目'),
    createDomain: async () => notImplemented('POST /api/p/{slug}/domains'),
    createDocument: async () => notImplemented('POST /api/p/{slug}/documents'),
    createBlock: async () => notImplemented('POST /api/p/{slug}/blocks'),
    getBlock: async () => notImplemented('GET /api/p/{slug}/blocks/{id}'),
    updateBlockDraft: async () => notImplemented('PUT /api/p/{slug}/blocks/{id}'),
    createCard: async () => notImplemented('POST /api/p/{slug}/cards'),
    listCards: async (slug, status) => {
      const detail = details[slug]
      if (!detail) throw new ApiError(404, { code: 'not_found', message: `项目 ${slug} 不存在（mock）` })
      const cards = detail.open_card ? [detail.open_card] : []
      return { items: status ? cards.filter((c) => c.status === status) : cards }
    },
    approveCard: async () => notImplemented('POST /api/p/{slug}/cards/{id}/approve'),
    rejectCard: async () => notImplemented('POST /api/p/{slug}/cards/{id}/reject'),
    listRounds: async () => notImplemented('GET /api/p/{slug}/rounds'),
    getRound: async () => notImplemented('GET /api/p/{slug}/rounds/{n}'),
    listEvents: async () => notImplemented('GET /api/p/{slug}/events'),
    listPackages: async () => notImplemented('GET /api/p/{slug}/packages'),
    submitReceipt: async () => notImplemented('POST /api/p/{slug}/tasks/{id}/receipt'),
    getConvention: async () => notImplemented('GET /api/p/{slug}/conventions'),
    updateConventionDraft: async () => notImplemented('PUT /api/p/{slug}/conventions/draft'),
    approveConvention: async () => notImplemented('POST /api/p/{slug}/conventions/approve'),
  }
}
