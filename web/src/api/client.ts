/**
 * SpecLock 2 前端 API 层（M1-S2，契约 v0.2）
 *
 * 覆盖 DEV-PLAN.md §2「API 契约 v0.2」全部端点的 TypeScript 类型与调用函数。
 * 通用约定（契约 §2）：
 *  - 所有响应 JSON；错误 envelope {code, message, details}，HTTP 状态码与语义一致；
 *  - 时间 ISO 8601 带时区字符串；对外 id 一律字符串；
 *  - 列表统一 {items: [...]} 包裹。
 */

/* ---------- 基础形状 ---------- */

export interface HealthResponse {
  ok: boolean
}

export interface ErrorEnvelope {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface Project {
  slug: string
  name: string
  created_at: string
  status: string
  /** 项目目录（该项目主代理的工作领地；契约 v0.4，旧后端可能缺省） */
  working_dir?: string | null
  /** 核心代理 LLM（契约 v0.4；null = 跟随全局配置） */
  chief_provider?: string | null
  chief_model?: string | null
}

export interface ProjectDetail {
  slug: string
  name: string
  current_round: number
  open_card: Card | null
}

/** 业务变更说明书（DESIGN.md §6.2：说明/动机人审，影响由系统生成不手写） */
export interface Statement {
  说明: string
  动机: string
  /** Bug 修复版本引用的被违反规则 ID（DESIGN.md §6.5），可选 */
  违反?: string[]
}

/* ---------- 文档系统（DESIGN.md §5） ---------- */

export interface Rule {
  id: string
  name: string
  detail: string
}

export type ApiFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export interface ApiField {
  name: string
  type: ApiFieldType
  required: boolean
  description: string
  children?: ApiField[]
}

export interface ApiEntry {
  name: string
  api: string
  desc: string
  request: ApiField[]
  response: ApiField[]
}

export interface BlockDraft {
  content_md: string
  rules: Rule[]
  apis: ApiEntry[]
  nfr_md: string
}

export interface BlockVersionInfo {
  version: string
  round: number
  statement: Statement
  delta_summary: string | null
}

export interface Block {
  id: string
  title: string
  status: 'draft' | 'published'
  current_published_version: string | null
  draft: BlockDraft
  versions: BlockVersionInfo[]
}

/* ---------- 三层树（GET /api/p/{slug}/tree） ---------- */

export interface TreeBlockNode {
  id: string
  title: string
  status: 'draft' | 'published'
  current_published_version: string | null
}

export interface TreeDocumentNode {
  id: string
  title: string
  blocks: TreeBlockNode[]
}

export interface TreeDomainNode {
  id: string
  title: string
  documents: TreeDocumentNode[]
}

export interface ProjectTree {
  items: TreeDomainNode[]
}

/* ---------- 审批卡片（DESIGN.md §8，契约 v0.2：ops 携带 block_id） ---------- */

export interface RuleOp {
  op: 'add' | 'modify' | 'remove'
  block_id: string
  id: string
  before: Rule | null
  after: Rule | null
}

export interface ApiOp {
  op: 'upsert' | 'remove'
  block_id: string
  key: string
  entry: ApiEntry | null
  breaking: boolean
  /**
   * 以下三个为展示层补充字段：契约 v0.2 的 ApiOp 未定义，语义来自 DESIGN.md §8.2 的
   * changes（"请求 +format(string)" 这类 diff 行文案）。已记入回执「契约疑问」，
   * 待 PM 裁决由服务端下发还是前端从 entry 计算。
   */
  existed?: boolean
  changes?: string[]
  breaking_changes?: string[]
}

export type CardStatus = 'pending' | 'approved' | 'rejected'

export interface CardRisk {
  text: string
  verified_by: 'audit' | null
}

export interface TaskPreviewItem {
  master: string
}

export interface Card {
  card_id: string
  round: number
  status: CardStatus
  statement: Statement
  rule_ops: RuleOp[]
  api_ops: ApiOp[]
  breaking_count: number
  impact: string[]
  /** 提交方未携带 risk 时后端存 null（backend S2 实测） */
  risk: CardRisk | null
  /** 以下字段契约 v0.2 的 Card 未列（见 DESIGN.md §8.2），均为可选，记入回执「契约疑问」 */
  convention_ops?: unknown[]
  task_preview?: TaskPreviewItem[]
  narration_event?: string
  decision?: unknown
}

/** POST /api/p/{slug}/cards 请求体：statement 必填 + 两组 ops */
export interface CardSubmission {
  statement: Statement
  rule_ops: RuleOp[]
  api_ops: ApiOp[]
}

/** POST /cards/{id}/approve 响应（契约 v0.2） */
export interface ApproveResponse {
  versions: Array<{ block_id: string; version: string; breaking: boolean }>
  closed_round: number
  package_id: string
}

/* ---------- 事件与轮次（DESIGN.md §7） ---------- */

export type EventActor = 'human' | 'chief' | 'audit' | 'system' | `master:${string}`

export interface Event {
  id: string
  ts: string
  round: number
  actor: EventActor
  type: string
  ref: Record<string, string>
  payload: Record<string, unknown>
}

export interface RoundInfo {
  n: number
  opened_at: string
  closed_at: string | null
  approval_card_id: string | null
  versions_manifest: Record<string, string>
}

/** 轮次内发布的版本（GET /rounds/{n}.versions 元素；block_id 用于定位模块） */
export interface FeedVersion extends BlockVersionInfo {
  block_id: string
}

/**
 * GET /api/p/{slug}/rounds/{n} 渲染源（backend S2 实测：外层带完整 RoundInfo，
 * versions 元素含 block_id）
 */
export interface RoundDetail {
  round: RoundInfo
  events: Event[]
  versions: FeedVersion[]
  cards: Card[]
}

/* ---------- 任务包与任务（DESIGN.md §9，契约 v0.2） ---------- */

export type TaskStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'reported'
  | 'auditing'
  | 'done'
  | 'rejected'
  | 'timeout'

export interface TaskReceipt {
  files_changed: string[]
  self_check: string
  summary: string
}

export interface Task {
  task_id: string
  /** 技术单任务派发前 master 待定（backend S2：master 可为 null） */
  master: string | null
  status: TaskStatus
  watchdog_deadline: string | null
  receipt: TaskReceipt | null
  /** 过程遥测（DESIGN §13.5：派发→回执的耗时与 token 消耗；token 为估算，R-M2 接真实数据） */
  duration_ms?: number | null
  tokens?: number | null
}

export interface Package {
  package_id: string
  origin: 'approval' | 'tech'
  round: number
  version_refs: Record<string, string>
  tasks: Task[]
}

/* ---------- 技术任务单（DESIGN.md §6.4） ---------- */

export interface TechOrder {
  order_id: string
  intent: string
  scope: string[]
  baseline: Record<string, string> | null
  acceptance: string[]
  package_id: string
}

export interface CreateTechOrderBody {
  intent: string
  scope: string[]
  baseline?: Record<string, string>
  acceptance: string[]
}

/* ---------- 全局约定（DESIGN.md §5.5，契约 v0.2） ---------- */

export interface Convention {
  /** 首次批准前没有版本（backend S2：version/content_md 可为 null） */
  version: string | null
  content_md: string | null
  draft_md: string | null
  statement: Statement | null
}

/* ---------- 仪表盘统计（契约 v0.2） ---------- */

export interface Stats {
  rounds: { count: number; open: number }
  cards: { pending: number; approved: number; rejected: number }
  packages: { done: number; active: number }
  tasks: { rejected: number; timeout: number }
}

/* ---------- 主代理注册（R-M2 前由前端 mock 承载；端点为提议形状） ---------- */

export interface MasterInfo {
  id: string
  name: string
  /** 职责：一句话说清负责什么 */
  duty: string
  /** 目录所有权，如 backend/ */
  dir: string
  harness: string
  /** 使用的模型（主代理挂在强模型上；只能从「模型登记」里选） */
  model: string
  /** 绑定的 CLI 会话 id（唤醒后接续该会话工作） */
  session?: string | null
  /** 会话标题（展示用；mock 由 CLI 会话表联出） */
  session_title?: string | null
}

export interface CreateMasterBody {
  name: string
  duty: string
  dir?: string
  harness?: string
  model?: string
  session?: string
}

/* ---------- Harness 模型登记（工作台只唤醒 Harness，不替它配模型；端点为提议形状） ---------- */

/** 一条登记：Harness × 模型（纯信息记录，添加主代理时从这里选） */
export interface ModelEntry {
  id: string
  harness: string
  model: string
}

export interface RegisterModelBody {
  harness: string
  model: string
}

/** CLI 会话（读取 CLI 内部的会话列表，主代理创建时选定一个绑定） */
export interface CliSession {
  id: string
  title: string
  updated_at: string
}

/* ---------- 对话与核心代理会话（契约 v0.3，R-M2） ---------- */

export interface ChatBody {
  message: string
}

/** POST /chat 同步返回（权威定稿也经 SSE message_final 推送） */
export interface ChatResponse {
  ok: boolean
  reply: string
}

export interface AgentStatus {
  running: boolean
  model: string | null
  context_usage_percent: number | null
  session_id: string
}

export interface AgentStartResponse {
  running: boolean
  model: string | null
  session_id: string
}

/** POST /agent/model（契约 v0.5）：provider 缺省 = 只按 model 切；未运行 409 */
export interface AgentModelBody {
  provider?: string
  model: string
}

export interface AgentModelResponse {
  ok: boolean
  model: string
}

/* ---------- 版本快照详情（查看版本：当时那份 API/业务；端点为提议形状） ---------- */

export interface VersionDetail {
  block_id: string
  version: string
  round: number
  statement: Statement
  delta_summary: string | null
  draft: BlockDraft
}

/* ---------- 请求体 ---------- */

export interface CreateProjectBody {
  slug: string
  name: string
  working_dir?: string
  chief_provider?: string
  chief_model?: string
}

/** PATCH /api/p/{slug}：只更新出现的字段；null 表示清除（回执「契约疑问」：清除语义待裁决） */
export interface PatchProjectBody {
  working_dir?: string | null
  chief_provider?: string | null
  chief_model?: string | null
}

/** GET /api/fs/dirs?path= 的子目录条目（契约 v0.4） */
export interface FsDirEntry {
  name: string
  path: string
}

export interface CreateDomainBody {
  title: string
}

export interface CreateDocumentBody {
  domain_id: string
  title: string
}

export interface CreateBlockBody {
  document_id: string
  title: string
}

/** 创建端点响应体（契约端点表未列，形状对齐 backend S0 的 serialize 实现） */
export interface DomainCreated {
  id: string
  title: string
  created_at: string
}

export interface DocumentCreated {
  id: string
  domain_id: string
  title: string
  created_at: string
}

export interface RejectCardBody {
  reason?: string
}

export interface DispatchBody {
  watchdog_minutes?: number
}

export interface AuditBody {
  result: 'pass' | 'fail'
  note?: string
}

export interface ConventionDraftBody {
  content_md: string
}

export interface ApproveConventionBody {
  说明: string
  动机: string
}

export interface ListEventsQuery {
  since?: string
  type?: string
}

/* ---------- 错误与请求工具 ---------- */

export class ApiError extends Error {
  readonly status: number
  readonly envelope: ErrorEnvelope

