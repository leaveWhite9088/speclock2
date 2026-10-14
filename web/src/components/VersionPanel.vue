<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApiClient, FeedVersion, VersionDetail } from '../api/client'
import DraftViewer from './DraftViewer.vue'

/** 查看版本：每次批准生成一个版本；点开看当时那份 API 契约与业务规则的完整快照。 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
  versions: FeedVersion[]
  blockTitles: Record<string, string>
}>()

const selected = ref<VersionDetail | null>(null)
const loading = ref(false)
const error = ref('')

const sorted = computed(() =>
  [...props.versions].sort((a, b) => b.round - a.round || b.version.localeCompare(a.version)),
)

function blockName(id: string): string {
  return props.blockTitles[id] ?? `模块${id}`
}

async function open(v: FeedVersion): Promise<void> {
  if (!props.client) return
  loading.value = true
  error.value = ''
  selected.value = null
  try {
    selected.value = await props.client.getBlockVersion(props.slug, v.block_id, v.version)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function back(): void {
  selected.value = null
  error.value = ''
}
</script>

<template>
  <div class="vp">
    <template v-if="!selected">
      <p v-if="sorted.length === 0" class="vp__empty">暂无版本。每次批准在这里产生一个不可变快照。</p>
      <ul v-else class="vp__list">
        <li v-for="v in sorted" :key="`${v.block_id}-${v.version}-${v.round}`">
          <button type="button" class="vp__item" @click="open(v)">
            <span class="vp__ver">{{ v.version }}</span>
            <span class="vp__meta">轮次 #{{ v.round }} · {{ blockName(v.block_id) }}</span>
            <span v-if="v.delta_summary" class="vp__delta">{{ v.delta_summary }}</span>
            <span class="vp__stmt">{{ v.statement.说明 }}</span>
          </button>
        </li>
      </ul>
    </template>

    <template v-else>
      <button type="button" class="vp__back" @click="back">← 返回版本列表</button>
      <header class="vp__detail-head">
        <span class="vp__ver vp__ver--big">{{ selected.version }}</span>
        <span class="vp__meta">轮次 #{{ selected.round }} · {{ blockName(selected.block_id) }}</span>
      </header>
      <p class="vp__stmt-detail">说明：{{ selected.statement.说明 }}　动机：{{ selected.statement.动机 }}</p>
      <p v-if="selected.delta_summary" class="vp__delta-detail">本版变更：{{ selected.delta_summary }}</p>
      <DraftViewer :block="{
        id: selected.block_id,
        title: blockName(selected.block_id),
        status: 'published',
        current_published_version: selected.version,
        draft: selected.draft,
        versions: [],
      }" />
    </template>

    <p v-if="loading" class="vp__empty">加载版本快照中…</p>
    <p v-else-if="error" class="vp__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.vp {
  display: grid;
  gap: var(--sp-3);
  align-content: start;
}

.vp__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.vp__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.vp__list {
  display: grid;
  gap: var(--sp-1);
}

.vp__item {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  text-align: left;
}

.vp__item:hover {
  border-color: var(--c-border-strong);
}

.vp__ver {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--c-ink);
}

.vp__ver--big {
  font-size: var(--fs-16);
}

.vp__meta {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.vp__delta {
  grid-column: 2;
  color: var(--c-ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.vp__stmt {
  grid-column: 1 / -1;
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp__back {
  justify-self: start;
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  padding: 2px 0;
}

.vp__back:hover {
  color: var(--c-ink);
}

.vp__detail-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.vp__stmt-detail,
.vp__delta-detail {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}
</style>
