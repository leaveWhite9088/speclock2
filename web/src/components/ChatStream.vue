<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { Package, Task } from '../api/client'
import type { FeedRound } from '../types'
import RoundDivider from './RoundDivider.vue'
import ApprovalCard from './ApprovalCard.vue'
import DispatchCard from './DispatchCard.vue'
import ReceiptCard from './ReceiptCard.vue'
import VerdictCard from './VerdictCard.vue'
import Composer from './Composer.vue'

const props = defineProps<{
  feed: FeedRound[]
  emptyNote?: string
  cardBusy: Record<string, boolean>
  cardError: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'approve', cardId: string): void
  (e: 'reject', cardId: string): void
  (e: 'open-card'): void
  (e: 'open-tech'): void
}>()

const el = ref<HTMLElement | null>(null)

/** 对话流自上而下滚动，视图停在最新（底部） */
async function scrollToEnd(): Promise<void> {
  await nextTick()
  if (el.value) el.value.scrollTop = el.value.scrollHeight
}

onMounted(() => {
  void scrollToEnd()
})

watch(
  () => props.feed,
  () => {
    void scrollToEnd()
  },
)

function tasksWithReceipt(pkg: Package): Task[] {
  return pkg.tasks.filter((t) => t.receipt !== null)
}
</script>

<template>
  <div class="chat">
    <div ref="el" class="chat__feed">
      <p v-if="feed.length === 0" class="chat__empty">{{ emptyNote ?? '暂无轮次。批准第一张卡片后，轮次分段线将在此推进。' }}</p>
      <template v-for="fr in feed" :key="fr.info.n">
        <RoundDivider :info="fr.info" />
        <ApprovalCard
          v-for="card in fr.cards"
          :key="card.card_id"
          :card="card"
          :busy="cardBusy[card.card_id] ?? false"
          :error="cardError[card.card_id] ?? ''"
          @approve="emit('approve', card.card_id)"
          @reject="emit('reject', card.card_id)"
        />
        <p
          v-for="v in fr.versions"
          :key="`${fr.info.n}-${v.block_id}-${v.version}`"
          class="chat__version-note"
        >✓ 版本 {{ v.version }} 发布（{{ v.delta_summary ?? '—' }}）</p>
        <DispatchCard v-for="pkg in fr.packages" :key="pkg.package_id" :pkg="pkg" />
        <template v-for="pkg in fr.packages" :key="`rc-${pkg.package_id}`">
          <ReceiptCard v-for="task in tasksWithReceipt(pkg)" :key="task.task_id" :task="task" />
        </template>
        <VerdictCard v-for="ev in fr.verdictEvents" :key="ev.id" :event="ev" />
      </template>
    </div>
    <Composer @open-card="emit('open-card')" @open-tech="emit('open-tech')" />
  </div>
</template>

<style scoped>
.chat {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.chat__feed {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-width: 860px;
  width: 100%;
  margin: 0 auto;
}

.chat__empty {
  color: var(--c-ink-3);
  padding: var(--sp-5);
  text-align: center;
}

.chat__version-note {
  color: var(--c-ok);
  font-size: var(--fs-12);
  font-family: var(--font-mono);
  padding: 2px var(--sp-2);
}
</style>
