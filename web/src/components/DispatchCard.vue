<script setup lang="ts">
import { computed } from 'vue'
import type { Package } from '../api/client'
import { TASK_STATUS_LABELS, masterLabel } from '../types'

const props = defineProps<{
  pkg: Package
}>()

const versionRefsText = computed((): string =>
  Object.entries(props.pkg.version_refs)
    .map(([blockId, version]) => `模块${blockId}@${version}`)
    .join('、'),
)
</script>

<template>
  <article class="sub-card sub-card--dispatch" :aria-label="`派发卡 ${pkg.package_id}`">
    <header class="sub-card__head">
      <span class="sub-card__tag">派发</span>
      <span>{{ pkg.package_id }}</span>
      <span class="badge" :class="pkg.origin === 'tech' ? 'badge--reported' : 'badge--ongoing'">
        {{ pkg.origin === 'tech' ? '技术单' : '业务' }}
      </span>
      <span class="sub-card__line">轮次 #{{ pkg.round }}</span>
    </header>
    <ul class="dispatch__tasks">
      <li v-for="task in pkg.tasks" :key="task.task_id" class="dispatch__task">
        <code class="dispatch__task-id">{{ task.task_id }}</code>
        <span class="sub-card__line">{{ masterLabel(task.master) }}</span>
        <span class="badge" :class="`badge--${task.status}`">{{ TASK_STATUS_LABELS[task.status] }}</span>
        <span v-if="task.watchdog_deadline" class="sub-card__line">看门狗 {{ task.watchdog_deadline.slice(11, 16) }}</span>
      </li>
    </ul>
    <p v-if="Object.keys(pkg.version_refs).length > 0" class="sub-card__line">
      版本引用：{{ versionRefsText }}
    </p>
  </article>
</template>

<style scoped>
.dispatch__tasks {
  display: grid;
  gap: 2px;
}

.dispatch__task {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
}

.dispatch__task-id {
  font-family: var(--font-mono);
  color: var(--c-ink);
}
</style>
