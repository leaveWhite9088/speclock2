<script setup lang="ts">
import type { Task } from '../api/client'
import { masterLabel } from '../types'

defineProps<{
  task: Task
}>()
</script>

<template>
  <article class="sub-card sub-card--receipt" :aria-label="`回执卡 ${task.task_id}`">
    <header class="sub-card__head">
      <span class="sub-card__tag">回执</span>
      <span>{{ task.task_id }}</span>
      <span class="sub-card__line">{{ masterLabel(task.master) }}</span>
    </header>
    <p class="sub-card__line">改动文件：{{ task.receipt?.files_changed.join('、') || '（无）' }}</p>
    <p class="sub-card__line">自检：{{ task.receipt?.self_check }}</p>
    <p class="sub-card__line">摘要：{{ task.receipt?.summary }}</p>
  </article>
</template>
