<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { createApiClient } from './api/client'
import type { ApiClient, Project, ProjectDetail } from './api/client'
import { createMockApiClient, getTimelineFixture } from './api/mock'
import type { RoundFixture } from './types'
import type { PanelKey } from './types'
import TopBar from './components/TopBar.vue'
import PlaceholderPanel from './components/PlaceholderPanel.vue'
import LeftRail from './components/LeftRail.vue'
import RightRail from './components/RightRail.vue'
import RoundTimeline from './components/RoundTimeline.vue'

type Mode = 'probing' | 'live' | 'mock'

const mode = ref<Mode>('probing')
const client = ref<ApiClient | null>(null)
const projects = ref<Project[]>([])
const currentSlug = ref('')
const detail = ref<ProjectDetail | null>(null)
const rounds = ref<RoundFixture[]>([])
const activePanel = ref<PanelKey | null>(null)
const loadError = ref('')

const panelMeta: Record<PanelKey, { title: string; hint: string }> = {
  queue: { title: '队列', hint: '任务包与看门狗状态。S0 占位，S4 切片接入（GET /api/p/{slug}/packages）。' },
  dashboard: { title: '仪表盘', hint: '时长 / token(估) / 验收结果 / 打回统计。S0 占位，S5 切片接入。' },
  convention: { title: '约定', hint: '项目级全局约定文档（版本化、需批准）。S0 占位，S5 切片接入。' },
  masters: { title: '代理', hint: '主代理注册与 AGENTS.md 管理。S0 占位，M4 里程碑接入。' },
}

const activePanelMeta = computed(() => (activePanel.value ? panelMeta[activePanel.value] : null))

const timelinePlaceholder = computed((): string => {
  if (mode.value === 'live') return '已连接后端（LIVE）。时间线数据自 S3 切片接入（GET /api/p/{slug}/rounds/{n}）。'
  return '暂无轮次数据。'
})

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

/** 项目切换 = 换工作区，不是页面导航（DESIGN.md §14.3）；LeftRail 随 :key 重挂载，树与选中状态重置 */
async function selectProject(slug: string): Promise<void> {
  if (!client.value) return
  currentSlug.value = slug
  activePanel.value = null
  loadError.value = ''
  try {
    detail.value = await client.value.getProject(slug)
  } catch (err) {
    detail.value = null
    loadError.value = err instanceof Error ? err.message : String(err)
  }
  rounds.value = mode.value === 'mock' ? getTimelineFixture(slug) : []
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

    <PlaceholderPanel
      v-if="activePanelMeta"
      :title="activePanelMeta.title"
      @close="activePanel = null"
    >
      <p class="panel-hint">{{ activePanelMeta.hint }}</p>
    </PlaceholderPanel>

    <div class="app-body">
      <LeftRail :key="currentSlug" class="app-body__left" :client="client" :slug="currentSlug" />
      <main class="app-body__mid">
        <div v-if="mode === 'probing'" class="mid-note">正在探测后端（GET /api/health）…</div>
        <div v-else-if="loadError" class="mid-note mid-note--error">加载项目失败：{{ loadError }}</div>
        <div v-else-if="projects.length === 0" class="mid-note">
          项目列表为空。live 模式下可经 POST /api/projects 创建（S0 前端未提供入口）。
        </div>
        <RoundTimeline v-else :rounds="rounds" :placeholder="timelinePlaceholder" />
      </main>
      <RightRail class="app-body__right" :detail="detail" />
    </div>
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
  grid-template-columns: var(--left-rail-w) minmax(0, 1fr) auto;
}

.app-body__left {
  min-height: 0;
}

.app-body__mid {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.mid-note {
  padding: var(--sp-5);
  color: var(--c-ink-3);
}

.mid-note--error {
  color: var(--c-danger);
}

.panel-hint {
  color: var(--c-ink-2);
  font-size: var(--fs-13);
}
</style>
