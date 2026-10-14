<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import type { RoundFixture } from '../types'
import RoundCard from './RoundCard.vue'

const props = defineProps<{
  rounds: RoundFixture[]
  placeholder?: string
}>()

const el = ref<HTMLElement | null>(null)

/** 自底向上：最新轮次位于底部，视图停在最新一轮（对话式时间线） */
async function scrollToEnd(): Promise<void> {
  await nextTick()
  if (el.value) el.value.scrollTop = el.value.scrollHeight
}

onMounted(() => {
  void scrollToEnd()
})

watch(
  () => props.rounds,
  () => {
    void scrollToEnd()
  },
)
</script>

<template>
  <div ref="el" class="timeline">
    <p v-if="rounds.length === 0" class="timeline__empty">{{ placeholder ?? '暂无轮次数据。' }}</p>
    <RoundCard v-for="round in rounds" :key="round.n" :round="round" />
  </div>
</template>

<style scoped>
.timeline {
  height: 100%;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.timeline__empty {
  color: var(--c-ink-3);
  padding: var(--sp-5);
  text-align: center;
}
</style>
