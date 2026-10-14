<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Package, TaskReceipt } from '../api/client'
import PackageList from './PackageList.vue'

const props = defineProps<{
  packages: Package[]
  taskBusy: Record<string, boolean>
  taskError: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'dispatch', payload: { taskId: string; minutes: number }): void
  (e: 'receipt', payload: { taskId: string; body: TaskReceipt }): void
  (e: 'audit', payload: { taskId: string; result: 'pass' | 'fail'; note: string }): void
}>()

const collapsed = ref(false)

const activeCount = computed(
  () =>
    props.packages.filter((p) =>
      p.tasks.some((t) => !['done', 'rejected'].includes(t.status)),
    ).length,
)
</script>

<template>
  <aside class="rightpanel" :class="{ 'rightpanel--collapsed': collapsed }">
    <button
      v-if="collapsed"
      type="button"
      class="rightpanel__fold"
      title="展开右面板"
      @click="collapsed = false"
    >◂</button>
    <template v-else>
      <header class="rightpanel__head">
        <span>当前任务包</span>
        <span v-if="activeCount > 0" class="badge badge--ongoing">{{ activeCount }} 活动中</span>
        <button
          type="button"
          class="rightpanel__fold"
          title="折叠右面板，让宽给对话"
          @click="collapsed = true"
        >▸</button>
      </header>
      <div class="rightpanel__body">
        <PackageList
          :packages="packages"
          :task-busy="taskBusy"
          :task-error="taskError"
          @dispatch="emit('dispatch', $event)"
          @receipt="emit('receipt', $event)"
          @audit="emit('audit', $event)"
        />
      </div>
    </template>
  </aside>
</template>

<style scoped>
.rightpanel {
  width: var(--right-panel-w, 320px);
  border-left: 1px solid var(--c-border);
  background: var(--c-panel);
  overflow-y: auto;
}

.rightpanel--collapsed {
  width: 32px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: var(--sp-3);
}

.rightpanel__fold {
  color: var(--c-ink-3);
  padding: 2px 6px;
}

.rightpanel__fold:hover {
  color: var(--c-accent);
}

.rightpanel__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px var(--sp-3);
  font-size: var(--fs-12);
  font-weight: 600;
  color: var(--c-ink-3);
  border-bottom: 1px solid var(--c-border);
  position: sticky;
  top: 0;
  background: var(--c-panel);
  z-index: 1;
}

.rightpanel__head .rightpanel__fold {
  margin-left: auto;
}

.rightpanel__body {
  padding: var(--sp-3);
}
</style>