  constructor(status: number, envelope: ErrorEnvelope) {
    super(`[${status}] ${envelope.code}: ${envelope.message}`)
    this.name = 'ApiError'
    this.status = status
    this.envelope = envelope
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  let res: Response
  try {
    // timeoutMs：超时中止（fetch 悬挂时不至于永久等待）；未指定则不限时
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, signal, ...init })
  } catch (err) {
    // 网络层失败（后端不可达、连接被拒、超时等）
    throw new ApiError(0, {
      code: 'network_error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
  if (!res.ok) {
    let envelope: ErrorEnvelope = { code: `http_${res.status}`, message: `${res.status} ${res.statusText}` }
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object' && 'code' in body && 'message' in body) {
        envelope = body as ErrorEnvelope
      }
    } catch {
      // 非 JSON 错误体（如代理 500 文本），保留兜底 envelope
    }
    throw new ApiError(res.status, envelope)
  }
  return (await res.json()) as T
}

function withQuery(path: string, query?: ListEventsQuery | { status?: CardStatus }): string {
  if (!query) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query as Record<string, string | undefined>)) {
    if (v !== undefined && v !== '') qs.set(k, v)
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/* ---------- 客户端接口（live 与 mock 共同实现） ---------- */

/** 契约 v0.2 全端点（路径与语义见 DEV-PLAN.md §2 端点表） */
export interface ApiClient {
  health(): Promise<HealthResponse>
  listProjects(): Promise<{ items: Project[] }>
  createProject(body: CreateProjectBody): Promise<Project>
  getProject(slug: string): Promise<ProjectDetail>
  getTree(slug: string): Promise<ProjectTree>
  createDomain(slug: string, body: CreateDomainBody): Promise<DomainCreated>
  createDocument(slug: string, body: CreateDocumentBody): Promise<DocumentCreated>
  createBlock(slug: string, body: CreateBlockBody): Promise<Block>
  getBlock(slug: string, id: string): Promise<Block>
  updateBlockDraft(slug: string, id: string, draft: BlockDraft): Promise<Block>
  createCard(slug: string, body: CardSubmission): Promise<Card>
  listCards(slug: string, status?: CardStatus): Promise<{ items: Card[] }>
  approveCard(slug: string, id: string): Promise<ApproveResponse>
  rejectCard(slug: string, id: string, body: RejectCardBody): Promise<Card>
  listRounds(slug: string): Promise<{ items: RoundInfo[] }>
  getRound(slug: string, n: number): Promise<RoundDetail>
  listEvents(slug: string, query?: ListEventsQuery): Promise<{ items: Event[] }>
  listPackages(slug: string): Promise<{ items: Package[] }>
  dispatchTask(slug: string, taskId: string, body?: DispatchBody): Promise<Task>
  submitReceipt(slug: string, taskId: string, body: TaskReceipt): Promise<Task>
  auditTask(slug: string, taskId: string, body: AuditBody): Promise<Task>
  createTechOrder(slug: string, body: CreateTechOrderBody): Promise<TechOrder>
  getConvention(slug: string): Promise<Convention>
  updateConventionDraft(slug: string, body: ConventionDraftBody): Promise<Convention>
  approveConvention(slug: string, body: ApproveConventionBody): Promise<Convention>
  getStats(slug: string): Promise<Stats>
  listMasters(slug: string): Promise<{ items: MasterInfo[] }>
  createMaster(slug: string, body: CreateMasterBody): Promise<MasterInfo>
  getBlockVersion(slug: string, blockId: string, version: string): Promise<VersionDetail>
  startQueue(slug: string): Promise<{ started: number }>
  /** Harness×模型登记（全局，不挂项目；后端未提供时 UI 用内置登记兜底） */
  listModels(): Promise<{ items: ModelEntry[] }>
  registerModel(body: RegisterModelBody): Promise<ModelEntry>
  removeModel(id: string): Promise<void>
  listCliSessions(): Promise<{ items: CliSession[] }>
  /** 对话（R-M2）：发送后回复经 SSE 流式推送；本端点同步返回定稿兜底 */
  sendChat(slug: string, body: ChatBody): Promise<ChatResponse>
  getAgent(slug: string): Promise<AgentStatus>
  startAgent(slug: string): Promise<AgentStartResponse>
  stopAgent(slug: string): Promise<AgentStartResponse>
  setAgentModel(slug: string, body: AgentModelBody): Promise<AgentModelResponse>
  /** 项目目录与核心代理 LLM（契约 v0.4；旧后端未上线时 UI 优雅降级） */
  patchProject(slug: string, body: PatchProjectBody): Promise<Project>
  listFsDirs(path: string): Promise<{ items: FsDirEntry[] }>
}

/** live 客户端：同源 fetch（dev 由 Vite 代理 /api → http://127.0.0.1:8000） */
export function createApiClient(): ApiClient {
  const p = (slug: string): string => `/api/p/${slug}`
  return {
    health: () => request<HealthResponse>('/api/health', undefined, 8_000),
    listProjects: () => request<{ items: Project[] }>('/api/projects'),
    createProject: (body) =>
      request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
    getProject: (slug) => request<ProjectDetail>(p(slug)),
    getTree: (slug) => request<ProjectTree>(`${p(slug)}/tree`),
    createDomain: (slug, body) =>
      request<DomainCreated>(`${p(slug)}/domains`, { method: 'POST', body: JSON.stringify(body) }),
    createDocument: (slug, body) =>
      request<DocumentCreated>(`${p(slug)}/documents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createBlock: (slug, body) =>
      request<Block>(`${p(slug)}/blocks`, { method: 'POST', body: JSON.stringify(body) }),
    getBlock: (slug, id) => request<Block>(`${p(slug)}/blocks/${id}`),
    updateBlockDraft: (slug, id, draft) =>
      request<Block>(`${p(slug)}/blocks/${id}`, { method: 'PUT', body: JSON.stringify(draft) }),
    createCard: (slug, body) =>
      request<Card>(`${p(slug)}/cards`, { method: 'POST', body: JSON.stringify(body) }),
    listCards: (slug, status) => request<{ items: Card[] }>(withQuery(`${p(slug)}/cards`, { status })),
    approveCard: (slug, id) => request<ApproveResponse>(`${p(slug)}/cards/${id}/approve`, { method: 'POST' }),
    rejectCard: (slug, id, body) =>
      request<Card>(`${p(slug)}/cards/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listRounds: (slug) => request<{ items: RoundInfo[] }>(`${p(slug)}/rounds`),
    getRound: (slug, n) => request<RoundDetail>(`${p(slug)}/rounds/${n}`),
    listEvents: (slug, query) => request<{ items: Event[] }>(withQuery(`${p(slug)}/events`, query)),
    listPackages: (slug) => request<{ items: Package[] }>(`${p(slug)}/packages`),
    dispatchTask: (slug, taskId, body) =>
      request<Task>(`${p(slug)}/tasks/${taskId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify(body ?? {}),
      }),
    submitReceipt: (slug, taskId, body) =>
      request<Task>(`${p(slug)}/tasks/${taskId}/receipt`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    auditTask: (slug, taskId, body) =>
      request<Task>(`${p(slug)}/tasks/${taskId}/audit`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createTechOrder: (slug, body) =>
      request<TechOrder>(`${p(slug)}/tech-orders`, { method: 'POST', body: JSON.stringify(body) }),
    getConvention: (slug) => request<Convention>(`${p(slug)}/conventions`),
    updateConventionDraft: (slug, body) =>
      request<Convention>(`${p(slug)}/conventions/draft`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    approveConvention: (slug, body) =>
      // 兼容双形状：契约 v0.2 是平铺 {说明,动机}，backend S2 实现为嵌套 {statement:{…}}
      // （双方都已记契约疑问，待 PM 裁决后收敛）
      request<Convention>(`${p(slug)}/conventions/approve`, {
        method: 'POST',
        body: JSON.stringify({ ...body, statement: { 说明: body.说明, 动机: body.动机 } }),
      }),
    getStats: (slug) => request<Stats>(`${p(slug)}/stats`),
    // 以下为 R-M2 前的前端提议端点：后端未提供时 UI 优雅降级（记回执）
    listMasters: (slug) => request<{ items: MasterInfo[] }>(`${p(slug)}/masters`),
    createMaster: (slug, body) =>
      request<MasterInfo>(`${p(slug)}/masters`, { method: 'POST', body: JSON.stringify(body) }),
    getBlockVersion: (slug, blockId, version) =>
      request<VersionDetail>(`${p(slug)}/blocks/${blockId}/versions/${version}`),
    startQueue: (slug) => request<{ started: number }>(`${p(slug)}/queue/start`, { method: 'POST' }),
    listModels: () => request<{ items: ModelEntry[] }>('/api/models'),
    registerModel: (body) =>
      request<ModelEntry>('/api/models', { method: 'POST', body: JSON.stringify(body) }),
    removeModel: (id) => request<void>(`/api/models/${id}`, { method: 'DELETE' }),
    listCliSessions: () => request<{ items: CliSession[] }>('/api/cli-sessions'),
    sendChat: (slug, body) =>
      request<ChatResponse>(`${p(slug)}/chat`, { method: 'POST', body: JSON.stringify(body) }),
    getAgent: (slug) => request<AgentStatus>(`${p(slug)}/agent`),
    startAgent: (slug) => request<AgentStartResponse>(`${p(slug)}/agent/start`, { method: 'POST', body: '{}' }),
    stopAgent: (slug) => request<AgentStartResponse>(`${p(slug)}/agent/stop`, { method: 'POST' }),
    setAgentModel: (slug, body) =>
      request<AgentModelResponse>(`${p(slug)}/agent/model`, { method: 'POST', body: JSON.stringify(body) }),
    patchProject: (slug, body) =>
      request<Project>(p(slug), { method: 'PATCH', body: JSON.stringify(body) }),
    listFsDirs: (path) =>
      request<{ items: FsDirEntry[] }>(`/api/fs/dirs?path=${encodeURIComponent(path)}`),
  }
}
