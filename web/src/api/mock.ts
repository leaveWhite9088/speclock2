/**
 * mock 模式（M1-S2，契约 v0.2）：后端不可达时的内置数据与客户端。
 *
 * 在客户端实例内维护每项目一份"迷你账本"（轮次/事件/卡片/任务包/技术单/约定/版本），
 * 新建流、起草、批准、派发、回执、审计、超时、约定批准全部走本地状态机，
 * 后端不在时 M1 全流程可演示。语义对齐 DESIGN.md：
 *  - 批准 = 应用 ops → 快照(semver) → 轮次关闭/开启 → 任务包(origin=approval)入队（§8.4）
 *  - 任务状态机 + 看门狗超时（§9.3/§9.4）
 *  - 技术任务单 → origin=tech 任务包（§6.4）
 */
import { ApiError } from './client'
import type {
  ApiClient,
  ApproveResponse,
  Block,
  BlockDraft,
  Card,
  CardSubmission,
  CliSession,
  Convention,
  CreateTechOrderBody,
  Event,
  EventActor,
  FeedVersion,
  MasterInfo,
  ModelEntry,
  Package,
  Project,
  ProjectTree,
  ProviderProbe,
  RoundInfo,
  Rule,
  Stats,
  Task,
  TaskStatus,
  TechOrder,
} from './client'
import type { ActivityItem } from '../types'
import { buildReportPayload, createMockRoles, MOCK_PROTOCOL, seedReportEvents } from './mockComm'

/* ---------- 基础工具 ---------- */

const now = (): string => new Date().toISOString()

function clone<T>(value: T): T {
  return structuredClone(value)
}

function mustFind<T>(record: Record<string, T>, key: string, what: string): T {
  const found = record[key]
  if (!found) throw new ApiError(404, { code: 'not_found', message: `${what} ${key} 不存在（mock）` })
  return found
}

