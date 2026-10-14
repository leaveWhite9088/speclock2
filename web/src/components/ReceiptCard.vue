<script setup lang="ts">
import type { ReceiptSubmission } from '../api/client'

defineProps<{
  receipt: ReceiptSubmission
}>()
</script>

<template>
  <article class="sub-card sub-card--receipt" :aria-label="`回执卡 ${receipt.task_id}`">
    <header class="sub-card__head">
      <span class="sub-card__tag">回执</span>
      <span>任务 {{ receipt.task_id }}</span>
    </header>
    <p class="sub-card__line">改动文件：{{ receipt.files_changed.join('、') || '（无）' }}</p>
    <p class="sub-card__line">自检：{{ receipt.self_check }}</p>
    <p class="sub-card__line">摘要：{{ receipt.summary }}</p>
  </article>
</template>
