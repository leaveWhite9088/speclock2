<script setup lang="ts">
import { computed } from 'vue'
import type { Package } from '../api/client'
import { masterLabel } from '../types'
import TaskRow from './TaskRow.vue'

const props = defineProps<{
  packages: Package[]
  taskBusy: Record<string, boolean>
  taskError: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'dispatch', payload: { taskId: string; minutes: number }): void
  (e: 'receipt', payload: { taskId: string; body: import('../api/client').TaskReceipt }): void
  (e: 'audit', payload: { taskId: string; result: 'pass' | 'fail'; note: string }): void
}>()

const ACTIVE_STATES = ['queued', 'dispatched', 'running', 'reported', 'auditing', 'timeout']

function isActive(pkg: Package): boolean {
  return pkg.tasks.some((t) => ACTIVE_STATES.includes(t.status))
}

/** 活动包在前、同组按轮次倒序 */
const sorted = computed(() => {
  const active = props.packages.filter(isActive).reverse()
  const finished = props.packages.filter((p) => !isActive(p)).reverse()
  return [...active, ...finished]
})
</script>

<template>
  <div class="pkglist">
    <p v-if="packages.length === 0" class="pkglist__empty">暂无任务包。批准卡片或创建技术任务单后出现在这里。</p>
    <section
      v-for="pkg in sorted"
      :key="pkg.package_id"
      class="pkglist__pkg"
      :class="{ 'pkglist__pkg--active': isActive(pkg) }"
    >
      <header class="pkglist__head">
        <span class="pkglist__id">{{ pkg.package_id }}</span>
        <span class="badge" :class="pkg.origin === 'tech' ? 'badge--reported' : 'badge--ongoing'">
          {{ pkg.origin === 'tech' ? '技术单' : '业务' }}
        </span>
        <span v-if="pkg.tasks.length > 1" class="pkglist__par">
          并行 {{ pkg.tasks.length }} 个任务：{{ pkg.tasks.map((t) => masterLabel(t.master)).join('、') }}
        </span>
        <span class="pkglist__round">轮次 #{{ pkg.round }}</span>
      </header>
      <div class="pkglist__tasks">
        <TaskRow
          v-for="task in pkg.tasks"
          :key="task.task_id"
          :task="task"
          :busy="taskBusy[task.task_id] ?? false"
          :error="taskError[task.task_id] ?? ''"
          @dispatch="emit('dispatch', $event)"
          @receipt="emit('receipt', $event)"
          @audit="emit('audit', $event)"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.pkglist {
  display: grid;
  gap: var(--sp-3);
}

.pkglist__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
  padding: var(--sp-2);
}

.pkglist__pkg {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
}

.pkglist__pkg--active {
  border-color: var(--c-accent-border);
}

.pkglist__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-13);
}

.pkglist__id {
  font-family: var(--font-mono);
  font-weight: 700;
}

.pkglist__par {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
}

.pkglist__round {
  margin-left: auto;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.pkglist__tasks {
  display: grid;
  gap: var(--sp-2);
}
</style>
