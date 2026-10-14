/**
 * mock 模式（M1）：后端不可达时的内置数据与客户端。
 *
 * S0：两个项目 fixtures；「日报系统」时间线为轮次 #12，含一张待批准审批卡
 *     （数据照 DESIGN.md §8.1 示例）。
 * S1：树与草稿改为客户端实例内的可变状态——新建业务域/文档/模块、PUT 草稿
 *     全部走本地状态（不发真请求），后端不在时全流程可演示。
 * 时间线 fixture（getTimelineFixture）为前端展示层数据，非契约端点。
 */
import { ApiError } from './client'
import type {
  ApiClient,
  ApiEntry,
  Block,
  BlockDraft,
  Card,
  Project,
  ProjectDetail,
  ProjectTree,
} from './client'
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

const emptyDraft = (): BlockDraft => ({ content_md: '', rules: [], apis: [], nfr_md: '' })

/** 「导出」模块的完整草稿（含中文规则与嵌套字段，供草稿查看演示） */
const exportBlockDraft: BlockDraft = {
  content_md:
    '市场部每个工作日需要一份带汇总指标的日报。本模块负责按日期生成并导出日报文件，支持手动触发与批量导出。',
  rules: [
    { id: 'R1', name: '导出范围', detail: '默认导出最近一个工作日，可选最近 7 天或 30 天' },
    { id: 'R2', name: '文件格式', detail: 'CSV 与 Excel(xlsx) 两种格式' },
    { id: 'R3', name: '失败处理', detail: '导出失败时保留上次生成的文件，并向订阅者发送失败通知' },
  ],
  apis: [
    exportEntry,
    {
      name: '批量导出',
      api: 'POST /export/batch',
      desc: '按日期区间批量导出，异步任务',
      request: [
        {
          name: 'range',
          type: 'object',
          required: true,
          description: '日期区间',
          children: [
            { name: 'start', type: 'string', required: true, description: '开始日期 YYYY-MM-DD' },
            { name: 'end', type: 'string', required: true, description: '结束日期 YYYY-MM-DD' },
          ],
        },
        {
          name: 'fields',
          type: 'array',
          required: false,
          description: '导出字段白名单，缺省导出全部',
          children: [{ name: '(项)', type: 'string', required: true, description: '字段名' }],
        },
      ],
      response: [
        { name: 'code', type: 'string', required: true, description: 'ok | export_failed' },
        {
          name: 'task',
          type: 'object',
          required: true,
          description: '导出任务',
          children: [
            { name: 'task_id', type: 'string', required: true, description: '任务 ID' },
            { name: 'status', type: 'string', required: true, description: 'running | done | failed' },
          ],
        },
      ],
    },
  ],
  nfr_md: '导出最近 30 天数据应在 10 秒内完成；单文件上限 50MB，超出自动拆分。',
}

const treeFixtures: Record<string, ProjectTree> = {
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

const blockFixtures: Record<string, Block> = {
  'B-1': {
    id: 'B-1',
    title: '导出',
    status: 'published',
    current_published_version: '1.2.0',
    draft: exportBlockDraft,
    versions: [
      {
        version: '1.2.0',
        round: 11,
        statement: { 说明: '导出支持失败通知', 动机: '运维需要在失败时被告知' },
        delta_summary: '1改',
      },
    ],
  },
  'B-2': {
    id: 'B-2',
    title: '订阅',
    status: 'draft',
    current_published_version: null,
    draft: {
      content_md: '报表使用者可订阅日报，每日定时收到邮件。',
      rules: [{ id: 'R1', name: '订阅范围', detail: '按报表维度订阅，一人可订阅多份' }],
      apis: [],
      nfr_md: '',
    },
    versions: [],
  },
  'B-3': {
    id: 'B-3',
    title: '提交',
    status: 'draft',
    current_published_version: null,
    draft: emptyDraft(),
    versions: [],
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
  // 每个 mock 客户端实例一份可变状态：新建流与草稿写入只改这里，不发真请求
  const trees: Record<string, ProjectTree> = structuredClone(treeFixtures)
  const blocks: Record<string, Block> = structuredClone(blockFixtures)
  let domainSeq = 0
  let documentSeq = 0
  let blockSeq = 0
  const now = (): string => new Date().toISOString()

  return {
    health: async () => ({ ok: true }),
    listProjects: async () => ({ items: projects.map((x) => ({ ...x })) }),
    createProject: async () => notImplemented('POST /api/projects'),
    getProject: async (slug) => ({ ...mustFind(details, slug, '项目') }),
    getTree: async (slug) => structuredClone(mustFind(trees, slug, '项目')),
    createDomain: async (slug, body) => {
      const tree = mustFind(trees, slug, '项目')
      const id = `D-1${++domainSeq}`
      tree.items.push({ id, title: body.title, documents: [] })
      return { id, title: body.title, created_at: now() }
    },
    createDocument: async (slug, body) => {
      const tree = mustFind(trees, slug, '项目')
      const domain = tree.items.find((d) => d.id === body.domain_id)
      if (!domain) throw new ApiError(404, { code: 'not_found', message: `业务域 ${body.domain_id} 不存在（mock）` })
      const id = `DOC-1${++documentSeq}`
      domain.documents.push({ id, title: body.title, blocks: [] })
      return { id, domain_id: body.domain_id, title: body.title, created_at: now() }
    },
    createBlock: async (slug, body) => {
      const tree = mustFind(trees, slug, '项目')
      let document: ProjectTree['items'][number]['documents'][number] | undefined
      for (const domain of tree.items) {
        const found = domain.documents.find((d) => d.id === body.document_id)
        if (found) document = found
      }
      if (!document) throw new ApiError(404, { code: 'not_found', message: `文档 ${body.document_id} 不存在（mock）` })
      const id = `B-1${++blockSeq}`
      const block: Block = {
        id,
        title: body.title,
        status: 'draft',
        current_published_version: null,
        draft: emptyDraft(),
        versions: [],
      }
      document.blocks.push({
        id,
        title: body.title,
        status: 'draft',
        current_published_version: null,
      })
      blocks[id] = block
      return structuredClone(block)
    },
    getBlock: async (_slug, id) => structuredClone(mustFind(blocks, id, '模块')),
    updateBlockDraft: async (_slug, id, draft) => {
      const block = mustFind(blocks, id, '模块')
      block.draft = {
        content_md: draft.content_md,
        rules: structuredClone(draft.rules),
        apis: structuredClone(draft.apis),
        nfr_md: draft.nfr_md,
      }
      return structuredClone(block)
    },
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
