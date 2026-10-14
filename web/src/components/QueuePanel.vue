<script setup lang="ts">
import type { Package, TaskReceipt } from '../api/client'
import PackageList from './PackageList.vue'

/** 队列：任务包排进去，一键开始——包内并行、包间串行（mock 模拟执行；真实派发 R-M2 接入）。 */
defineProps<{
  packages: Package[]
  taskBusy: Record<string, boolean>
  taskError: Record<string, string>
  queueRunning: boolean
  queueError: string
}>()

const emit = defineEmits<{
  (e: 'start-queue'): void
  (e: 'dispatch', payload: { taskId: string; minutes: number }): void
  (e: 'receipt', payload: { taskId: string; body: TaskReceipt }): void
  (e: 'audit', payload: { taskId: string; result: 'pass' | 'fail'; note: string }): void
}>()
</script>

<template>
  <div class="qp">
    <div class="qp__bar">
      <p class="qp__hint">包内并行 · 包间串行{{ queueRunning ? ' · 执行中…' : '' }}</p>
      <button type="button" class="btn btn--primary btn--sm" :disabled="queueRunning" @click="emit('start-queue')">
        {{ queueRunning ? '执行中…' : '一键开始' }}
      </button>
    </div>
    <p v-if="queueError" class="qp__error">{{ queueError }}</p>
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

<style scoped>
.qp {
  display: grid;
  gap: var(--sp-3);
}

.qp__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.qp__hint {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  margin-right: auto;
}

.qp__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}
</style>
