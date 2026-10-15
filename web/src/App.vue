<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { createApiClient } from './api/client'
import type {
  AgentStatus,
  ApiClient,
  CliSession,
  FeedVersion,
  MasterInfo,
  ModelEntry,
  Package,
  Project,
  ProjectDetail,
  TaskReceipt,
} from './api/client'
import {
  createMockApiClient,
  FALLBACK_CLI_SESSIONS,
  FALLBACK_MODEL_ENTRIES,
  getMockActivity,
  isMockQueueRunning,
} from './api/mock'
import type { ChatBubble, DrawerKey, FeedRound, ModelPick, SessionTarget } from './types'
import { ApiError } from './api/client'
import Sidebar from './components/Sidebar.vue'
import TopBar from './components/TopBar.vue'
import CoreChat from './components/CoreChat.vue'
import MasterSession from './components/MasterSession.vue'
import DocsBrowser from './components/DocsBrowser.vue'
import RightDrawer from './components/RightDrawer.vue'
import QueuePanel from './components/QueuePanel.vue'
import ConventionPanel from './components/ConventionPanel.vue'
import ModelPanel from './components/ModelPanel.vue'

type Mode = 'probing' | 'live' | 'mock'

const mode = ref<Mode>('probing')
const client = ref<ApiClient | null>(null)
const projects = ref<Project[]>([])
const currentSlug = ref('')
const detail = ref<ProjectDetail | null>(null)
const loadError = ref('')

// 账本投影（核心会话与抽屉共用）
const feed = ref<FeedRound[]>([])
const feedError = ref('')
const packages = ref<Package[]>([])
const masters = ref<MasterInfo[]>([])

// Harness×模型登记 + CLI 会话列表（「模型」抽屉与添加主代理共用）
const modelEntries = ref<ModelEntry[]>([])
const cliSessions = ref<CliSession[]>([])

// 会话与抽屉
const session = ref<SessionTarget>({ kind: 'core' })
const drawer = ref<DrawerKey | null>(null)
/** 文档浏览：主区视图（v1 式 树→文档→模块 三层） */
const docsView = ref(false)

/* ---------- 对话（R-M2：真核心代理；SSE 流式 + 事件日志恢复） ---------- */

const chatMessages = ref<ChatBubble[]>([])
/** 流式生成中：打字机缓冲（message_delta 增量追加） */
const streaming = ref(false)
const streamText = ref('')
/** 核心代理会话状态（侧栏状态卡：running/model/context_usage_percent） */
const agent = ref<AgentStatus | null>(null)
/** /model 弹层（输入框上方） */
const modelMenuOpen = ref(false)
let chatSource: EventSource | null = null
let lastHuman = ''
/** 用户主动停止：抑制随之而来的 agent_error 错误气泡 */
let userStop = false

/** 当前进行中的轮次（即时消息挂在它名下，与历史消息同构） */
const openRoundN = computed(() => feed.value.at(-1)?.info.n ?? 0)

/** 对话按轮次分组：气泡内嵌在轮次分隔线下，与卡片/版本保持真实时序 */
const chatByRound = computed<Record<number, ChatBubble[]>>(() => {
  const map: Record<number, ChatBubble[]> = {}
  for (const m of chatMessages.value) (map[m.round] ??= []).push(m)
  return map
})

function pushChat(who: ChatBubble['who'], text: string, round = openRoundN.value, action?: ChatBubble['action']): void {
  chatMessages.value = [...chatMessages.value, { round, who, text, action }]
}

/** 页面加载/切换项目：从事件日志恢复对话历史（chat.human / chat.chief，按 id 序） */
async function loadChatHistory(): Promise<void> {
  if (!client.value || !currentSlug.value) return
  const slug = currentSlug.value
  try {
    const [human, chief] = await Promise.all([
      client.value.listEvents(slug, { type: 'chat.human' }),
      client.value.listEvents(slug, { type: 'chat.chief' }),
    ])
    if (currentSlug.value !== slug) return
    const merged = [...human.items, ...chief.items].sort((a, b) => a.id.localeCompare(b.id))
    chatMessages.value = merged
      .map((e): ChatBubble => {
        const message = (e.payload as { message?: unknown }).message
        return {
          round: e.round,
          who: e.actor === 'human' ? 'human' : 'core',
          text: typeof message === 'string' ? message : '',
        }
      })
      .filter((m) => m.text !== '')
  } catch {
    chatMessages.value = []
  }
}

