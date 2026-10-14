<script setup lang="ts">
import type { VerdictBrief } from '../types'

defineProps<{
  verdict: VerdictBrief
}>()
</script>

<template>
  <article class="sub-card sub-card--verdict" :aria-label="`裁决卡 ${verdict.title}`">
    <header class="sub-card__head">
      <span class="sub-card__tag">裁决</span>
      <span>{{ verdict.title }}</span>
      <span class="badge" :class="verdict.result === 'pass' ? 'badge--approved' : 'badge--rejected'">
        {{ verdict.result === 'pass' ? '通过' : '不通过' }}
      </span>
    </header>
    <p class="sub-card__line">{{ verdict.summary }}</p>
    <ul v-if="verdict.evidence.length > 0" class="ops">
      <li v-for="(line, i) in verdict.evidence" :key="i" class="op op--modify">证据 {{ i + 1 }}：{{ line }}</li>
    </ul>
  </article>
</template>
