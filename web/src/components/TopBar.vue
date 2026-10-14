<script setup lang="ts">
import type { Project } from '../api/client'
import type { PanelKey } from '../types'

type Mode = 'probing' | 'live' | 'mock'

defineProps<{
  mode: Mode
  projects: Project[]
  currentSlug: string
}>()

const emit = defineEmits<{
  (e: 'select-project', slug: string): void
  (e: 'toggle-panel', key: PanelKey): void
}>()

const entries: Array<{ key: PanelKey; label: string }> = [
  { key: 'queue', label: '队列' },
  { key: 'dashboard', label: '仪表盘' },
  { key: 'convention', label: '约定' },
  { key: 'masters', label: '代理' },
]

const modeMeta: Record<Mode, { text: string; title: string }> = {
  probing: { text: '…', title: '正在探测后端' },
  live: { text: 'LIVE', title: '已连接后端，使用真实接口' },
  mock: { text: 'MOCK', title: '后端不可达，使用内置 mock 数据' },
}

function onSelectChange(e: Event): void {
  emit('select-project', (e.target as HTMLSelectElement).value)
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__brand">
      <span class="topbar__logo" aria-hidden="true">SL</span>
      <span class="topbar__name">SpecLock2</span>
      <span class="badge" :class="`badge--mode-${mode}`" :title="modeMeta[mode].title">
        {{ modeMeta[mode].text }}
      </span>
    </div>

    <label class="topbar__switcher">
      <span class="topbar__switcher-label">项目</span>
      <select class="topbar__select" :value="currentSlug" @change="onSelectChange">
        <option v-if="projects.length === 0" value="" disabled>（暂无项目）</option>
        <option v-for="p in projects" :key="p.slug" :value="p.slug">{{ p.name }}</option>
      </select>
    </label>

    <span
      class="topbar__session"
      title="会话切换：R-M2 接入（当前只有主主代理；直达会话入口收在代理面板，DESIGN.md §6.4）"
    >会话：主主代理 ▾</span>

    <nav class="topbar__entries" aria-label="全局入口">
      <button
        v-for="entry in entries"
        :key="entry.key"
        type="button"
        class="topbar__entry"
        @click="emit('toggle-panel', entry.key)"
      >
        {{ entry.label }}
      </button>
    </nav>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: 0 var(--sp-4);
  background: var(--c-panel);
  border-bottom: 1px solid var(--c-border);
}

.topbar__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.topbar__logo {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--c-accent);
  color: var(--c-accent-ink);
  font-size: var(--fs-12);
  font-weight: 700;
}

.topbar__name {
  font-size: var(--fs-16);
  font-weight: 700;
}

.topbar__switcher {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-left: var(--sp-3);
}

.topbar__switcher-label {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.topbar__select {
  padding: 3px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-panel);
  color: var(--c-ink);
  min-width: 160px;
}

.topbar__session {
  margin-left: var(--sp-2);
  padding: 3px 10px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  cursor: default;
  user-select: none;
}

.topbar__entries {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.topbar__entry {
  padding: 4px 12px;
  border-radius: var(--radius-s);
  font-size: var(--fs-13);
  color: var(--c-ink-2);
}

.topbar__entry:hover {
  color: var(--c-accent);
  background: var(--c-accent-bg);
}
</style>