function bumpVersion(prev: string | null, hasBreaking: boolean, hasAdd: boolean): string {
  if (!prev) return '1.0.0'
  const [major, minor, patch] = prev.split('.').map(Number)
  if (hasBreaking) return `${major + 1}.0.0`
  if (hasAdd) return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/* ---------- 迷你账本 ---------- */

interface MockLedger {
  rounds: RoundInfo[]
  events: Event[]
  cards: Card[]
  packages: Package[]
  techOrders: TechOrder[]
  convention: Convention
  versionsByRound: Record<number, FeedVersion[]>
  ruleSeqByBlock: Record<string, number>
  seq: { event: number; card: number; pkg: number; task: number; order: number }
}

const emptyDraft = (): BlockDraft => ({ content_md: '', rules: [], apis: [], nfr_md: '' })

const CONVENTION_TEMPLATE = [
  '# 全局约定（默认模板播种）',
  '',
  '- 错误响应：envelope {code, message, details?} + HTTP 状态码映射表',
  '- 分页：?page + ?page_size，响应 {items, total, page, page_size}',
  '- 时间：ISO 8601 带时区字符串；ID 对外一律字符串',
  '- null 语义：可空字段省略，不传 null；金额：字符串两位小数（禁浮点）',
  '- 认证：Authorization: Bearer <token>；API 版本：URL 前缀 /api/v1；枚举：小写蛇形',
].join('\n')

/** 「导出」模块草稿（含中文规则与嵌套字段） */
const exportBlockDraft: BlockDraft = {
  content_md:
    '市场部每个工作日需要一份带汇总指标的日报。本模块负责按日期生成并导出日报文件，支持手动触发与批量导出。',
  rules: [
    { id: 'R1', name: '导出范围', detail: '默认导出最近一个工作日，可选最近 7 天或 30 天' },
    { id: 'R2', name: '文件格式', detail: 'CSV 与 Excel(xlsx) 两种格式' },
    { id: 'R3', name: '失败处理', detail: '导出失败时保留上次生成的文件，并向订阅者发送失败通知' },
  ],
  apis: [
    {
      name: '导出日报',
      api: 'GET /export',
      desc: '按日期导出日报文件',
      request: [
        { name: 'date', type: 'string', required: true, description: '导出日期 YYYY-MM-DD' },
        { name: 'format', type: 'string', required: false, description: 'csv | xlsx，默认 csv' },
      ],
      response: [
        { name: 'code', type: 'string', required: true, description: 'ok | export_failed' },
        { name: 'file_url', type: 'string', required: false, description: '文件地址' },
      ],
    },
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

/** 待批准卡片（DESIGN.md §8.1 示例：规则 2改1增 / 契约 1改1增 ⚠1 破坏性） */
const pendingCardFixture: Card = {
  card_id: 'C-0031',
  round: 12,
  status: 'pending',
  statement: { 说明: '导出支持 Excel', 动机: '财务需要带格式的月报' },
  rule_ops: [
    {
      op: 'modify',
      block_id: '1',
      id: 'R3',
      before: { id: 'R3', name: '失败处理', detail: '导出失败时保留上次生成的文件' },
      after: { id: 'R3', name: '失败处理', detail: '导出失败时保留上次生成的文件，并向订阅者发送失败通知' },
    },
    {
      op: 'modify',
      block_id: '1',
      id: 'R2',
      before: { id: 'R2', name: '文件格式', detail: '仅支持 CSV 一种格式' },
      after: { id: 'R2', name: '文件格式', detail: '支持 CSV 与 Excel(xlsx) 两种格式' },
    },
    {
      op: 'add',
      block_id: '1',
      id: '',
      before: null,
      after: { id: '', name: '进度查询', detail: '批量导出可查询任务进度' },
    },
  ],
  api_ops: [
    {
      op: 'upsert',
      block_id: '1',
      key: 'GET /export',
      entry: {
        name: '导出日报',
        api: 'GET /export',
        desc: '按日期导出日报文件',
        request: [
          { name: 'date', type: 'string', required: true, description: '导出日期 YYYY-MM-DD' },
          { name: 'format', type: 'string', required: false, description: 'csv | xlsx（本版新增）' },
        ],
        response: [
          { name: 'code', type: 'string', required: true, description: 'ok | export_failed' },
        ],
      },
      breaking: true,
      existed: true,
      changes: ['请求 + format(string, 可选 csv|xlsx)'],
      breaking_changes: ['response.code 枚举删除 "ok_old"'],
    },
    {
      op: 'upsert',
      block_id: '1',
      key: 'GET /export/tasks/:id',
      entry: {
        name: '导出进度',
        api: 'GET /export/tasks/:id',
        desc: '查询导出任务进度',
        request: [{ name: 'id', type: 'string', required: true, description: '导出任务 ID' }],
        response: [{ name: 'status', type: 'string', required: true, description: 'running | done | failed' }],
      },
      breaking: false,
      existed: false,
      changes: ['新增端点：查询导出进度'],
    },
  ],
  breaking_count: 1,
  impact: ['frontend', 'backend'],
  risk: { text: '旧枚举仅前端旧版本使用，已废弃', verified_by: 'audit' },
  task_preview: [{ master: 'backend' }, { master: 'frontend' }],
  narration_event: 'E-0008',
  decision: null,
}

const dailyReportTree: ProjectTree = {
  items: [
    {
      id: '1',
      title: '报表域',
      documents: [
        {
          id: '1',
          title: '日报',
          blocks: [
            { id: '1', title: '导出', status: 'published', current_published_version: '1.2.0' },
            { id: '2', title: '订阅', status: 'draft', current_published_version: null },
          ],
        },
      ],
    },
  ],
}

const expenseTree: ProjectTree = {
  items: [
    {
      id: '2',
      title: '报销域',
      documents: [
        {
          id: '2',
          title: '报销单',
          blocks: [{ id: '3', title: '提交', status: 'draft', current_published_version: null }],
        },
      ],
    },
  ],
}

function buildLedger(blocksSeed: Record<string, Block>, roundsSeed: RoundInfo[], cardsSeed: Card[], packagesSeed: Package[], eventsSeed: Event[]): MockLedger {
  const ruleSeq: Record<string, number> = {}
  for (const [id, block] of Object.entries(blocksSeed)) {
    ruleSeq[id] = block.draft.rules.reduce((m, r) => Math.max(m, Number(r.id.replace('R', '')) || 0), 0)
  }
  return {
    rounds: roundsSeed,
    events: eventsSeed,
    cards: cardsSeed,
    packages: packagesSeed,
    techOrders: [],
    convention: { version: '1.0.0', content_md: CONVENTION_TEMPLATE, draft_md: null, statement: null },
    versionsByRound: {},
    ruleSeqByBlock: ruleSeq,
    seq: { event: 100, card: 100, pkg: 100, task: 100, order: 100 },
  }
}

function dailyReportLedger(): MockLedger {
  const blocks: Record<string, Block> = {
    '1': {
      id: '1',
      title: '导出',
      status: 'published',
      current_published_version: '1.2.0',
      draft: clone(exportBlockDraft),
      versions: [
        {
          version: '1.2.0',
          round: 11,
          statement: { 说明: '批量导出支持日期区间', 动机: '月报需要一次导出整月' },
          delta_summary: '1增',
        },
      ],
    },
    '2': {
      id: '2',
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
  }
  const rounds: RoundInfo[] = [
    {
      n: 11,
      opened_at: '2026-10-13T09:00:00+08:00',
      closed_at: '2026-10-13T10:30:00+08:00',
      approval_card_id: 'C-0030',
      versions_manifest: { '1': '1.2.0' },
    },
    {
      n: 12,
      opened_at: '2026-10-13T10:30:00+08:00',
      closed_at: null,
      approval_card_id: null,
      versions_manifest: {},
    },
  ]
  const approvedCard: Card = {
    card_id: 'C-0030',
    round: 11,
    status: 'approved',
    statement: { 说明: '批量导出支持日期区间', 动机: '月报需要一次导出整月' },
    rule_ops: [
      { op: 'add', block_id: '1', id: '', before: null, after: { id: '', name: '批量导出', detail: '支持按日期区间一次导出' } },
    ],
    api_ops: [
      {
        op: 'upsert',
        block_id: '1',
        key: 'POST /export/batch',
        entry: { name: '批量导出', api: 'POST /export/batch', desc: '按日期区间批量导出，异步任务', request: [], response: [] },
        breaking: false,
        existed: false,
        changes: ['新增端点：批量导出'],
      },
    ],
    breaking_count: 0,
    impact: ['backend'],
    risk: { text: '无特别风险', verified_by: null },
    decision: null,
  }
  const packages: Package[] = [
    {
      package_id: 'P-0011',
      origin: 'approval',
      round: 11,
      version_refs: { '1': '1.2.0' },
      tasks: [
        {
          task_id: 'T-0044',
          master: 'backend',
          status: 'done',
          watchdog_deadline: null,
          duration_ms: 41 * 60_000,
          tokens: 180_000,
          receipt: {
            files_changed: ['backend/export.py'],
            self_check: 'pytest 全绿（12 passed）',
            summary: '新增批量导出端点与日期区间校验',
            report: {
              status: 'done',
              summary: '新增批量导出端点与日期区间校验',
              files_changed: ['backend/export.py'],
              issues: [],
              parse_quality: 'structured',
            },
          },
        },
      ],
    },
    // 一个包内两个并行任务（后端 + 前端），用于核对任务包显示
    {
      package_id: 'P-0012',
      origin: 'approval',
      round: 12,
      version_refs: { '1': '1.2.0' },
      tasks: [
        {
          task_id: 'T-0045',
          master: 'backend',
          status: 'reported',
          watchdog_deadline: null,
          duration_ms: 12 * 60_000,
          tokens: 96_000,
          receipt: {
            files_changed: ['backend/api/export.py', 'backend/services/export.py'],
            self_check: 'pytest 全绿',
            summary: '导出接口新增 format 参数',
            report: {
              status: 'partial',
              summary: '导出接口新增 format 参数，xlsx 分支未实现。',
              files_changed: ['backend/api/export.py', 'backend/services/export.py'],
              issues: ['xlsx 分支未实现'],
              parse_quality: 'legacy',
            },
          },
        },
        {
          task_id: 'T-0046',
          master: 'frontend',
          status: 'running',
          watchdog_deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
          receipt: null,
        },
      ],
    },
  ]
  const events: Event[] = [
    { id: 'E-0001', ts: '2026-10-13T09:10:00+08:00', round: 11, actor: 'chief', type: 'draft.proposed', ref: { card: 'C-0030' }, payload: {} },
    { id: 'E-0002', ts: '2026-10-13T10:30:00+08:00', round: 11, actor: 'human', type: 'approval.granted', ref: { card: 'C-0030' }, payload: {} },
    { id: 'E-0003', ts: '2026-10-13T10:30:00+08:00', round: 11, actor: 'system', type: 'version.published', ref: { block: '1' }, payload: { version: '1.2.0' } },
    { id: 'E-0004', ts: '2026-10-13T10:30:00+08:00', round: 11, actor: 'system', type: 'package.created', ref: { package: 'P-0011' }, payload: {} },
    { id: 'E-0005', ts: '2026-10-13T10:31:00+08:00', round: 11, actor: 'master:backend', type: 'task.dispatched', ref: { task: 'T-0044' }, payload: {} },
    { id: 'E-0006', ts: '2026-10-13T11:12:00+08:00', round: 11, actor: 'master:backend', type: 'task.receipt', ref: { task: 'T-0044' }, payload: {} },
    { id: 'E-0007', ts: '2026-10-13T11:20:00+08:00', round: 11, actor: 'audit', type: 'audit.machine.passed', ref: { task: 'T-0044' }, payload: { note: '契约测试通过' } },
    // 对话历史（chat.* 事件，页面刷新后从这里恢复）
    { id: 'E-0009', ts: '2026-10-14T09:05:00+08:00', round: 12, actor: 'human', type: 'chat.human', ref: {}, payload: { message: '导出能不能支持 Excel？财务那边想要带格式的月报。' } },
    { id: 'E-0010', ts: '2026-10-14T09:08:00+08:00', round: 12, actor: 'chief', type: 'chat.chief', ref: {}, payload: { message: '可以。我核对了现有的规则和契约，整理成了下面这张卡片——有一处破坏性变更，建议你重点看那一条。' } },
    { id: 'E-0008', ts: '2026-10-14T09:12:00+08:00', round: 12, actor: 'chief', type: 'draft.proposed', ref: { card: 'C-0031' }, payload: {} },
  ]
  events.push(...seedReportEvents())
  const ledger = buildLedger(blocks, rounds, [approvedCard, clone(pendingCardFixture)], packages, events)
  ledger.versionsByRound[11] = [
    {
      block_id: '1',
      version: '1.2.0',
      round: 11,
      statement: { 说明: '批量导出支持日期区间', 动机: '月报需要一次导出整月' },
      delta_summary: '1增',
    },
  ]
  return ledger
}

function expenseLedger(): MockLedger {
  const blocks: Record<string, Block> = {
    '3': { id: '3', title: '提交', status: 'draft', current_published_version: null, draft: emptyDraft(), versions: [] },
  }
  const rounds: RoundInfo[] = [
    {
      n: 3,
      opened_at: '2026-10-13T16:02:00+08:00',
      closed_at: null,
      approval_card_id: null,
      versions_manifest: {},
    },
  ]
  return buildLedger(blocks, rounds, [], [], [])
}

/* ---------- 顶层 fixtures ---------- */

/** 可变：mock 新建项目直接追加（物理隔离由按 slug 建账本模拟） */
const projects: Project[] = [
  { slug: 'daily-report', name: '日报系统', created_at: '2026-10-12T09:00:00+08:00', status: 'active', working_dir: 'D:/work/daily-report', chief_provider: 'claude-code', chief_model: 'claude-sonnet-4.5' },
  { slug: 'expense', name: '费用报销', created_at: '2026-10-13T14:30:00+08:00', status: 'active', working_dir: null, chief_provider: null, chief_model: null },
]

/** 「本机目录浏览」的 mock 文件系统（GET /api/fs/dirs）：key = 归一化目录，value = 子目录 */
const FAKE_FS: Record<string, string[]> = {
  'D:/': ['D:/work', 'D:/proj'],
  'D:/work': ['D:/work/daily-report', 'D:/work/expense'],
  'D:/work/daily-report': ['D:/work/daily-report/backend', 'D:/work/daily-report/web'],
  'D:/work/expense': ['D:/work/expense/docs'],
  'D:/proj': ['D:/proj/speclock2'],
  'D:/proj/speclock2': ['D:/proj/speclock2/backend', 'D:/proj/speclock2/web'],
}

/** Windows/POSIX 路径归一：反斜杠→斜杠、去尾斜杠；盘符根保留尾斜杠（D:/） */
export function normalizeFsPath(path: string): string {
  let p = path.trim().replace(/\\/g, '/')
  p = p.replace(/\/+$/, '')
  if (/^[A-Za-z]:$/.test(p)) p += '/'
  return p
}

/** 上一级目录：D:/a/b → D:/a；D:/a → D:/；D:/ → null */
export function parentFsPath(path: string): string | null {
  const p = normalizeFsPath(path)
  const i = p.replace(/\/$/, '').lastIndexOf('/')
  if (i < 0) return null // D:/ 已是根（去掉尾斜杠后没有分隔符）
  const parent = p.slice(0, i === 1 ? 2 : i) // 盘符根 D:/ 保留斜杠
  return normalizeFsPath(parent)
}

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/

/* ---------- Harness×模型登记 / CLI 会话（mock 初始数据；live 后端缺端点时也用它兜底） ---------- */

export const FALLBACK_MODEL_ENTRIES: ModelEntry[] = [
  { id: 'mdl-1', harness: 'claude-code', model: 'glm-4.7' },
  { id: 'mdl-2', harness: 'claude-code', model: 'claude-sonnet-4.5' },
  { id: 'mdl-3', harness: 'codex', model: 'gpt-5.2' },
  { id: 'mdl-4', harness: 'codex', model: 'deepseek-v3.2' },
  { id: 'mdl-5', harness: 'kimicode', model: 'kimi-k2.5' },
  { id: 'mdl-6', harness: 'kimicode', model: 'qwen3-max' },
  { id: 'mdl-7', harness: 'mcode', model: 'minimax/MiniMax-M3', provider: 'minimax-cn' },
  { id: 'mdl-8', harness: 'pi', model: 'MiniMax-M3', provider: 'minimax-cn' },
]

/** 「读取 CLI 内部的会话列表」的 mock 形态：cwd = 会话所属目录（?cwd= 过滤用） */
export const FALLBACK_CLI_SESSIONS: Array<CliSession & { cwd: string }> = [
  { id: 'sess_7d21c8', title: '日报导出 · 后端实现', updated_at: '2026-10-14T09:20:00+08:00', cwd: 'D:/work/daily-report/backend' },
  { id: 'sess_3a90f2', title: '前端工作台 · 界面重构', updated_at: '2026-10-13T16:41:00+08:00', cwd: 'D:/work/daily-report/web' },
  { id: 'sess_b54e07', title: '订阅模块 · 方案讨论', updated_at: '2026-10-12T11:05:00+08:00', cwd: 'D:/work/daily-report/web' },
  { id: 'sess_e8c31d', title: '全局约定 · 起草', updated_at: '2026-10-11T20:33:00+08:00', cwd: 'D:/work/daily-report' },
]

/* ---------- mock 客户端 ---------- */

export function createMockApiClient(): ApiClient {
  // 每个 mock 客户端实例一份可变状态：树/草稿 registry + 每项目一本"迷你账本"
  const trees: Record<string, ProjectTree> = {
    'daily-report': clone(dailyReportTree),
    expense: clone(expenseTree),
  }
  const ledgers: Record<string, MockLedger> = {
    'daily-report': dailyReportLedger(),
    expense: expenseLedger(),
  }
  // blocks registry：树/草稿读写与卡片 ops 应用共用的唯一模块状态
  const blocksBySlug: Record<string, Record<string, Block>> = {
    'daily-report': {
      '1': {
        id: '1',
        title: '导出',
        status: 'published',
        current_published_version: '1.2.0',
        draft: clone(exportBlockDraft),
        versions: ledgers['daily-report'].versionsByRound[11]
          ? ledgers['daily-report'].versionsByRound[11].map((v) => ({ ...v }))
          : [],
      },
      '2': {
        id: '2',
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
    },
    expense: {
      '3': { id: '3', title: '提交', status: 'draft', current_published_version: null, draft: emptyDraft(), versions: [] },
    },
  }

  // ---- R-M2 前的前端承载状态：主代理注册 / 模型登记 / CLI 会话 / 版本快照 / 过程流 / 队列模拟 ----
  const sessionTitle = (id: string | null | undefined): string | null =>
    FALLBACK_CLI_SESSIONS.find((s) => s.id === id)?.title ?? null
  const mastersBySlug: Record<string, MasterInfo[]> = {
    'daily-report': [
      { id: 'backend', name: '后端主代理', duty: '负责 backend/：API 实现与数据模型', dir: 'backend/', harness: 'claude-code', model: 'glm-4.7', session: 'sess_7d21c8', session_title: sessionTitle('sess_7d21c8') },
      { id: 'frontend', name: '前端主代理', duty: '负责 web/：界面实现与交互', dir: 'web/', harness: 'mcode', model: 'minimax/MiniMax-M3', session: 'sess_3a90f2', session_title: sessionTitle('sess_3a90f2') },
    ],
    expense: [
      { id: 'backend', name: '后端主代理', duty: '负责 backend/：API 实现与数据模型', dir: 'backend/', harness: 'claude-code', model: 'glm-4.7', session: 'sess_7d21c8', session_title: sessionTitle('sess_7d21c8') },
      { id: 'frontend', name: '前端主代理', duty: '负责 web/：界面实现与交互', dir: 'web/', harness: 'mcode', model: 'minimax/MiniMax-M3', session: 'sess_3a90f2', session_title: sessionTitle('sess_3a90f2') },
    ],
  }
  let masterSeq = 0
  const modelRegistry: ModelEntry[] = clone(FALLBACK_MODEL_ENTRIES)
  let modelSeq = modelRegistry.length
  /** 服务商登记（fx22 mock）：钥匙只存布尔，不存内容 */
  const providers: Array<{ name: string; has_key: boolean }> = [
    { name: 'minimax-cn', has_key: true },
    { name: 'deepseek', has_key: false },
  ]
  /** 版本快照：key = `${blockId}@${version}` → 当时整份草稿（查看版本用） */
  const versionSnaps: Record<string, BlockDraft> = {
    '1@1.2.0': clone(exportBlockDraft),
  }
  const activityByMaster: Record<string, ActivityItem[]> = {
    backend: [
      { id: 'A-1', ts: '2026-10-13T10:31:00+08:00', kind: 'note', text: '收到任务 T-0044（P-0011）' },
      { id: 'A-2', ts: '2026-10-13T10:31:04+08:00', kind: 'thinking', text: '思考了 2.4 秒' },
      { id: 'A-3', ts: '2026-10-13T10:31:09+08:00', kind: 'tool', text: 'Bash', meta: 'pytest -q（12 passed）' },
      { id: 'A-4', ts: '2026-10-13T11:05:00+08:00', kind: 'edit', text: 'backend/export.py', meta: '+86 -12' },
      { id: 'A-5', ts: '2026-10-13T11:12:00+08:00', kind: 'message', text: '已完成：新增批量导出端点与日期区间校验' },
    ],
  }
  let activitySeq = 100
  let queueRunning = false
  /** 任务开始时间（派发时刻）与 token 估算：遥测记录用（DESIGN §13.5） */
  const taskStart: Record<string, number> = {}

  function recordTelemetry(task: Task): void {
    const t0 = taskStart[task.task_id]
    task.duration_ms = t0 ? Date.now() - t0 : 0
    task.tokens = 90_000 + Math.floor(Math.random() * 150_000)
  }

  let domainSeq = 0
  let documentSeq = 0
  let blockSeq = 0

  // ---- 对话与核心代理状态（R-M2 同构降级：mock 客户端扮演后端） ----
  let agentRunning = true
  let agentModel = 'mock/chief'
  const roles = createMockRoles(() => agentRunning)

  /** mock 核心代理回复（对应后端 SPECLOCK2_CHIEF_MOCK=1 的模拟行为） */
  function mockChiefReply(message: string): string {
    if (/excel|表头|格式/i.test(message)) {
      return '可以。我核对了现有的规则和契约，把变更整理成了一张审批卡片，你看下明细，没问题就批准，我马上派发。'
    }
    if (/卡片|批准|审批/.test(message)) {
      return '当前有待批准的卡片就在对话里，确认后点「批准并派发」；要改的地方直接告诉我。'
    }
    return '收到。我先对照现有的规则和契约核一遍；需要动文档的话，我会整理成审批卡片给你确认。'
  }

  const ledgerOf = (slug: string): MockLedger => mustFind(ledgers, slug, '项目')
  const blocksOf = (slug: string): Record<string, Block> => mustFind(blocksBySlug, slug, '项目')
  const currentRound = (ledger: MockLedger): RoundInfo => {
    const open = ledger.rounds.find((r) => r.closed_at === null)
    if (!open) throw new ApiError(409, { code: 'conflict', message: '没有进行中的轮次（mock）' })
    return open
  }

  function pushEvent(ledger: MockLedger, round: number, actor: EventActor, type: string, ref: Record<string, string>, payload: Record<string, unknown> = {}): Event {
    const e: Event = {
      id: `E-${String(++ledger.seq.event).padStart(4, '0')}`,
      ts: now(),
      round,
      actor,
      type,
      ref,
      payload,
    }
    ledger.events.push(e)
    return e
  }

  /** 任务结束：把回执折成 report，并写 task.report 事件（契约 v0.6） */
  function emitReport(ledger: MockLedger, round: number, task: Task, quality: 'structured' | 'manual'): void {
    if (!task.receipt) return
    task.receipt.report = {
      status: 'done',
      summary: task.receipt.summary,
      files_changed: task.receipt.files_changed,
      issues: [],
      parse_quality: quality,
    }
    const master = task.master ?? 'frontend'
    pushEvent(ledger, round, `master:${master}` as EventActor, 'task.report', { task: task.task_id },
      { ...buildReportPayload(task.task_id, master, task.receipt.report, task.duration_ms ?? null) })
  }

  function pushActivity(master: string, kind: ActivityItem['kind'], text: string, meta?: string): void {
    const list = (activityByMaster[master] ??= [])
    list.push({ id: `A-${++activitySeq}`, ts: now(), kind, text, meta })
  }

  /**
   * 队列模拟（R-M2 前的演示形态）：一键开始 → 包间串行、包内并行。
   * 每个任务在主代理过程流里产出 思考→工具→文件编辑→完成汇报，并落回执/审计事件。
   */
  function simulateTask(slug: string, pkg: Package, task: Task): void {
    const master = task.master ?? 'frontend'
    const ledger = ledgerOf(slug)
    task.status = 'dispatched'
    taskStart[task.task_id] = Date.now()
    task.watchdog_deadline = new Date(Date.now() + 60 * 60_000).toISOString()
    pushEvent(ledger, pkg.round, `master:${master}` as EventActor, 'task.dispatched', { task: task.task_id }, {})
    pushActivity(master, 'note', `收到任务 ${task.task_id}（${pkg.package_id}${pkg.origin === 'tech' ? ' · 技术单' : ''}）`)

    const files = master === 'backend'
      ? ['backend/api/export.py', 'backend/services/export.py']
      : ['web/src/components/Export.vue', 'web/src/api/client.ts']
    const summary = `按任务 ${task.task_id} 完成${pkg.origin === 'tech' ? '技术调整' : '变更'}实现`

    setTimeout(() => {
      task.status = 'running'
      pushActivity(master, 'thinking', `思考了 ${(1 + Math.random() * 2).toFixed(1)} 秒`)
    }, 700)
    setTimeout(() => {
      pushActivity(master, 'tool', 'Bash', master === 'backend' ? 'pytest -q（全部通过）' : 'npm run build（通过）')
    }, 1700)
    files.forEach((file, i) => {
      setTimeout(() => {
        pushActivity(master, 'edit', file, `+${8 + Math.floor(Math.random() * 40)} -${1 + Math.floor(Math.random() * 8)}`)
      }, 2400 + i * 500)
    })
    setTimeout(() => {
      task.status = 'reported'
      task.receipt = {
        files_changed: files,
        self_check: master === 'backend' ? 'pytest 全绿' : 'npm run build 通过',
        summary,
      }
      recordTelemetry(task)
      pushEvent(ledger, pkg.round, `master:${master}` as EventActor, 'task.receipt', { task: task.task_id }, {})
      emitReport(ledger, pkg.round, task, 'structured')
      pushActivity(master, 'message', `已完成：${summary}（改动 ${files.length} 个文件）`)
    }, 4400)
    setTimeout(() => {
      task.status = 'done'
      pushEvent(ledger, pkg.round, 'audit', 'audit.machine.passed', { task: task.task_id }, { note: '契约测试通过' })
    }, 5600)
  }

  function runNextPackage(slug: string, idx: number): void {
    const pkgs = ledgers[slug]?.packages ?? []
    if (idx >= pkgs.length) {
      queueRunning = false
      return
    }
    const pkg = pkgs[idx]
    const finished = pkg.tasks.length > 0 && pkg.tasks.every((t) => t.status === 'done' || t.status === 'rejected')
    if (finished) {
      runNextPackage(slug, idx + 1)
      return
    }
    for (const task of pkg.tasks) {
      if (task.status === 'queued' || task.status === 'timeout') simulateTask(slug, pkg, task)
    }
    setTimeout(() => runNextPackage(slug, idx + 1), 6600)
  }

  /** 看门狗：读取路径顺带巡检，到期未回执的 dispatched/running 任务标记 timeout（§9.4） */
  function tickWatchdogs(ledger: MockLedger): void {
    const ts = Date.now()
    for (const pkg of ledger.packages) {
      for (const task of pkg.tasks) {
        if (
          (task.status === 'dispatched' || task.status === 'running') &&
          task.watchdog_deadline &&
          new Date(task.watchdog_deadline).getTime() <= ts
        ) {
          task.status = 'timeout'
          pushEvent(ledger, pkg.round, 'system', 'task.timeout', { task: task.task_id }, {})
        }
      }
    }
  }

  /** 应用卡片 ops 到模块草稿；返回每个模块的 {hasBreaking, hasAdd, delta 文案} */
  function applyOps(ledger: MockLedger, blocks: Record<string, Block>, card: CardSubmission): Map<string, { breaking: boolean; added: boolean; summary: string }> {
    const per = new Map<string, { m: number; a: number; r: number; breaking: boolean; added: boolean }>()
    const stat = (id: string) => {
      if (!per.has(id)) per.set(id, { m: 0, a: 0, r: 0, breaking: false, added: false })
      return per.get(id)!
    }
    for (const op of card.rule_ops) {
      const block = blocks[op.block_id]
      if (!block) throw new ApiError(422, { code: 'validation_error', message: `rule_ops 引用的模块 ${op.block_id} 不存在` })
      const s = stat(op.block_id)
      if (op.op === 'add') {
        const seq = ++ledger.ruleSeqByBlock[block.id]
        const rule: Rule = { id: op.after?.id || `R${seq}`, name: op.after?.name ?? '', detail: op.after?.detail ?? '' }
        block.draft.rules.push(rule)
        s.a++
        s.added = true
      } else if (op.op === 'modify') {
        const idx = block.draft.rules.findIndex((r) => r.id === op.id)
        if (idx < 0) throw new ApiError(422, { code: 'validation_error', message: `规则 ${op.id} 在模块 ${block.id} 不存在` })
        block.draft.rules[idx] = { id: op.id, name: op.after?.name ?? block.draft.rules[idx].name, detail: op.after?.detail ?? block.draft.rules[idx].detail }
        s.m++
      } else {
        const before = block.draft.rules.length
        block.draft.rules = block.draft.rules.filter((r) => r.id !== op.id)
        if (block.draft.rules.length === before) throw new ApiError(422, { code: 'validation_error', message: `规则 ${op.id} 在模块 ${block.id} 不存在` })
        s.r++
      }
    }
    for (const op of card.api_ops) {
      const block = blocks[op.block_id]
      if (!block) throw new ApiError(422, { code: 'validation_error', message: `api_ops 引用的模块 ${op.block_id} 不存在` })
      const s = stat(op.block_id)
      if (op.op === 'remove') {
        const before = block.draft.apis.length
        block.draft.apis = block.draft.apis.filter((a) => a.api !== op.key)
        if (block.draft.apis.length === before) throw new ApiError(422, { code: 'validation_error', message: `契约 ${op.key} 在模块 ${block.id} 不存在` })
        s.r++
        s.breaking = true
      } else {
        const existing = block.draft.apis.find((a) => a.api === op.key)
        if (existing) {
          Object.assign(existing, op.entry ?? existing)
          s.m++
          if (op.breaking) s.breaking = true
        } else {
          if (!op.entry) throw new ApiError(422, { code: 'validation_error', message: `upsert ${op.key} 缺少 entry` })
          block.draft.apis.push(op.entry)
          s.a++
          s.added = true
        }
      }
    }
    const out = new Map<string, { breaking: boolean; added: boolean; summary: string }>()
    for (const [id, s] of per) {
      const parts: string[] = []
      if (s.m) parts.push(`${s.m}改`)
      if (s.a) parts.push(`${s.a}增`)
      if (s.r) parts.push(`${s.r}删`)
      out.set(id, { breaking: s.breaking, added: s.added, summary: parts.join(' ') || '无变更' })
    }
    return out
  }

  const api: ApiClient = {
    health: async () => ({ ok: true }),
    listProjects: async () => ({ items: projects.map((x) => ({ ...x })) }),
    createProject: async (body) => {
      const slug = body.slug?.trim() ?? ''
      const name = body.name?.trim() ?? ''
      if (!SLUG_RE.test(slug)) {
        throw new ApiError(422, { code: 'validation_error', message: 'slug 只允许字母、数字、-、_，长度 1~64' })
      }
      if (!name) {
        throw new ApiError(422, { code: 'validation_error', message: '项目名称必填' })
      }
      if (projects.some((p) => p.slug === slug)) {
        throw new ApiError(409, { code: 'conflict', message: `slug 已存在：${slug}` })
      }
      if (body.working_dir && !(normalizeFsPath(body.working_dir) in FAKE_FS)) {
        throw new ApiError(422, { code: 'validation_error', message: '目录不存在或不是目录' })
      }
      const project: Project = {
        slug,
        name,
        created_at: now(),
        status: 'active',
        working_dir: body.working_dir?.trim() || null,
        chief_provider: body.chief_provider?.trim() || null,
        chief_model: body.chief_model?.trim() || null,
      }
      projects.push(project)
      // 独立账本（物理隔离的 mock 形态）：空树 + 第 1 轮 + 无主代理
      trees[slug] = { items: [] }
      ledgers[slug] = buildLedger(
        {},
        [{ n: 1, opened_at: now(), closed_at: null, approval_card_id: null, versions_manifest: {} }],
        [],
        [],
        [],
      )
      blocksBySlug[slug] = {}
      mastersBySlug[slug] = []
      return { ...project }
    },
    getProject: async (slug) => {
      const ledger = ledgerOf(slug)
      tickWatchdogs(ledger)
      const open = currentRound(ledger)
      const pending = ledger.cards.find((c) => c.status === 'pending') ?? null
      const base = projects.find((p) => p.slug === slug)
      if (!base) throw new ApiError(404, { code: 'not_found', message: `项目 ${slug} 不存在（mock）` })
      return { slug: base.slug, name: base.name, current_round: open.n, open_card: pending ? clone(pending) : null }
    },
    getTree: async (slug) => clone(mustFind(trees, slug, '项目')),
    createDomain: async (slug, body) => {
      const tree = mustFind(trees, slug, '项目')
      const id = `1${++domainSeq}`
      tree.items.push({ id, title: body.title, documents: [] })
      return { id, title: body.title, created_at: now() }
    },
    createDocument: async (slug, body) => {
      const tree = mustFind(trees, slug, '项目')
      const domain = tree.items.find((d) => d.id === body.domain_id)
      if (!domain) throw new ApiError(404, { code: 'not_found', message: `业务域 ${body.domain_id} 不存在（mock）` })
      const id = `2${++documentSeq}`
      domain.documents.push({ id, title: body.title, blocks: [] })
      return { id, domain_id: body.domain_id, title: body.title, created_at: now() }
    },
    createBlock: async (slug, body) => {
      const tree = mustFind(trees, slug, '项目')
      const blocks = blocksOf(slug)
      let document: ProjectTree['items'][number]['documents'][number] | undefined
      for (const domain of tree.items) {
        const found = domain.documents.find((d) => d.id === body.document_id)
        if (found) document = found
      }
      if (!document) throw new ApiError(404, { code: 'not_found', message: `文档 ${body.document_id} 不存在（mock）` })
      const id = `9${++blockSeq}` // 新模块 id 用 9x 段，避开 fixture 的 1/2/3
      const block: Block = { id, title: body.title, status: 'draft', current_published_version: null, draft: emptyDraft(), versions: [] }
      document.blocks.push({ id, title: body.title, status: 'draft', current_published_version: null })
      blocks[id] = block
      return clone(block)
    },
    getBlock: async (slug, id) => clone(mustFind(blocksOf(slug), id, '模块')),
    updateBlockDraft: async (slug, id, draft) => {
      const block = mustFind(blocksOf(slug), id, '模块')
      block.draft = {
        content_md: draft.content_md,
        rules: clone(draft.rules),
        apis: clone(draft.apis),
        nfr_md: draft.nfr_md,
      }
      return clone(block)
    },

    createCard: async (slug, body) => {
      const ledger = ledgerOf(slug)
      const blocks = blocksOf(slug)
      if (!body.statement.说明.trim() || !body.statement.动机.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: 'statement 的说明与动机必填' })
      }
      const round = currentRound(ledger)
      const card: Card = {
        card_id: `C-${String(++ledger.seq.card).padStart(4, '0')}`,
        round: round.n,
        status: 'pending',
        statement: body.statement,
        rule_ops: clone(body.rule_ops),
        api_ops: clone(body.api_ops),
        breaking_count: body.api_ops.filter((o) => o.breaking).length,
        impact: deriveImpact(body),
        risk: { text: '人工起草（M1 模拟主主代理）', verified_by: null },
        decision: null,
      }
      // 校验 ops 引用的模块存在
      for (const op of [...card.rule_ops, ...card.api_ops]) {
        if (!blocks[op.block_id]) {
          throw new ApiError(422, { code: 'validation_error', message: `ops 引用的模块 ${op.block_id} 不存在` })
        }
      }
      ledger.cards.push(card)
      pushEvent(ledger, round.n, 'chief', 'draft.proposed', { card: card.card_id }, {})
      return clone(card)
    },
    listCards: async (slug, status) => {
      const ledger = ledgerOf(slug)
      const cards = status ? ledger.cards.filter((c) => c.status === status) : ledger.cards
      return { items: clone(cards) }
    },
    approveCard: async (slug, id) => {
      const ledger = ledgerOf(slug)
      const blocks = blocksOf(slug)
      const card = ledger.cards.find((c) => c.card_id === id)
      if (!card) throw new ApiError(404, { code: 'not_found', message: `卡片 ${id} 不存在（mock）` })
      if (card.status !== 'pending') throw new ApiError(409, { code: 'conflict', message: `卡片 ${id} 不是待批准态` })
      // 1) 应用 ops → 草稿更新；2) 每个受影响模块产生版本快照（semver）
      const per = applyOps(ledger, blocks, { statement: card.statement, rule_ops: card.rule_ops, api_ops: card.api_ops })
      const versions: ApproveResponse['versions'] = []
      const round = currentRound(ledger)
      const feedVersions: FeedVersion[] = []
      for (const [blockId, stat] of per) {
        const block = blocks[blockId]
        const next = bumpVersion(block.current_published_version, stat.breaking, stat.added)
        const fv: FeedVersion = {
          block_id: blockId,
          version: next,
          round: round.n,
          statement: card.statement,
          delta_summary: stat.summary,
        }
        block.current_published_version = next
        block.status = 'published'
        block.versions.push({ version: next, round: round.n, statement: card.statement, delta_summary: stat.summary })
        versionSnaps[`${blockId}@${next}`] = clone(block.draft)
        feedVersions.push(fv)
        versions.push({ block_id: blockId, version: next, breaking: stat.breaking })
        pushEvent(ledger, round.n, 'system', 'version.published', { block: blockId }, { version: next })
      }
      // 3) 轮次关闭 / 开启（§7.3：批准事件属于它关闭的那一轮）
      card.status = 'approved'
      card.decision = { action: 'approve', ts: now() }
      round.closed_at = now()
      round.approval_card_id = card.card_id
      round.versions_manifest = Object.fromEntries(versions.map((v) => [v.block_id, v.version]))
      ledger.versionsByRound[round.n] = (ledger.versionsByRound[round.n] ?? []).concat(feedVersions)
      ledger.rounds.push({ n: round.n + 1, opened_at: now(), closed_at: null, approval_card_id: null, versions_manifest: {} })
      pushEvent(ledger, round.n, 'human', 'approval.granted', { card: card.card_id }, {})
      // 4) 任务包入队（origin=approval；包内并行，§9.2）
      const masters = card.impact.length > 0 ? card.impact : ['backend', 'frontend']
      const pkg: Package = {
        package_id: `P-${String(++ledger.seq.pkg).padStart(4, '0')}`,
        origin: 'approval',
        round: round.n,
        version_refs: round.versions_manifest,
        tasks: masters.map((master) => ({
          task_id: `T-${String(++ledger.seq.task).padStart(4, '0')}`,
          master,
          status: 'queued' as TaskStatus,
          watchdog_deadline: null,
          receipt: null,
        })),
      }
      ledger.packages.push(pkg)
      pushEvent(ledger, round.n, 'system', 'package.created', { package: pkg.package_id }, {})
      return { versions, closed_round: round.n, package_id: pkg.package_id }
    },
    rejectCard: async (slug, id, body) => {
      const ledger = ledgerOf(slug)
      const card = ledger.cards.find((c) => c.card_id === id)
      if (!card) throw new ApiError(404, { code: 'not_found', message: `卡片 ${id} 不存在（mock）` })
      if (card.status !== 'pending') throw new ApiError(409, { code: 'conflict', message: `卡片 ${id} 不是待批准态` })
      card.status = 'rejected'
      card.decision = { action: 'reject', ts: now(), reason: body.reason }
      pushEvent(ledger, card.round, 'human', 'approval.rejected', { card: card.card_id }, body.reason ? { reason: body.reason } : {})
      return clone(card)
    },

    listRounds: async (slug) => {
      const ledger = ledgerOf(slug)
      tickWatchdogs(ledger)
      return { items: clone(ledger.rounds) }
    },
    getRound: async (slug, n) => {
      const ledger = ledgerOf(slug)
      tickWatchdogs(ledger)
      const info = ledger.rounds.find((r) => r.n === n)
      if (!info) throw new ApiError(404, { code: 'not_found', message: `轮次 #${n} 不存在（mock）` })
      const events = ledger.events.filter((e) => e.round === n)
      const cards = ledger.cards.filter((c) => c.round === n)
      const versions = ledger.versionsByRound[n] ?? []
      return { round: clone(info), events: clone(events), versions: clone(versions), cards: clone(cards) }
    },
    listEvents: async (slug, query) => {
      const ledger = ledgerOf(slug)
      tickWatchdogs(ledger)
      let items = ledger.events
      if (query?.type) items = items.filter((e) => e.type === query.type)
      if (query?.since) items = items.filter((e) => e.id > query.since!)
      return { items: clone(items) }
    },

    listPackages: async (slug) => {
      const ledger = ledgerOf(slug)
      tickWatchdogs(ledger)
      return { items: clone(ledger.packages) }
    },
    dispatchTask: async (slug, taskId, body) => {
      const ledger = ledgerOf(slug)
      const task = findTask(ledger, taskId)
      if (task.status !== 'queued' && task.status !== 'timeout') {
        throw new ApiError(409, { code: 'conflict', message: `任务 ${taskId} 当前状态 ${task.status} 不可派发` })
      }
      const minutes = body?.watchdog_minutes ?? 60
      if (minutes < 1) {
        throw new ApiError(422, { code: 'validation_error', message: 'watchdog_minutes 必须为正数' })
      }
      taskStart[task.task_id] = Date.now()
      task.status = 'dispatched'
      task.watchdog_deadline = new Date(Date.now() + minutes * 60_000).toISOString()
      const round = taskRound(ledger, taskId)
      pushEvent(ledger, round, 'master:backend', 'task.dispatched', { task: taskId }, { watchdog_minutes: minutes })
      return clone(task)
    },
    submitReceipt: async (slug, taskId, body) => {
      const ledger = ledgerOf(slug)
      const task = findTask(ledger, taskId)
      if (task.status !== 'dispatched' && task.status !== 'running') {
        throw new ApiError(409, { code: 'conflict', message: `任务 ${taskId} 当前状态 ${task.status} 不可提交回执` })
      }
      task.status = 'reported'
      task.receipt = clone(body)
      recordTelemetry(task)
      pushEvent(ledger, taskRound(ledger, taskId), 'master:backend', 'task.receipt', { task: taskId }, {})
      emitReport(ledger, taskRound(ledger, taskId), task, 'manual')
      return clone(task)
    },
    auditTask: async (slug, taskId, body) => {
      const ledger = ledgerOf(slug)
      const task = findTask(ledger, taskId)
      if (task.status !== 'reported' && task.status !== 'auditing') {
        throw new ApiError(409, { code: 'conflict', message: `任务 ${taskId} 当前状态 ${task.status} 不可审计` })
      }
      task.status = body.result === 'pass' ? 'done' : 'rejected'
      const round = taskRound(ledger, taskId)
      pushEvent(
        ledger,
        round,
        'audit',
        body.result === 'pass' ? 'audit.machine.passed' : 'audit.machine.failed',
        { task: taskId },
        body.note ? { note: body.note } : {},
      )
      return clone(task)
    },

    createTechOrder: async (slug, body) => {
      const ledger = ledgerOf(slug)
      validateTechOrder(body)
      const round = currentRound(ledger)
      const masters = mastersForScope(body.scope)
      const pkg: Package = {
        package_id: `P-${String(++ledger.seq.pkg).padStart(4, '0')}`,
        origin: 'tech',
        round: round.n,
        version_refs: {},
        tasks: masters.map((master) => ({
          task_id: `T-${String(++ledger.seq.task).padStart(4, '0')}`,
          master,
          status: 'queued' as TaskStatus,
          watchdog_deadline: null,
          receipt: null,
        })),
      }
      ledger.packages.push(pkg)
      const order: TechOrder = {
        order_id: `O-${String(++ledger.seq.order).padStart(4, '0')}`,
        intent: body.intent,
        scope: [...body.scope],
        baseline: body.baseline ? { ...body.baseline } : null,
        acceptance: [...body.acceptance],
        package_id: pkg.package_id,
      }
      ledger.techOrders.push(order)
      pushEvent(ledger, round.n, 'human', 'tech.order', { order: order.order_id }, { package: pkg.package_id })
      return clone(order)
    },

    getConvention: async (slug) => clone(ledgerOf(slug).convention),
    updateConventionDraft: async (slug, body) => {
      const ledger = ledgerOf(slug)
      ledger.convention.draft_md = body.content_md
      return clone(ledger.convention)
    },
    approveConvention: async (slug, body) => {
      const ledger = ledgerOf(slug)
      const conv = ledger.convention
      if (conv.draft_md === null || conv.draft_md.trim() === '') {
        throw new ApiError(409, { code: 'conflict', message: '没有待批准的约定草稿（先 PUT draft）' })
      }
      if (!body.说明.trim() || !body.动机.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: '批准需填写说明与动机' })
      }
      conv.content_md = conv.draft_md
      conv.draft_md = null
      conv.version = bumpVersion(conv.version, false, true)
      conv.statement = { 说明: body.说明, 动机: body.动机 }
      pushEvent(ledger, currentRound(ledger).n, 'human', 'convention.published', {}, { version: conv.version })
      return clone(conv)
    },

    getStats: async (slug) => {
      const ledger = ledgerOf(slug)
      tickWatchdogs(ledger)
      const done = ledger.packages.filter((p) => p.tasks.length > 0 && p.tasks.every((t) => t.status === 'done' || t.status === 'rejected')).length
      const stats: Stats = {
        rounds: { count: ledger.rounds.filter((r) => r.closed_at !== null).length, open: ledger.rounds.filter((r) => r.closed_at === null).length },
        cards: {
          pending: ledger.cards.filter((c) => c.status === 'pending').length,
          approved: ledger.cards.filter((c) => c.status === 'approved').length,
          rejected: ledger.cards.filter((c) => c.status === 'rejected').length,
        },
        packages: { done, active: ledger.packages.length - done },
        tasks: {
          rejected: countTasks(ledger, 'rejected'),
          timeout: countTasks(ledger, 'timeout'),
        },
      }
      return stats
    },

    listMasters: async (slug) => {
      mustFind(ledgers, slug, '项目')
      return { items: (mastersBySlug[slug] ?? []).map((m) => ({ ...m })) }
    },
    createMaster: async (slug, body) => {
      mustFind(ledgers, slug, '项目')
      if (!body.name.trim() || !body.duty.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: '名称与职责必填' })
      }
      // 会话绑定可选（修复单 22）：空 = 开始新对话，与真实后端一致
      if (!body.harness?.trim() || !body.model?.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: 'Harness 与模型必选（从「模型」登记里选）' })
      }
      const master: MasterInfo = {
        id: `m${++masterSeq}`,
        name: body.name.trim(),
        duty: body.duty.trim(),
        dir: body.dir?.trim() || '（待定）',
        harness: body.harness.trim(),
        model: body.model.trim(),
        session: body.session?.trim() || '',
        session_title: sessionTitle(body.session),
      }
      ;(mastersBySlug[slug] ??= []).push(master)
      return { ...master }
    },
    getBlockVersion: async (slug, blockId, version) => {
      const block = mustFind(blocksOf(slug), blockId, '模块')
      const snap = versionSnaps[`${blockId}@${version}`]
      if (!snap) throw new ApiError(404, { code: 'not_found', message: `版本 ${version} 快照不存在` })
      const meta = block.versions.find((v) => v.version === version)
      return {
        block_id: blockId,
        version,
        round: meta?.round ?? 0,
        statement: meta?.statement ?? { 说明: '', 动机: '' },
        delta_summary: meta?.delta_summary ?? null,
        draft: clone(snap),
      }
    },
    startQueue: async (slug) => {
      const ledger = ledgerOf(slug)
      if (queueRunning) return { started: 0 }
      const pending = ledger.packages.filter(
        (p) => p.tasks.length > 0 && !p.tasks.every((t) => t.status === 'done' || t.status === 'rejected'),
      )
      if (pending.length === 0) return { started: 0 }
      queueRunning = true
      runNextPackage(slug, 0)
      return { started: pending.length }
    },

    listModels: async () => ({ items: modelRegistry.map((x) => ({ ...x })) }),
    registerModel: async (body) => {
      const harness = body.harness.trim()
      const model = body.model.trim()
      if (!harness || !model) {
        throw new ApiError(422, { code: 'validation_error', message: 'Harness 与模型都要填' })
      }
      if (modelRegistry.some((x) => x.harness === harness && x.model === model)) {
        throw new ApiError(409, { code: 'conflict', message: `${harness} 已登记过模型 ${model}` })
      }
      const entry: ModelEntry = { id: `mdl-${++modelSeq}`, harness, model, ...(body.provider ? { provider: body.provider } : {}) }
      modelRegistry.push(entry)
      return { ...entry }
    },
    removeModel: async (id) => {
      const idx = modelRegistry.findIndex((x) => x.id === id)
      if (idx < 0) throw new ApiError(404, { code: 'not_found', message: `登记 ${id} 不存在（mock）` })
      modelRegistry.splice(idx, 1)
    },
    // 模型发现（mock）：三种 source 都演到——pi 实查、opencode 静态、未知 harness 没有
    listHarnessModels: async (harness) => {
      const known: Record<string, { models: string[]; source: 'discovered' | 'static' }> = {
        pi: { models: ['minimax-cn/MiniMax-M3', 'zai/glm-4.7'], source: 'discovered' },
        opencode: { models: ['deepseek/deepseek-flash'], source: 'static' },
      }
      const hit = known[harness]
      return hit
        ? { harness, models: hit.models, source: hit.source }
        : { harness, models: [], source: 'none' }
    },
    listProviders: async () => ({ items: providers.map((p) => ({ ...p })) }),
    putProvider: async (name, apiKey) => {
      if (!/^[a-z0-9-]+$/.test(name)) {
        throw new ApiError(422, { code: 'validation_error', message: '服务商名只允许小写字母、数字、连字符' })
      }
      if (!apiKey.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: 'API key 必填' })
      }
      const hit = providers.find((p) => p.name === name)
      if (hit) hit.has_key = true
      else providers.push({ name, has_key: true })
      return { name, has_key: true }
    },
    deleteProvider: async (name) => {
      const idx = providers.findIndex((p) => p.name === name)
      if (idx < 0) throw new ApiError(404, { code: 'not_found', message: `服务商 ${name} 不存在（mock）` })
      providers.splice(idx, 1)
    },
    probeProvider: async (name): Promise<ProviderProbe> => {
      const hit = providers.find((p) => p.name === name)
      if (!hit) return { name, ok: false, models: [], error: `服务商 ${name} 不存在（mock）` }
      if (!hit.has_key) return { name, ok: false, models: [], error: '未配置 API key（mock）' }
      const known: Record<string, Array<{ id: string; thinking?: boolean }>> = {
        'minimax-cn': [{ id: 'MiniMax-M3', thinking: false }],
        deepseek: [
          { id: 'deepseek-chat', thinking: false },
          { id: 'deepseek-reasoner', thinking: true },
        ],
      }
      return { name, ok: true, models: known[name] ?? [{ id: `${name}-chat`, thinking: false }], error: null }
    },
    listCliSessions: async (cwd) => {
      const dir = cwd ? normalizeFsPath(cwd) : null
      const items = dir
        ? FALLBACK_CLI_SESSIONS.filter((s) => s.cwd === dir || s.cwd.startsWith(`${dir}/`))
        : FALLBACK_CLI_SESSIONS
      return { items: items.map(({ cwd: _cwd, ...rest }) => ({ ...rest })) }
    },

    sendChat: async (slug, body) => {
      if (!body.message.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: 'message 不能为空' })
      }
      const ledger = ledgerOf(slug)
      const round = currentRound(ledger)
      pushEvent(ledger, round.n, 'human', 'chat.human', {}, { message: body.message })
      const reply = mockChiefReply(body.message)
      await new Promise((resolve) => setTimeout(resolve, 900))
      pushEvent(ledger, round.n, 'chief', 'chat.chief', {}, { message: reply })
      return { ok: true, reply }
    },
    getAgent: async (slug) => ({
      running: agentRunning,
      model: agentRunning ? agentModel : null,
      context_usage_percent: agentRunning ? 46 : null,
      session_id: `speclock2-${slug}`,
    }),
    startAgent: async (slug) => {
      agentRunning = true
      roles.onSessionRestart(slug)
      return { running: true, model: agentModel, session_id: `speclock2-${slug}` }
    },
    stopAgent: async (slug) => {
      agentRunning = false
      return { running: false, model: null, session_id: `speclock2-${slug}` }
    },
    resetAgent: async (slug) => {
      roles.onSessionRestart(slug)
      return { ok: true }
    },
    setAgentModel: async (_slug, body) => {
      if (!agentRunning) {
        throw new ApiError(409, { code: 'conflict', message: '核心代理会话未运行' })
      }
      if (!body.model?.trim()) {
        throw new ApiError(422, { code: 'validation_error', message: 'model 必填' })
      }
      agentModel = body.provider ? `${body.provider}/${body.model}` : body.model
      return { ok: true, model: agentModel }
    },

    patchProject: async (slug, body) => {
      const project = projects.find((x) => x.slug === slug)
      if (!project) throw new ApiError(404, { code: 'not_found', message: `项目 ${slug} 不存在（mock）` })
      if (body.working_dir !== undefined) {
        if (body.working_dir === null) project.working_dir = null
        else {
          const dir = normalizeFsPath(body.working_dir)
          if (!(dir in FAKE_FS)) throw new ApiError(422, { code: 'validation_error', message: '目录不存在或不是目录' })
          project.working_dir = dir
        }
      }
      if (body.chief_provider !== undefined) project.chief_provider = body.chief_provider?.trim() || null
      if (body.chief_model !== undefined) project.chief_model = body.chief_model?.trim() || null
      return { ...project }
    },
    listFsDirs: async (path) => {
      const dir = normalizeFsPath(path)
      const children = FAKE_FS[dir]
      if (!children) throw new ApiError(422, { code: 'validation_error', message: '目录不存在或不是目录' })
      return { items: children.map((p) => ({ name: p.slice(p.replace(/\/$/, '').lastIndexOf('/') + 1), path: p })) }
    },

    deleteProject: async (slug) => {
      const idx = projects.findIndex((x) => x.slug === slug)
      if (idx < 0) throw new ApiError(404, { code: 'not_found', message: `项目 ${slug} 不存在（mock）` })
      projects.splice(idx, 1)
      delete trees[slug]
      delete ledgers[slug]
      delete blocksBySlug[slug]
      delete mastersBySlug[slug]
    },

    updateMaster: async (slug, id, body) => {
      const masters = mastersBySlug[slug] ?? []
      const master = masters.find((m) => m.id === id)
      if (!master) throw new ApiError(404, { code: 'not_found', message: `主代理 ${id} 不存在（mock）` })
      const name = body.name?.trim() ?? master.name
      const duty = body.duty?.trim() ?? master.duty
      if (!name || !duty) throw new ApiError(422, { code: 'validation_error', message: '名称与职责必填' })
      const harness = body.harness?.trim() || master.harness
      const model = body.model?.trim() || master.model
      if (!harness || !model) throw new ApiError(422, { code: 'validation_error', message: 'Harness 与模型必选（从「模型」登记里选）' })
      if (masters.some((m) => m.id !== id && m.name === name)) {
        throw new ApiError(409, { code: 'conflict', message: `同名主代理已存在：${name}` })
      }
      const session = body.session?.trim() || master.session || ''
      master.name = name
      master.duty = duty
      master.dir = body.dir?.trim() || master.dir
      master.harness = harness
      master.model = model
      master.session = session
      master.session_title = sessionTitle(session)
      return { ...master }
    },
    listRoles: (slug) => roles.listRoles(slug, (mastersBySlug[slug] ?? []).map((m) => m.name)),
    getRole: (slug, target) => roles.getRole(slug, target),
    putRole: (slug, target, content) => roles.putRole(slug, target, content),
    resetRole: (slug, target) => roles.resetRole(slug, target),
    previewRole: (slug, target) => roles.previewRole(slug, target),
    getProtocol: async () => ({ ...MOCK_PROTOCOL }),
    deleteMaster: async (slug, id) => {
      const masters = mastersBySlug[slug] ?? []
      const idx = masters.findIndex((m) => m.id === id)
      if (idx < 0) throw new ApiError(404, { code: 'not_found', message: `主代理 ${id} 不存在（mock）` })
      const busy = ledgers[slug]?.packages.some((p) =>
        p.tasks.some((t) => t.master === id && !['done', 'rejected'].includes(t.status)),
      )
      if (busy) throw new ApiError(409, { code: 'conflict', message: '该主代理有在跑的任务，等任务结束或先处理任务再删除' })
      masters.splice(idx, 1)
    },

    auditAll: async (slug) => {
      const ledger = ledgerOf(slug)
      let updated = 0
      for (const pkg of ledger.packages) {
        for (const t of pkg.tasks) {
          if (t.status === 'reported' || t.status === 'auditing') {
            t.status = 'done'
            pushEvent(ledger, pkg.round, 'audit', 'audit.machine.passed', { task: t.task_id }, { note: '批量验收（audit-all）' })
            updated++
          }
        }
      }
      return { updated }
    },
  }

  bindMockRuntime(
    () => Object.fromEntries(Object.entries(activityByMaster).map(([k, v]) => [k, [...v]])),
    () => queueRunning,
  )
  return api
}

