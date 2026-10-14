<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { createApiClient } from './api/client'
import type {
  ApiClient,
  Card,
  FeedVersion,
  Package,
  Project,
  ProjectDetail,
  ProjectTree,
  TaskReceipt,
  TechOrder,
} from './api/client'
import { createMockApiClient } from './api/mock'
import type { FeedRound, PanelKey } from './types'
import TopBar from './components/TopBar.vue'
import PanelShell from './components/PanelShell.vue'
import LeftPanel from './components/LeftPanel.vue'
import RightPanel from './components/RightPanel.vue'
import ChatStream from './components/ChatStream.vue'
import PackageList from './components/PackageList.vue'
import ConventionPanel from './components/ConventionPanel.vue'
import DashboardPanel from './components/DashboardPanel.vue'
import MastersPanel from './components/MastersPanel.vue'
import CardComposer from './components/CardComposer.vue'
import TechOrderComposer from './components/TechOrderComposer.vue'

type Mode = 'probing' | 'live' | 'mock'

const mode = ref<Mode>('probing')
const client = ref<ApiClient | null>(null)
const projects = ref<Project[]>([])
const currentSlug = ref('')
const detail = ref<ProjectDetail | null>(null)
const loadError = ref('')

// 对话流（轮次分段）与任务包
const feed = ref<FeedRound[]>([])
const feedError = ref('')
const packages = ref<Package[]>([])
const blockTitles = ref<Record<string, string>>({})

// 面板与表单
const activePanel = ref<PanelKey | null>(null)
const showCardComposer = ref(false)
const showTechComposer = ref(false)

// 动作进行中/错误状态（按 id）
const cardBusy = ref<Record<string, boolean>>({})
const cardError = ref<Record<string, string>>({})
const taskBusy = ref<Record<string, boolean>>({})
const taskError = ref<Record<string, string>>({})

const allVersions = computed<FeedVersion[]>(() => feed.value.flatMap((fr) => fr.versions))

/** 启动探测：GET /api/health 成功 → live；失败 → 自动切 mock（顶栏徽标随之变化） */
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

/** 项目切换 = 换工作区，不是页面导航（DESIGN.md §14.3）：全部状态重置刷新 */
async function selectProject(slug: string): Promise<void> {
  if (!client.value) return
  currentSlug.value = slug
  activePanel.value = null
  showCardComposer.value = false
  showTechComposer.value = false
  loadError.value = ''
  feed.value = []
  feedError.value = ''
  packages.value = []
  blockTitles.value = {}
  cardBusy.value = {}
  cardError.value = {}
  taskBusy.value = {}
  taskError.value = {}
  try {
    detail.value = await client.value.getProject(slug)
  } catch (err) {
    detail.value = null
    loadError.value = err instanceof Error ? err.message : String(err)
  }
  await refreshAll()
}

/** 刷新对话流 + 任务包 + 模块标题（版本链/徽标用） */
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
}

/* ---------- 卡片动作（批准/打回） ---------- */

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

/* ---------- 任务动作（派发/回执/审计） ---------- */

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

/* ---------- 起草/建单 ---------- */

function onCardCreated(_card: Card): void {
  showCardComposer.value = false
  void refreshAll()
}

function onTechCreated(_order: TechOrder): void {
  showTechComposer.value = false
  void refreshAll()
}

function onTogglePanel(key: PanelKey): void {
  activePanel.value = activePanel.value === key ? null : key
}

onMounted(() => {
  void bootstrap()
})
</script>

<template>
  <div class="app">
    <TopBar
      :mode="mode"
      :projects="projects"
      :current-slug="currentSlug"
      @select-project="selectProject"
      @toggle-panel="onTogglePanel"
    />

    <!-- 顶栏入口的停靠面板（队列 / 仪表盘 / 约定 / 代理） -->
    <PanelShell v-if="activePanel === 'queue'" title="队列 · 任务包与任务状态" @close="activePanel = null">
      <PackageList
        :packages="packages"
        :task-busy="taskBusy"
        :task-error="taskError"
        @dispatch="onDispatch"
        @receipt="onReceipt"
        @audit="onAudit"
      />
    </PanelShell>
    <PanelShell v-else-if="activePanel === 'dashboard'" title="仪表盘" @close="activePanel = null">
      <DashboardPanel :client="client" :slug="currentSlug" />
    </PanelShell>
    <PanelShell v-else-if="activePanel === 'convention'" title="全局约定" @close="activePanel = null">
      <ConventionPanel :client="client" :slug="currentSlug" />
    </PanelShell>
    <PanelShell v-else-if="activePanel === 'masters'" title="代理" @close="activePanel = null">
      <MastersPanel />
    </PanelShell>

    <!-- chat-first 三区：左面板（可折叠）/ 中央对话流 / 右面板（可折叠） -->
    <div class="app-body">
      <LeftPanel
        :key="currentSlug"
        :client="client"
        :slug="currentSlug"
        :versions="allVersions"
        :block-titles="blockTitles"
        @open-convention="activePanel = 'convention'"
      />

      <main class="app-body__chat">
        <div v-if="mode === 'probing'" class="chat-note">正在探测后端（GET /api/health）…</div>
        <div v-else-if="loadError" class="chat-note chat-note--error">加载项目失败：{{ loadError }}</div>
        <div v-else-if="projects.length === 0" class="chat-note">
          项目列表为空。live 模式下可经 POST /api/projects 创建（S0 前端未提供入口）。
        </div>
        <ChatStream
          v-else
          :feed="feed"
          :empty-note="feedError ? `轮次/时间线数据不可用：${feedError}` : undefined"
          :card-busy="cardBusy"
          :card-error="cardError"
          @approve="approveCard"
          @reject="rejectCard"
          @open-card="showCardComposer = true"
          @open-tech="showTechComposer = true"
        />
      </main>

      <RightPanel
        :key="`${currentSlug}-r`"
        :packages="packages"
        :task-busy="taskBusy"
        :task-error="taskError"
        @dispatch="onDispatch"
        @receipt="onReceipt"
        @audit="onAudit"
      />
    </div>

    <!-- 起草卡片 / 技术任务单 -->
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
  display: flex;
  flex-direction: column;
}

.app-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.app-body__chat {
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