/** 一条核心代理回复定稿：入列并结束流式态（POST 返回与 SSE final 双路到达时去重） */
function settleStream(message: string): void {
  const last = chatMessages.value.at(-1)
  if (message && !(last && last.who === 'core' && last.text === message)) pushChat('core', message)
  streaming.value = false
  streamText.value = ''
}

function closeStream(): void {
  if (chatSource) {
    chatSource.close()
    chatSource = null
  }
  if (streamRetryTimer !== null) {
    clearTimeout(streamRetryTimer)
    streamRetryTimer = null
  }
}

/** SSE（仅 live；mock 模式由 mock 客户端同构返回，无流）。
 *  断流兜底：原生 EventSource 遇 HTTP 层错误会彻底关闭，这里统一
 *  关掉→指数退避重连，并立刻全量刷新把漏掉的事件补回来。 */
let streamRetryTimer: ReturnType<typeof setTimeout> | null = null

function openStream(retry = 0): void {
  if (mode.value !== 'live' || !currentSlug.value) return
  closeStream()
  const es = new EventSource(`/api/p/${currentSlug.value}/chat/stream`)
  es.addEventListener('message_delta', (ev) => {
    const data = JSON.parse((ev as MessageEvent<string>).data) as { delta?: unknown }
    if (typeof data.delta === 'string') {
      streamText.value += data.delta
      streaming.value = true
    }
  })
  es.addEventListener('message_final', (ev) => {
    const data = JSON.parse((ev as MessageEvent<string>).data) as { message?: unknown }
    settleStream(typeof data.message === 'string' ? data.message : '')
    // 回合结束时可能有同回合起草的卡片（card_proposed 漏收时在这里补）
    void refreshAll()
  })
  es.addEventListener('card_proposed', () => {
    void refreshAll()
  })
  es.addEventListener('agent_error', (ev) => {
    const data = JSON.parse((ev as MessageEvent<string>).data) as { error?: unknown }
    if (userStop) {
      userStop = false
      settleStream(streamText.value || '（已停止）')
    } else {
      const detail = typeof data.error === 'string' ? data.error : '未知错误'
      pushChat('error', `核心代理出错：${detail}`)
      streaming.value = false
      streamText.value = ''
    }
  })
  es.onerror = () => {
    chatSource?.close()
    chatSource = null
    void refreshAll()
    if (retry < 6) {
      streamRetryTimer = setTimeout(() => openStream(retry + 1), Math.min(15_000, 1_000 * 2 ** retry))
    }
  }
  chatSource = es
}

async function sendToCore(text: string): Promise<void> {
  if (!client.value || streaming.value) return
  // /model 是命令不是消息：不进对话正文、不落事件日志
  const cmd = text.match(/^\/model(?:\s+(\S+))?\s*$/)
  if (cmd) {
    if (cmd[1]) {
      const arg = cmd[1]
      const i = arg.indexOf('/')
      await switchChiefModel(i > 0 ? { provider: arg.slice(0, i), model: arg.slice(i + 1) } : { provider: null, model: arg })
    } else {
      modelMenuOpen.value = true
    }
    return
  }
  pushChat('human', text)
  lastHuman = text
  streaming.value = true
  streamText.value = ''
  try {
    const res = await client.value.sendChat(currentSlug.value, { message: text })
    // SSE 正常时 final 已先定稿（streaming=false）；SSE 缺席时用同步返回兜底
    if (streaming.value) settleStream(res.reply)
    void refreshAll() // 对话会开启新轮次（round 1 起步），拉一遍轮次让气泡归位
  } catch (err) {
    if (userStop) {
      userStop = false
      settleStream(streamText.value || '（已停止）')
    } else if (streaming.value) {
      streaming.value = false
      streamText.value = ''
      pushChat('error', err instanceof Error ? err.message : String(err))
    }
  } finally {
    void refreshAgent()
  }
}

/** 项目配置的默认核心代理模型（「默认（跟随项目配置）」项的目标） */
const projectDefaultModel = computed(() => {
  const p = projects.value.find((x) => x.slug === currentSlug.value)
  if (!p?.chief_model) return null
  return { provider: p.chief_provider ?? null, model: p.chief_model }
})