/* ---------- mock 专用展示层出口（App/MasterSession 直接读取） ---------- */

let readActivity: () => Record<string, ActivityItem[]> = () => ({})
let readQueueRunning: () => boolean = () => false

/** 由 createMockApiClient 绑定（模块级单例读取口） */
function bindMockRuntime(activity: () => Record<string, ActivityItem[]>, running: () => boolean): void {
  readActivity = activity
  readQueueRunning = running
}

/** 主代理过程流快照（仅 mock 模式有数据） */
export function getMockActivity(): Record<string, ActivityItem[]> {
  return readActivity()
}

/** 队列模拟是否执行中（仅 mock 模式） */
export function isMockQueueRunning(): boolean {
  return readQueueRunning()
}

/* ---------- mock 内部辅助 ---------- */

function findTask(ledger: MockLedger, taskId: string): Task {
  for (const pkg of ledger.packages) {
    const task = pkg.tasks.find((t) => t.task_id === taskId)
    if (task) return task
  }
  throw new ApiError(404, { code: 'not_found', message: `任务 ${taskId} 不存在（mock）` })
}

function taskRound(ledger: MockLedger, taskId: string): number {
  for (const pkg of ledger.packages) {
    if (pkg.tasks.some((t) => t.task_id === taskId)) return pkg.round
  }
  return currentRoundOf(ledger)
}

