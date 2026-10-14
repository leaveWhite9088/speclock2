<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ApiClient, Stats } from '../api/client'

/** 仪表盘：GET /stats 计数卡（契约 v0.2；三层监控的账本投影，A5） */
const props = defineProps<{
  client: ApiClient | null
  slug: string
}>()

const stats = ref<Stats | null>(null)
const loading = ref(false)
const error = ref('')

async function load(): Promise<void> {
  if (!props.client || !props.slug) return
  loading.value = true
  error.value = ''
  try {
    stats.value = await props.client.getStats(props.slug)
  } catch (err) {
    stats.value = null
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div class="dash">
    <p v-if="loading && !stats" class="dash__note">加载中…</p>
    <p v-else-if="error" class="dash__note dash__note--error">加载失败：{{ error }}
      <button type="button" class="dash__retry" @click="load">重试</button>
    </p>
    <template v-else-if="stats">
      <section class="dash__group">
        <h5 class="dash__group-title">轮次</h5>
        <div class="dash__cards">
          <div class="dash__card"><span class="dash__num">{{ stats.rounds.count }}</span><span class="dash__label">已关闭</span></div>
          <div class="dash__card"><span class="dash__num">{{ stats.rounds.open }}</span><span class="dash__label">当前轮</span></div>
        </div>
      </section>
      <section class="dash__group">
        <h5 class="dash__group-title">卡片</h5>
        <div class="dash__cards">
          <div class="dash__card"><span class="dash__num">{{ stats.cards.pending }}</span><span class="dash__label">待批准</span></div>
          <div class="dash__card"><span class="dash__num">{{ stats.cards.approved }}</span><span class="dash__label">已批准</span></div>
          <div class="dash__card"><span class="dash__num">{{ stats.cards.rejected }}</span><span class="dash__label">已打回</span></div>
        </div>
      </section>
      <section class="dash__group">
        <h5 class="dash__group-title">任务包</h5>
        <div class="dash__cards">
          <div class="dash__card"><span class="dash__num">{{ stats.packages.active }}</span><span class="dash__label">活动中</span></div>
          <div class="dash__card"><span class="dash__num">{{ stats.packages.done }}</span><span class="dash__label">已完成</span></div>
        </div>
      </section>
      <section class="dash__group">
        <h5 class="dash__group-title">任务</h5>
        <div class="dash__cards">
          <div class="dash__card dash__card--alert"><span class="dash__num">{{ stats.tasks.rejected }}</span><span class="dash__label">打回</span></div>
          <div class="dash__card dash__card--alert"><span class="dash__num">{{ stats.tasks.timeout }}</span><span class="dash__label">超时</span></div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.dash {
  display: grid;
  gap: var(--sp-3);
}

.dash__note {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.dash__note--error {
  color: var(--c-danger);
  word-break: break-all;
}

.dash__retry {
  color: var(--c-accent);
  text-decoration: underline;
  font-size: var(--fs-12);
}

.dash__group {
  display: grid;
  gap: var(--sp-2);
}

.dash__group-title {
  font-size: var(--fs-12);
  font-weight: 600;
  color: var(--c-ink-3);
}

.dash__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: var(--sp-2);
}

.dash__card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  background: var(--c-panel-2);
  padding: var(--sp-2);
  display: grid;
  gap: 0;
}

.dash__card--alert {
  border-color: var(--c-danger-border);
  background: var(--c-danger-bg);
}

.dash__num {
  font-size: var(--fs-18);
  font-weight: 700;
  font-family: var(--font-mono);
}

.dash__card--alert .dash__num {
  color: var(--c-danger);
}

.dash__label {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}
</style>
