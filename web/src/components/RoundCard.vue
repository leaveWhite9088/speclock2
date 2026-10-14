<script setup lang="ts">
import type { RoundFixture } from '../types'
import ApprovalCard from './ApprovalCard.vue'
import DispatchCard from './DispatchCard.vue'
import ReceiptCard from './ReceiptCard.vue'
import VerdictCard from './VerdictCard.vue'

defineProps<{
  round: RoundFixture
}>()
</script>

<template>
  <section class="round-card" :aria-label="`轮次 #${round.n}`">
    <header class="round-card__head">
      <span class="round-card__no">轮次 #{{ round.n }}</span>
      <span class="badge" :class="round.status === 'ongoing' ? 'badge--ongoing' : 'badge--closed'">
        {{ round.status === 'ongoing' ? '进行中' : '已关闭' }}
      </span>
      <span class="round-card__time">{{ round.openedAt }} 开启</span>
    </header>

    <p v-if="round.summary" class="round-card__summary">{{ round.summary }}</p>

    <div class="round-card__cards">
      <template v-for="(item, i) in round.cards" :key="i">
        <ApprovalCard v-if="item.kind === 'approval'" :card="item.card" />
        <DispatchCard v-else-if="item.kind === 'dispatch'" :task="item.task" />
        <ReceiptCard v-else-if="item.kind === 'receipt'" :receipt="item.receipt" />
        <VerdictCard v-else-if="item.kind === 'verdict'" :verdict="item.verdict" />
      </template>
      <p v-if="round.cards.length === 0" class="round-card__empty">本轮暂无卡片</p>
    </div>

    <!-- 子卡片槽位：后续切片扩展（对话气泡等） -->
    <slot />
  </section>
</template>

<style scoped>
.round-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  box-shadow: var(--shadow-card);
  padding: var(--sp-3) var(--sp-4);
  display: grid;
  gap: var(--sp-2);
}

.round-card__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.round-card__no {
  font-weight: 700;
  font-size: var(--fs-14);
}

.round-card__time {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  margin-left: auto;
}

.round-card__summary {
  color: var(--c-ink-2);
  font-size: var(--fs-13);
}

.round-card__cards {
  display: grid;
  gap: var(--sp-3);
}

.round-card__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
  padding: var(--sp-2);
  border: 1px dashed var(--c-border);
  border-radius: var(--radius-s);
  text-align: center;
}
</style>
