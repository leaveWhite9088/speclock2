<script setup lang="ts">
import type { ModelEntry } from '../api/client'
import type { ModelPick } from '../types'

/**
 * 核心代理模型选择列表（/model 命令弹层与右上角弹层共用，同一数据源 =
 * 模型登记；当前生效模型高亮；「默认」= 跟随项目配置；次级入口管理登记）。
 */
defineProps<{
  entries: ModelEntry[]
  currentModel: string | null
  /** 项目配置了 chief 模型时才显示「默认」项 */
  showDefault: boolean
}>()

const emit = defineEmits<{
  (e: 'pick', sel: ModelPick): void
  (e: 'manage'): void
}>()
</script>

<template>
  <div class="mmenu">
    <button
      v-if="showDefault"
      type="button"
      class="mmenu__item"
      @click="emit('pick', { kind: 'default' })"
    >
      <span class="mmenu__name">默认（跟随项目配置）</span>
    </button>
    <button
      v-for="e in entries"
      :key="e.id"
      type="button"
      class="mmenu__item"
      :class="{ 'is-current': currentModel === `${e.harness}/${e.model}` }"
      @click="emit('pick', { kind: 'entry', provider: e.harness, model: e.model })"
    >
      <span class="mmenu__name">{{ e.harness }} · {{ e.model }}</span>
      <span v-if="currentModel === `${e.harness}/${e.model}`" class="mmenu__cur">当前</span>
    </button>
    <footer class="mmenu__foot">
      <button type="button" class="mmenu__manage" @click="emit('manage')">管理登记 →</button>
    </footer>
  </div>
</template>

<style scoped>
.mmenu {
  display: grid;
  gap: 1px;
}

.mmenu__item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  border-radius: var(--radius-m);
  font-size: var(--fs-13);
  color: var(--c-ink);
}

.mmenu__item:hover {
  background: var(--c-panel-2);
}

.mmenu__item.is-current {
  background: var(--c-panel);
  box-shadow: inset 0 0 0 1px var(--c-border-strong);
}

.mmenu__name {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mmenu__cur {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ok);
  font-weight: 600;
}

.mmenu__foot {
  border-top: 1px solid var(--c-border);
  margin-top: 2px;
  padding: var(--sp-1) 2px 0;
}

.mmenu__manage {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  padding: 2px 6px;
}

.mmenu__manage:hover {
  color: var(--c-ink);
}
</style>
