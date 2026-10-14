<script setup lang="ts">
import type { RoundInfo } from '../api/client'

defineProps<{
  info: RoundInfo
}>()
</script>

<template>
  <div
    class="round-divider"
    :class="{ 'round-divider--open': !info.closed_at }"
    :aria-label="`轮次 #${info.n}`"
  >
    <span class="round-divider__line" aria-hidden="true"></span>
    <span class="round-divider__label">
      轮次 #{{ info.n }}<span class="round-divider__state"> · {{ info.closed_at ? '已关闭' : '进行中' }}</span>
    </span>
    <span class="round-divider__line" aria-hidden="true"></span>
  </div>
</template>

<style scoped>
.round-divider {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin: var(--sp-2) 0;
}

.round-divider__line {
  flex: 1;
  border-top: 1px dashed var(--c-border-strong);
}

.round-divider__label {
  font-size: var(--fs-13);
  font-weight: 700;
  color: var(--c-ink-2);
  white-space: nowrap;
}

.round-divider--open .round-divider__label {
  color: var(--c-accent);
}

.round-divider__state {
  font-weight: 400;
  color: var(--c-ink-3);
}

.round-divider--open .round-divider__state {
  color: var(--c-accent);
}
</style>