function currentRoundOf(ledger: MockLedger): number {
  const open = ledger.rounds.find((r) => r.closed_at === null)
  return open ? open.n : (ledger.rounds.at(-1)?.n ?? 0)
}

function countTasks(ledger: MockLedger, status: TaskStatus): number {
  let n = 0
  for (const pkg of ledger.packages) for (const t of pkg.tasks) if (t.status === status) n++
  return n
}

function deriveImpact(body: CardSubmission): string[] {
  if (body.api_ops.length > 0) return ['frontend', 'backend']
  if (body.rule_ops.length > 0) return ['backend']
  return []
}

function mastersForScope(scope: string[]): string[] {
  const masters = new Set<string>()
  for (const s of scope) {
    if (s.startsWith('web')) masters.add('frontend')
    else if (s.startsWith('backend')) masters.add('backend')
  }
  if (masters.size === 0) {
    masters.add('frontend')
    masters.add('backend')
  }
  return [...masters]
}

function validateTechOrder(body: CreateTechOrderBody): void {
  if (!body.intent.trim()) throw new ApiError(422, { code: 'validation_error', message: 'intent 不能为空' })
  if (body.scope.length === 0) throw new ApiError(422, { code: 'validation_error', message: 'scope 至少一项' })
  if (body.acceptance.length === 0) throw new ApiError(422, { code: 'validation_error', message: 'acceptance 至少一项' })
}
