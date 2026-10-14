<script setup lang="ts">
import type { TaskBrief } from '../types'

defineProps<{
  task: TaskBrief
}>()
</script>

<template>
  <article class="sub-card sub-card--dispatch" :aria-label="`派发卡 ${task.task_id}`">
    <header class="sub-card__head">
      <span class="sub-card__tag">派发</span>
      <span>任务 {{ task.task_id }}</span>
    </header>
    <p class="sub-card__line">主代理 {{ task.master }} ｜ harness {{ task.harness }} ｜ 状态 {{ task.status }}</p>
  </article>
</template>
