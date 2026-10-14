<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { createApiClient } from './api/client'
import type {
  ApiClient,
  Card,
  FeedVersion,
  MasterInfo,
  Package,
  Project,
  ProjectDetail,
  ProjectTree,
  TaskReceipt,
  TechOrder,
} from './api/client'
import { createMockApiClient, getMockActivity, getMockCoreOpeners, isMockQueueRunning } from './api/mock'
import type { DrawerKey, FeedRound, SessionTarget } from './types'
import Sidebar from './components/Sidebar.vue'
import TopBar from './components/TopBar.vue'
import CoreChat from './components/CoreChat.vue'
import MasterSession from './components/MasterSession.vue'
import RightDrawer from './components/RightDrawer.vue'
import VersionPanel from './components/VersionPanel.vue'
import QueuePanel from './components/QueuePanel.vue'
import DocsPanel from './components/DocsPanel.vue'
import ConventionPanel from './components/ConventionPanel.vue'
import DashboardPanel from './components/DashboardPanel.vue'
import CardComposer from './components/CardComposer.vue'
import TechOrderComposer from './components/TechOrderComposer.vue'

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
const blockTitles = ref<Record<string, string>>({})
const masters = ref<MasterInfo[]>([])

// 会话与抽屉
const session = ref<SessionTarget>({ kind: 'core' })
const drawer = ref<DrawerKey | null>(null)
const showCardComposer = ref(false)
const showTechComposer = ref(false)

// 动作状态
const cardBusy = ref<Record<string, boolean>>({})
const cardError = ref<Record<string, string>>({})
const taskBusy = ref<Record<string, boolean>>({})
const taskError = ref<Record<string, string>>({})
const queueError = ref('')

const allVersions = computed<FeedVersion[]>(() => feed.value.flatMap((fr) => fr.versions))

const coreOpeners = computed(() => (mode.value === 'mock' ? getMockCoreOpeners(currentSlug.value) : []))

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

onUnmounted(stopPolling)

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
  if (projects.value.length > 0) await selectProject(projects.value[0].slug)
}

/** 切换项目 = 换工作区（DESIGN.md §14.3）：会话回核心代理，全部状态重置刷新 */
async function selectProject(slug: string): Promise<void> {
  if (!client.value) return
  currentSlug.value = slug
  session.value = { kind: 'core' }
  drawer.value = null
  showCardComposer.value = false
  showTechComposer.value = false
  loadError.value = ''
  feed.value = []
  feedError.value = ''
  packages.value = []
  blockTitles.value = {}
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
  try {
    const tree: ProjectTree = await client.value.getTree(slug)
    const titles: Record<string, string> = {}
    for (const domain of tree.items) {
      for (const doc of domain.documents) {
        for (const b of doc.blocks) titles[b.id] = b.title
      }
    }
    blockTitles.value = titles
  } catch {
    blockTitles.value = {}
  }
  try {
    masters.value = (await client.value.listMasters(slug)).items
  } catch {
    // 后端未提供 masters 端点：退回内置两席
    masters.value = [
      { id: 'backend', name: '后端主代理', duty: '负责 backend/：API 实现与数据模型', dir: 'backend/', harness: 'claude-code' },
      { id: 'frontend', name: '前端主代理', duty: '负责 web/：界面实现与交互', dir: 'web/', harness: 'claude-code' },
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

/* ---------- 起草 / 建单 / 抽屉 ---------- */

function onCardCreated(_card: Card): void {
  showCardComposer.value = false
  void refreshAll()
}

function onTechCreated(_order: TechOrder): void {
  showTechComposer.value = false
  void refreshAll()
}

function onToggleDrawer(key: DrawerKey): void {
  drawer.value = drawer.value === key ? null : key
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
  <div class="app">
    <Sidebar
      :client="client"
      :projects="projects"
      :current-slug="currentSlug"
      :masters="masters"
      :session="session"
      @select-project="selectProject"
      @select-session="session = $event"
      @masters-changed="reloadMasters"
    >
      <template #foot>
        <span
          class="badge"
          :class="`badge--mode-${mode}`"
          :title="mode === 'live' ? '已连接后端，使用真实接口' : mode === 'mock' ? '后端不可达，使用内置演示数据' : '正在探测后端'"
        >{{ modeBadge }}</span>
      </template>
    </Sidebar>

    <div class="app__main">
      <TopBar :session-title="sessionTitle" :drawer="drawer" @toggle-drawer="onToggleDrawer" />

      <div class="app__body">
        <main class="app__chat">
          <div v-if="mode === 'probing'" class="chat-note">正在探测后端（GET /api/health）…</div>
          <div v-else-if="loadError" class="chat-note chat-note--error">加载项目失败：{{ loadError }}</div>
          <div v-else-if="projects.length === 0" class="chat-note">项目列表为空。</div>
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
            :openers="coreOpeners"
            :empty-note="feedError ? `账本数据不可用：${feedError}` : undefined"
            :card-busy="cardBusy"
            :card-error="cardError"
            @approve="approveCard"
            @reject="rejectCard"
            @open-card="showCardComposer = true"
            @open-tech="showTechComposer = true"
          />
        </main>

        <RightDrawer
          v-if="drawer === 'versions'"
          title="查看版本"
          @close="drawer = null"
        >
          <VersionPanel :client="client" :slug="currentSlug" :versions="allVersions" :block-titles="blockTitles" />
        </RightDrawer>
        <RightDrawer v-else-if="drawer === 'queue'" title="队列" @close="drawer = null">
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
        <RightDrawer v-else-if="drawer === 'docs'" title="文档 · 模块全景" @close="drawer = null">
          <DocsPanel :client="client" :slug="currentSlug" />
        </RightDrawer>
        <RightDrawer v-else-if="drawer === 'convention'" title="全局约定" @close="drawer = null">
          <ConventionPanel :client="client" :slug="currentSlug" />
        </RightDrawer>
        <RightDrawer v-else-if="drawer === 'stats'" title="统计" @close="drawer = null">
          <DashboardPanel :client="client" :slug="currentSlug" />
        </RightDrawer>
      </div>
    </div>

    <CardComposer
      v-if="showCardComposer"
      :client="client"
      :slug="currentSlug"
      @close="showCardComposer = false"
      @created="onCardCreated"
    />
    <TechOrderComposer
      v-if="showTechComposer"
      :client="client"
      :slug="currentSlug"
      @close="showTechComposer = false"
      @created="onTechCreated"
    />
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
}

.app__main {
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
