<script setup lang="ts">
import { computed } from 'vue'
import type { Event } from '../api/client'

const props = defineProps<{
  event: Event
}>()

const result = computed((): 'pass' | 'fail' => (props.event.type.endsWith('passed') ? 'pass' : 'fail'))
const taskId = computed((): string => String(props.event.ref.task ?? ''))
const note = computed((): string => {
  const raw = props.event.payload.note
  return typeof raw === 'string' ? raw : ''
})
</script>

<template>
  <article class="sub-card sub-card--verdict" :aria-label="`裁决卡 ${event.id}`">
    <header class="sub-card__head">
      <span class="sub-card__tag">裁决</span>
      <span>验收 · {{ taskId }}</span>
      <span class="badge" :class="result === 'pass' ? 'badge--approved' : 'badge--rejected'">
        {{ result === 'pass' ? '通过' : '不通过' }}
      </span>
    </header>
    <p class="sub-card__line">{{ note || (result === 'pass' ? '契约测试通过' : '契约测试未通过') }}</p>
  </article>
</template>