/** 切换核心代理当前会话模型（契约 v0.5）：成功/失败都走系统/错误气泡 */
async function switchChiefModel(sel: { provider: string | null; model: string | null }): Promise<void> {
  if (!client.value || !sel.model) return
  try {
    const res = await client.value.setAgentModel(currentSlug.value, {
      ...(sel.provider ? { provider: sel.provider } : {}),
      model: sel.model,
    })
    pushChat('system', `模型已切换为 ${res.model}`)
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      pushChat('error', '核心代理会话未运行——启动后即可切换。', undefined, {
        kind: 'start-retry-model',
        provider: sel.provider,
        model: sel.model,
      })
    } else {
      pushChat('error', err instanceof Error ? err.message : String(err))
    }
  } finally {
    void refreshAgent()
  }
}

/** /model 与右上角弹层共用的选择入口 */
function onModelPick(sel: ModelPick): void {
  modelMenuOpen.value = false
  if (sel.kind === 'default') {
    if (projectDefaultModel.value) void switchChiefModel(projectDefaultModel.value)
    else pushChat('system', '项目未配置默认模型，请直接选一个登记里的模型。')
    return
  }
  void switchChiefModel({ provider: sel.provider, model: sel.model })
}

/** 错误气泡的「启动核心代理」：启动成功后自动重试切换 */
async function onStartRetryModel(bubble: ChatBubble): Promise<void> {
  if (!client.value || bubble.action?.kind !== 'start-retry-model') return
  chatMessages.value = chatMessages.value.filter((m) => m !== bubble)
  try {
    await client.value.startAgent(currentSlug.value)
  } catch {
    /* 启动失败由切换请求的报错呈现 */
  }
  await switchChiefModel({ provider: bubble.action.provider, model: bubble.action.model })
}

/** 停止 = 停核心代理会话（pi 会话持久化，可再唤醒）；已生成的部分文本定稿保留 */
async function stopCore(): Promise<void> {
  if (!client.value || !currentSlug.value) return
  userStop = true
  try {
    await client.value.stopAgent(currentSlug.value)
  } catch {
    /* 停止失败不阻塞本地收尾 */
  }
  setTimeout(() => {
    if (streaming.value) {
      userStop = false
      settleStream(streamText.value || '（已停止）')
    }
  }, 400)
  void refreshAgent()
}

/** 错误气泡上的重试：去掉尾部错误气泡与重复的人消息，重发最后一次输入 */
function retryLast(): void {
  if (!lastHuman || streaming.value) return
  while (chatMessages.value.at(-1)?.who === 'error') {
    chatMessages.value = chatMessages.value.slice(0, -1)
  }
  const tail = chatMessages.value.at(-1)
  if (tail && tail.who === 'human' && tail.text === lastHuman) {
    chatMessages.value = chatMessages.value.slice(0, -1)
  }
  void sendToCore(lastHuman)
}

/* ---------- 核心代理状态（10s 轮询；context>80 黄色告警 §12.3） ---------- */

let agentTimer: ReturnType<typeof setInterval> | null = null

async function refreshAgent(): Promise<void> {
  if (!client.value || !currentSlug.value) return
  const slug = currentSlug.value
  try {
    const s = await client.value.getAgent(slug)
    if (currentSlug.value === slug) agent.value = s
  } catch {
    agent.value = null
  }
}

function startAgentLoop(): void {
  stopAgentLoop()
  void refreshAgent()
  agentTimer = setInterval(() => void refreshAgent(), 10_000)
}

function stopAgentLoop(): void {
  if (agentTimer !== null) {
    clearInterval(agentTimer)
    agentTimer = null
  }
}

async function startChiefAgent(): Promise<void> {
  if (!client.value || !currentSlug.value) return
  try {
    await client.value.startAgent(currentSlug.value)
  } catch {
    /* 启动失败由轮询状态反映 */
  }
  void refreshAgent()
}

// 动作状态
const cardBusy = ref<Record<string, boolean>>({})
const cardError = ref<Record<string, string>>({})
const taskBusy = ref<Record<string, boolean>>({})
const taskError = ref<Record<string, string>>({})
const queueError = ref('')

const allVersions = computed<FeedVersion[]>(() => feed.value.flatMap((fr) => fr.versions))

/** 按模块分组的版本记录（文档抽屉的版本切换用） */
const versionsByBlock = computed<Record<string, FeedVersion[]>>(() => {
  const map: Record<string, FeedVersion[]> = {}
  for (const v of allVersions.value) {
    ;(map[v.block_id] ??= []).push(v)
  }
  return map
})

