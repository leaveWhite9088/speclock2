<script setup lang="ts">
import { ref } from 'vue'
import type { ModelEntry } from '../api/client'
import type { DrawerKey, ModelPick } from '../types'
import ModelMenu from './ModelMenu.vue'

/**
 * 顶栏：右侧入口。模型按钮直接显示当前生效模型名（GET /agent 轮询值），
 * 点击弹层切换（与 /model 同一数据源与端点）；模型登记降为弹层内「管理登记」。
 */
defineProps<{
  sessionTitle: string
  drawer: DrawerKey | null
  docsActive: boolean
  chiefModel: string | null
  modelEntries: ModelEntry[]
  projectHasDefault: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-drawer', key: DrawerKey): void
  (e: 'toggle-docs'): void
  (e: 'pick-model', sel: ModelPick): void
  (e: 'manage-models'): void
}>()

const entries: Array<{ key: DrawerKey; label: string; primary?: boolean }> = [
  { key: 'convention', label: '约定' },
  { key: 'queue', label: '队列', primary: true },
]

const modelMenuOpen = ref(false)
</script>

<template>
  <header class="topbar">
    <span class="topbar__title" :title="sessionTitle">{{ sessionTitle }}</span>
    <!-- 当前生效模型：贴在会话名右侧，点击弹层切换 -->
    <div class="topbar__model">
      <button
        type="button"
        class="topbar__entry topbar__model-btn"
        :title="chiefModel ? `核心代理当前模型：${chiefModel}（点击切换）` : '核心代理未运行（点击选择模型）'"
        @click="modelMenuOpen = !modelMenuOpen"
      >
        <span class="topbar__model-dot" aria-hidden="true"></span>
        <span class="topbar__model-name">{{ chiefModel ?? '模型' }}</span>
      </button>
      <template v-if="modelMenuOpen">
        <div class="topbar__mmask" @click="modelMenuOpen = false"></div>
        <div class="topbar__mpanel">
          <ModelMenu
            :entries="modelEntries"
            :current-model="chiefModel"
            :show-default="projectHasDefault"
            @pick="
              (sel) => {
                modelMenuOpen = false
                emit('pick-model', sel)
              }
            "
            @manage="
              () => {
                modelMenuOpen = false
                emit('manage-models')
              }
            "
          />
        </div>
      </template>
    </div>
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
  position: relative;
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
  min-width: 0;
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

/* 当前模型按钮：mono 字直接显示生效模型名（贴会话名右侧） */
.topbar__model {
  position: relative;
  flex: none;
}

.topbar__model-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  max-width: 260px;
}

.topbar__model-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-ok);
  flex: none;
}

.topbar__model-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar__mmask {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.topbar__mpanel {
  position: absolute;
  top: calc(100% - 2px);
  left: 0;
  z-index: 51;
  width: 300px;
  background: var(--c-panel);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  box-shadow: 0 8px 24px rgba(29, 37, 48, 0.12);
  padding: var(--sp-1);
  max-height: 340px;
  overflow-y: auto;
}
</style>
