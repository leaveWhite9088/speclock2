/**
 * SpecLock 2 前端 API 层（M1-S0）
 *
 * 覆盖 DEV-PLAN.md §2「API 契约 v0」全部端点的 TypeScript 类型与调用函数。
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
  /** Bug 修复版本引用的被违反规则 ID（DESIGN.md §6.5），契约 v0 未列，可选 */
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
  delta_summary: string
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

/* ---------- 审批卡片（DESIGN.md §8） ---------- */

export interface RuleOp {
  op: 'add' | 'modify' | 'remove'
  id: string
  before: Rule | null
  after: Rule | null
}

export interface ApiOp {
  op: 'upsert' | 'remove'
  key: string
  entry: ApiEntry | null
  breaking: boolean
  /**
   * 以下三个为展示层补充字段：契约 v0 的 ApiOp 未定义，语义来自 DESIGN.md §8.2 的
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
  risk: CardRisk
  /** 以下字段契约 v0 的 Card 未列（见 DESIGN.md §8.2），均为可选，记入回执「契约疑问」 */
  convention_ops?: unknown[]
  task_preview?: TaskPreviewItem[]
  narration_event?: string
  decision?: unknown
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

/** GET /api/p/{slug}/rounds/{n} 渲染源（S3 实装，形状按 DESIGN.md §7.3 预置） */
export interface RoundDetail {
  n: number
  events: Event[]
  versions: BlockVersionInfo[]
  cards: Card[]
}

/* ---------- 任务包与回执（DESIGN.md §9 / §13.4） ---------- */

export type TaskStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'reported'
  | 'auditing'
  | 'done'
  | 'rejected'
  | 'timeout'

export interface Task {
  task_id: string
  master: string
  depends_on: string[]
  status: TaskStatus
  harness: string | null
  session_ref: string | null
}

export interface TaskPackage {
  package_id: string
  round: number
  version_refs: Record<string, string>
  tasks: Task[]
}

export interface ReceiptSubmission {
  task_id: string
  files_changed: string[]
  self_check: string
  summary: string
}

/* ---------- 全局约定（DESIGN.md §5.5） ---------- */

export interface Convention {
  version: string
  round: number
  statement: Statement
  content: string
}

/* ---------- 请求体 ---------- */

export interface CreateProjectBody {
  slug: string
  name: string
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

export interface RejectCardBody {
  reason?: string
}

export interface ListEventsQuery {
  since?: string
  type?: string
}

export interface ConventionDraftBody {
  content: string
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...init })
  } catch (err) {
    // 网络层失败（后端不可达、连接被拒等）
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

/** 契约 v0 全端点（路径与语义见 DEV-PLAN.md §2 端点表） */
export interface ApiClient {
  health(): Promise<HealthResponse>
  listProjects(): Promise<{ items: Project[] }>
  createProject(body: CreateProjectBody): Promise<Project>
  getProject(slug: string): Promise<ProjectDetail>
  getTree(slug: string): Promise<ProjectTree>
  createDomain(slug: string, body: CreateDomainBody): Promise<{ id: string; title: string }>
  createDocument(slug: string, body: CreateDocumentBody): Promise<{ id: string; title: string }>
  createBlock(slug: string, body: CreateBlockBody): Promise<{ id: string; title: string }>
  getBlock(slug: string, id: string): Promise<Block>
  updateBlockDraft(slug: string, id: string, draft: BlockDraft): Promise<Block>
  createCard(slug: string, card: Card): Promise<Card>
  listCards(slug: string, status?: CardStatus): Promise<{ items: Card[] }>
  approveCard(slug: string, id: string): Promise<Card>
  rejectCard(slug: string, id: string, body: RejectCardBody): Promise<Card>
  listRounds(slug: string): Promise<{ items: RoundInfo[] }>
  getRound(slug: string, n: number): Promise<RoundDetail>
  listEvents(slug: string, query?: ListEventsQuery): Promise<{ items: Event[] }>
  listPackages(slug: string): Promise<{ items: TaskPackage[] }>
  submitReceipt(slug: string, taskId: string, body: ReceiptSubmission): Promise<ReceiptSubmission>
  getConvention(slug: string): Promise<Convention>
  updateConventionDraft(slug: string, body: ConventionDraftBody): Promise<Convention>
  approveConvention(slug: string): Promise<Convention>
}

/** live 客户端：同源 fetch（dev 由 Vite 代理 /api → http://127.0.0.1:8000） */
export function createApiClient(): ApiClient {
  const p = (slug: string): string => `/api/p/${slug}`
  return {
    health: () => request<HealthResponse>('/api/health'),
    listProjects: () => request<{ items: Project[] }>('/api/projects'),
    createProject: (body) =>
      request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) }),
    getProject: (slug) => request<ProjectDetail>(p(slug)),
    getTree: (slug) => request<ProjectTree>(`${p(slug)}/tree`),
    createDomain: (slug, body) =>
      request<{ id: string; title: string }>(`${p(slug)}/domains`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createDocument: (slug, body) =>
      request<{ id: string; title: string }>(`${p(slug)}/documents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    createBlock: (slug, body) =>
      request<{ id: string; title: string }>(`${p(slug)}/blocks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getBlock: (slug, id) => request<Block>(`${p(slug)}/blocks/${id}`),
    updateBlockDraft: (slug, id, draft) =>
      request<Block>(`${p(slug)}/blocks/${id}`, { method: 'PUT', body: JSON.stringify(draft) }),
    createCard: (slug, card) =>
      request<Card>(`${p(slug)}/cards`, { method: 'POST', body: JSON.stringify(card) }),
    listCards: (slug, status) => request<{ items: Card[] }>(withQuery(`${p(slug)}/cards`, { status })),
    approveCard: (slug, id) => request<Card>(`${p(slug)}/cards/${id}/approve`, { method: 'POST' }),
    rejectCard: (slug, id, body) =>
      request<Card>(`${p(slug)}/cards/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    listRounds: (slug) => request<{ items: RoundInfo[] }>(`${p(slug)}/rounds`),
    getRound: (slug, n) => request<RoundDetail>(`${p(slug)}/rounds/${n}`),
    listEvents: (slug, query) => request<{ items: Event[] }>(withQuery(`${p(slug)}/events`, query)),
    listPackages: (slug) => request<{ items: TaskPackage[] }>(`${p(slug)}/packages`),
    submitReceipt: (slug, taskId, body) =>
      request<ReceiptSubmission>(`${p(slug)}/tasks/${taskId}/receipt`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getConvention: (slug) => request<Convention>(`${p(slug)}/conventions`),
    updateConventionDraft: (slug, body) =>
      request<Convention>(`${p(slug)}/conventions/draft`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    approveConvention: (slug) =>
      request<Convention>(`${p(slug)}/conventions/approve`, { method: 'POST' }),
  }
}