/** 侧栏可拖拽调宽：夹在 200–420px，双击复位（主区随之自适应） */
const SIDEBAR_DEFAULT = 248
const sidebarWidth = ref(SIDEBAR_DEFAULT)
const dragging = ref(false)

function startDrag(e: MouseEvent): void {
  e.preventDefault()
  dragging.value = true
  const onMove = (ev: MouseEvent): void => {
    sidebarWidth.value = Math.min(420, Math.max(200, ev.clientX))
  }
  const onUp = (): void => {
    dragging.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.classList.remove('is-col-resizing')
  }
  document.body.classList.add('is-col-resizing')
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function resetDrag(): void {
  sidebarWidth.value = SIDEBAR_DEFAULT
}

/** 跨项目徽标（§14.3）：其他项目的 待批准/任务进度 在不切界面的情况下可见。
 *  任务按状态分类（验收修正）：dispatched/running=运行中、queued=排队、
 *  reported/auditing=待验收；timeout 并入运行中（仍在占用主代理）。 */
const projectStats = ref<Record<string, { pending: number; running: number; queued: number; reviewing: number }>>({})

async function refreshProjectStats(): Promise<void> {
  if (!client.value) return
  const entries = await Promise.all(
    projects.value.map(async (p) => {
      try {
        const [s, pkgs] = await Promise.all([
          client.value!.getStats(p.slug),
          client.value!.listPackages(p.slug),
        ])
        let running = 0
        let queued = 0
        let reviewing = 0
        for (const pkg of pkgs.items) {
          for (const t of pkg.tasks) {
            if (t.status === 'dispatched' || t.status === 'running' || t.status === 'timeout') running++
            else if (t.status === 'queued') queued++
            else if (t.status === 'reported' || t.status === 'auditing') reviewing++
          }
        }
        return [p.slug, { pending: s.cards.pending, running, queued, reviewing }] as const
      } catch {
        return [p.slug, { pending: 0, running: 0, queued: 0, reviewing: 0 }] as const
      }
    }),
  )
  projectStats.value = Object.fromEntries(entries)
}

/** 核心代理行徽标：待批准卡片数 */
const corePending = computed(() => feed.value.flatMap((fr) => fr.cards).filter((c) => c.status === 'pending').length)

/** 主代理状态（完整显示：执行中/排队/待审计/超时，带任务号） */
interface MasterState {
  label: string
  kind: 'running' | 'queued' | 'auditing' | 'timeout'
}

const masterStates = computed<Record<string, MasterState>>(() => {
  const states: Record<string, MasterState> = {}
  for (const pkg of packages.value) {
    for (const t of pkg.tasks) {
      if (!t.master) continue
      const cur = states[t.master]
      const rank = (s: MasterState['kind']) => ({ timeout: 0, running: 1, queued: 2, auditing: 3 })[s]
      let next: MasterState | null = null
      if (t.status === 'timeout') next = { label: `超时 · ${t.task_id}`, kind: 'timeout' }
      else if (t.status === 'dispatched' || t.status === 'running') next = { label: `执行中 · ${t.task_id}`, kind: 'running' }
      else if (t.status === 'queued') next = { label: `排队中 · ${t.task_id}`, kind: 'queued' }
      else if (t.status === 'reported' || t.status === 'auditing') next = { label: `待审计 · ${t.task_id}`, kind: 'auditing' }
      if (next && (!cur || rank(next.kind) < rank(cur.kind))) states[t.master] = next
    }
  }
  return states
})

/** 主代理最近一次遥测（包按轮次倒序，取该主代理第一条带遥测的任务） */
const masterTelemetry = computed<Record<string, { ms: number; tokens: number } | null>>(() => {
  const out: Record<string, { ms: number; tokens: number } | null> = {}
  for (const pkg of packages.value) {
    for (const t of pkg.tasks) {
      if (!t.master) continue
      if (out[t.master]) continue
      if (t.duration_ms != null || t.tokens != null) {
        out[t.master] = { ms: t.duration_ms ?? 0, tokens: t.tokens ?? 0 }
      }
    }
  }
  return out
})

const sessionTitle = computed(() => {
  const target = session.value
  if (target.kind === 'core') return '核心代理'
  const m = masters.value.find((x) => x.id === target.masterId)
  return m ? `${m.name} · 工作流` : '主代理'
})

const activeMaster = computed<MasterInfo | null>(() => {
  const target = session.value
  if (target.kind !== 'master') return null
  return masters.value.find((m) => m.id === target.masterId) ?? null
})

const masterActivity = computed(() => {
  const target = session.value
  if (target.kind !== 'master') return []
  return getMockActivity()[target.masterId] ?? []
})

const modeBadge = computed(() => (mode.value === 'live' ? 'LIVE' : mode.value === 'mock' ? 'MOCK' : '…'))

/** mock 队列模拟需要界面跟着走：轮询刷新（本地状态，开销可忽略） */
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPolling(): void {
  stopPolling()
  pollTimer = setInterval(() => {
    if (isMockQueueRunning()) void refreshAll()
  }, 1200)
}

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

onUnmounted(() => {
  stopPolling()
  stopAgentLoop()
  closeStream()
})

/** 启动探测：GET /api/health 成功 → live；失败 → 自动切 mock */
async function bootstrap(): Promise<void> {
  const live = createApiClient()
  try {
    const health = await live.health()
    if (!health.ok) throw new Error('health 返回 not ok')
    mode.value = 'live'
    client.value = live
    projects.value = (await live.listProjects()).items
  } catch {
    mode.value = 'mock'
    client.value = createMockApiClient()
    projects.value = (await client.value.listProjects()).items
  }
  await loadRegistry()
  if (projects.value.length > 0) await selectProject(projects.value[0].slug)
}

/** 切换项目 = 换工作区（DESIGN.md §14.3）：会话回核心代理，全部状态重置刷新 */
async function selectProject(slug: string): Promise<void> {
  if (!client.value) return
  currentSlug.value = slug
  session.value = { kind: 'core' }
  drawer.value = null
  docsView.value = false
  closeStream()
  stopAgentLoop()
  agent.value = null
  streaming.value = false
  streamText.value = ''
  userStop = false
  chatMessages.value = []
  loadError.value = ''
  feed.value = []
  feedError.value = ''
  packages.value = []
  masters.value = []
  cardBusy.value = {}
  cardError.value = {}
  taskBusy.value = {}
  taskError.value = {}
  queueError.value = ''
  try {
    detail.value = await client.value.getProject(slug)
  } catch (err) {
    detail.value = null
    loadError.value = err instanceof Error ? err.message : String(err)
  }
  await refreshAll()
  await loadChatHistory()
  openStream()
  startAgentLoop()
}

/** 刷新对话流 + 任务包 + 模块标题 + 主代理列表 */
async function refreshAll(): Promise<void> {
  if (!client.value || !currentSlug.value) return
  const slug = currentSlug.value
  try {
    const rounds = (await client.value.listRounds(slug)).items
    const details = await Promise.all(rounds.map((r) => client.value!.getRound(slug, r.n)))
    const pkgs = (await client.value.listPackages(slug)).items
    feed.value = rounds.map((info, i) => ({
      info,
      cards: details[i].cards,
      versions: details[i].versions,
      packages: pkgs.filter((p) => p.round === info.n),
      verdictEvents: details[i].events.filter((e) => e.type.startsWith('audit.')),
    }))
    packages.value = [...pkgs].sort((a, b) => b.round - a.round)
    feedError.value = ''
  } catch (err) {
    feed.value = []
    packages.value = []
    feedError.value = err instanceof Error ? err.message : String(err)
  }
  void refreshProjectStats()
  try {
    masters.value = (await client.value.listMasters(slug)).items
  } catch {
    // 后端未提供 masters 端点：退回内置两席
    masters.value = [
      { id: 'backend', name: '后端主代理', duty: '负责 backend/：API 实现与数据模型', dir: 'backend/', harness: 'claude-code', model: 'glm-4.7' },
      { id: 'frontend', name: '前端主代理', duty: '负责 web/：界面实现与交互', dir: 'web/', harness: 'claude-code', model: 'claude-sonnet-4.5' },
    ]
  }
}

async function reloadMasters(): Promise<void> {
  if (!client.value || !currentSlug.value) return
  try {
    masters.value = (await client.value.listMasters(currentSlug.value)).items
  } catch {
    /* 保持现状 */
  }
}

/** 项目列表变化（新建/设置保存）：刷新列表；新建的项目直接选中进入 */
async function onProjectsChanged(createdSlug?: string): Promise<void> {
  if (!client.value) return
  try {
    projects.value = (await client.value.listProjects()).items
  } catch {
    /* 列表刷新失败保持现状 */
  }
  if (createdSlug) await selectProject(createdSlug)
}

/** 模型登记与 CLI 会话列表：live 后端未提供端点时用内置登记兜底（主代理表单仍可用） */
async function loadRegistry(): Promise<void> {
  if (!client.value) return
  try {
    modelEntries.value = (await client.value.listModels()).items
  } catch {
    modelEntries.value = FALLBACK_MODEL_ENTRIES.map((x) => ({ ...x }))
  }
  try {
    cliSessions.value = (await client.value.listCliSessions()).items
  } catch {
    cliSessions.value = FALLBACK_CLI_SESSIONS.map((x) => ({ ...x }))
  }
}

/* ---------- 卡片动作 ---------- */

async function approveCard(cardId: string): Promise<void> {
  if (!client.value) return
  cardBusy.value = { ...cardBusy.value, [cardId]: true }
  cardError.value = { ...cardError.value, [cardId]: '' }
  try {
    await client.value.approveCard(currentSlug.value, cardId)
    await refreshAll()
  } catch (err) {
    cardError.value = { ...cardError.value, [cardId]: err instanceof Error ? err.message : String(err) }
  } finally {
    cardBusy.value = { ...cardBusy.value, [cardId]: false }
  }
}

async function rejectCard(cardId: string): Promise<void> {
  if (!client.value) return
  cardBusy.value = { ...cardBusy.value, [cardId]: true }
  cardError.value = { ...cardError.value, [cardId]: '' }
  try {
    await client.value.rejectCard(currentSlug.value, cardId, {})
    await refreshAll()
  } catch (err) {
    cardError.value = { ...cardError.value, [cardId]: err instanceof Error ? err.message : String(err) }
  } finally {
    cardBusy.value = { ...cardBusy.value, [cardId]: false }
  }
}

/* ---------- 任务动作 ---------- */

async function runTaskAction(taskId: string, fn: () => Promise<unknown>): Promise<void> {
  if (!client.value) return
  taskBusy.value = { ...taskBusy.value, [taskId]: true }
  taskError.value = { ...taskError.value, [taskId]: '' }
  try {
    await fn()
    await refreshAll()
  } catch (err) {
    taskError.value = { ...taskError.value, [taskId]: err instanceof Error ? err.message : String(err) }
  } finally {
    taskBusy.value = { ...taskBusy.value, [taskId]: false }
  }
}

function onDispatch(payload: { taskId: string; minutes: number }): void {
  void runTaskAction(payload.taskId, () =>
    client.value!.dispatchTask(currentSlug.value, payload.taskId, { watchdog_minutes: payload.minutes }),
  )
}

function onReceipt(payload: { taskId: string; body: TaskReceipt }): void {
  void runTaskAction(payload.taskId, () =>
    client.value!.submitReceipt(currentSlug.value, payload.taskId, payload.body),
  )
}

function onAudit(payload: { taskId: string; result: 'pass' | 'fail'; note: string }): void {
  void runTaskAction(payload.taskId, () =>
    client.value!.auditTask(currentSlug.value, payload.taskId, {
      result: payload.result,
      note: payload.note || undefined,
    }),
  )
}

async function startQueue(): Promise<void> {
  if (!client.value) return
  queueError.value = ''
  try {
    await client.value.startQueue(currentSlug.value)
    if (mode.value === 'mock') startPolling()
  } catch (err) {
    queueError.value = err instanceof Error ? err.message : String(err)
  }
}

/* ---------- 起草 / 抽屉 ---------- */

function onToggleDrawer(key: DrawerKey): void {
  drawer.value = drawer.value === key ? null : key
}

function onSelectSession(target: SessionTarget): void {
  session.value = target
  docsView.value = false
}

watch(
  () => isMockQueueRunning(),
  (running) => {
    if (!running && pollTimer !== null) {
      void refreshAll()
      stopPolling()
    }
  },
)

onMounted(() => {
  void bootstrap()
})
</script>

<template>
  <div class="app" :class="{ 'app--dragging': dragging }">
      <Sidebar
        :client="client"
        :projects="projects"
        :current-slug="currentSlug"
        :masters="masters"
        :session="session"
        :project-stats="projectStats"
        :master-states="masterStates"
        :core-pending="corePending"
        :agent="agent"
        :master-telemetry="masterTelemetry"
        :model-entries="modelEntries"
        :cli-sessions="cliSessions"
        :style="{ width: `${sidebarWidth}px` }"
        @select-project="selectProject"
        @select-session="onSelectSession"
        @masters-changed="reloadMasters"
        @start-agent="startChiefAgent"
        @projects-changed="onProjectsChanged"
      >
      <template #foot>
        <span
          class="badge"
          :class="`badge--mode-${mode}`"
          :title="mode === 'live' ? '已连接后端，使用真实接口' : mode === 'mock' ? '后端不可达，使用内置演示数据' : '正在探测后端'"
        >{{ modeBadge }}</span>
      </template>
    </Sidebar>

    <div
      class="app__splitter"
      title="拖拽调整侧栏宽度（双击复位）"
      @mousedown="startDrag"
      @dblclick="resetDrag"
    ></div>

    <div class="app__main">
      <TopBar
        :session-title="docsView ? '文档' : sessionTitle"
        :drawer="drawer"
        :docs-active="docsView"
        :chief-model="agent?.model ?? null"
        :model-entries="modelEntries"
        :project-has-default="projectDefaultModel != null"
        @toggle-drawer="onToggleDrawer"
        @toggle-docs="docsView = !docsView"
        @pick-model="onModelPick"
        @manage-models="drawer = 'models'"
      />

      <div class="app__body">
        <main class="app__chat">
          <div v-if="mode === 'probing'" class="chat-note">正在探测后端（GET /api/health）…</div>
          <div v-else-if="loadError" class="chat-note chat-note--error">加载项目失败：{{ loadError }}</div>
          <div v-else-if="projects.length === 0" class="chat-note">项目列表为空。</div>
          <DocsBrowser
            v-else-if="docsView"
            :key="currentSlug"
            :client="client"
            :slug="currentSlug"
            :feed="feed"
            :versions-by-block="versionsByBlock"
            @close="docsView = false"
          />
          <MasterSession
            v-else-if="activeMaster"
            :key="`${currentSlug}-${activeMaster.id}`"
            :master="activeMaster"
            :activity="masterActivity"
            :packages="packages"
          />
          <CoreChat
            v-else
            :feed="feed"
            :chat-by-round="chatByRound"
            :streaming="streaming"
            :stream-text="streamText"
            :model-menu="modelMenuOpen"
            :model-entries="modelEntries"
            :current-model="agent?.model ?? null"
            :project-has-default="projectDefaultModel != null"
            :empty-note="feedError ? `账本数据不可用：${feedError}` : undefined"
            :card-busy="cardBusy"
            :card-error="cardError"
            @send="sendToCore"
            @stop="stopCore"
            @retry="retryLast"
            @pick-model="onModelPick"
            @close-model-menu="modelMenuOpen = false"
            @start-retry="onStartRetryModel"
            @approve="approveCard"
            @reject="rejectCard"
          />
        </main>

        <RightDrawer v-if="drawer === 'queue'" title="队列" @close="drawer = null">
          <QueuePanel
            :packages="packages"
            :task-busy="taskBusy"
            :task-error="taskError"
            :queue-running="mode === 'mock' && isMockQueueRunning()"
            :queue-error="queueError"
            @start-queue="startQueue"
            @dispatch="onDispatch"
            @receipt="onReceipt"
            @audit="onAudit"
          />
        </RightDrawer>
        <RightDrawer v-else-if="drawer === 'convention'" title="全局约定" @close="drawer = null">
          <ConventionPanel :client="client" :slug="currentSlug" />
        </RightDrawer>
        <RightDrawer v-else-if="drawer === 'models'" title="模型" @close="drawer = null">
          <ModelPanel :client="client" :entries="modelEntries" @changed="loadRegistry" />
        </RightDrawer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  min-width: 0;
}

.app__splitter {
  flex: none;
  width: 5px;
  margin-left: -2px;
  margin-right: -2px;
  z-index: 5;
  cursor: col-resize;
}

.app__splitter:hover,
.app--dragging .app__splitter {
  background: var(--c-border-strong);
}

.app__main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.app__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
}

.app__chat {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-note {
  padding: var(--sp-5);
  color: var(--c-ink-3);
}

.chat-note--error {
  color: var(--c-danger);
}
</style>
