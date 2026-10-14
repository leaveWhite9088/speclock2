<script setup lang="ts">
import type { DrawerKey } from '../types'

defineProps<{
  sessionTitle: string
  drawer: DrawerKey | null
  docsActive: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-drawer', key: DrawerKey): void
  (e: 'toggle-docs'): void
}>()

const entries: Array<{ key: DrawerKey; label: string; primary?: boolean }> = [
  { key: 'queue', label: '队列', primary: true },
  { key: 'convention', label: '约定' },
]
</script>

<template>
  <header class="topbar">
    <span class="topbar__title" :title="sessionTitle">{{ sessionTitle }}</span>
    <nav class="topbar__entries" aria-label="右侧入口">
      <button
        type="button"
        class="topbar__entry topbar__entry--primary"
        :class="{ 'is-active': docsActive }"
        @click="emit('toggle-docs')"
      >文档</button>
      <button
        v-for="entry in entries"
        :key="entry.key"
        type="button"
        class="topbar__entry"
        :class="{ 'is-active': drawer === entry.key, 'topbar__entry--primary': entry.primary }"
        @click="emit('toggle-drawer', entry.key)"
      >{{ entry.label }}</button>
    </nav>
  </header>
</template>

<style scoped>
.topbar {
  height: var(--topbar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-4);
  background: var(--c-bg);
  border-bottom: 1px solid var(--c-border);
}

.topbar__title {
  font-size: var(--fs-14);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar__entries {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.topbar__entry {
  padding: 4px 10px;
  border-radius: var(--radius-m);
  font-size: var(--fs-13);
  color: var(--c-ink-2);
}

.topbar__entry--primary {
  color: var(--c-ink);
  font-weight: 600;
}

.topbar__entry:hover {
  background: var(--c-panel-2);
  color: var(--c-ink);
}

.topbar__entry.is-active {
  background: var(--c-panel);
  box-shadow: inset 0 0 0 1px var(--c-border-strong);
  color: var(--c-ink);
}
</style>
