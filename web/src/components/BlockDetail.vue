<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ApiClient, FeedVersion, TreeBlockNode, VersionDetail } from '../api/client'
import DraftViewer from './DraftViewer.vue'

/**
 * 模块视图（v1 BlockView 的 v2 版）：完整快照阅读——业务背景/规则/契约/NFR，
 * 版本下拉切换（草稿=当前编辑面，历史版本=当时快照），版本历史表。
 * 只读：修改走核心代理的审批卡片。
 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
  block: TreeBlockNode | null
  versionsByBlock: Record<string, FeedVersion[]>
}>()

const selected = ref('') // '' = 草稿（当前）
const snapshot = ref<VersionDetail | null>(null)
const draftLoading = ref(false)
const draftError = ref('')
const snapError = ref('')

const draft = ref<import('../api/client').Block | null>(null)

const versions = computed(() =>
  [...(props.block ? (props.versionsByBlock[props.block.id] ?? []) : [])].sort(
    (a, b) => b.round - a.round,
  ),
)

watch(
  () => [props.client, props.slug, props.block?.id],
  () => {
    selected.value = props.block?.current_published_version ?? ''
    snapshot.value = null
    draft.value = null
    draftError.value = ''
    snapError.value = ''
    void loadCurrent()
  },
  { immediate: true },
)

async function loadCurrent(): Promise<void> {
  if (!props.client || !props.block) return
  if (selected.value) {
    await loadSnapshot(selected.value)
    return
  }
  draftLoading.value = true
  try {
    draft.value = await props.client.getBlock(props.slug, props.block.id)
  } catch (err) {
    draftError.value = err instanceof Error ? err.message : String(err)
  } finally {
    draftLoading.value = false
  }
}

async function loadSnapshot(version: string): Promise<void> {
  if (!props.client || !props.block) return
  snapshot.value = null
  snapError.value = ''
  try {
    snapshot.value = await props.client.getBlockVersion(props.slug, props.block.id, version)
  } catch (err) {
    snapError.value = err instanceof Error ? err.message : String(err)
  }
}

function pickVersion(v: string): void {
  selected.value = v
  snapshot.value = null
  draft.value = null
  if (v) void loadSnapshot(v)
  else void loadCurrent()
}

const shown = computed(() => {
  if (selected.value && snapshot.value) {
    return {
      version: snapshot.value.version,
      round: snapshot.value.round,
      statement: snapshot.value.statement,
      delta: snapshot.value.delta_summary,
      draft: snapshot.value.draft,
    }
  }
  return null
})
</script>

<template>
  <div class="bd">
    <template v-if="block">
      <header class="bd__head">
        <div class="bd__titlerow">
          <h1 class="bd__title">{{ block.title }}</h1>
          <span class="bd__id mono">#{{ block.id }}</span>
          <span class="bd__status" :class="{ 'bd__status--pub': block.status === 'published' }">
            {{ block.status === 'published' ? '已发布' : '草稿' }}
          </span>
        </div>
        <div class="bd__selrow">
          <span class="bd__selabel mono">version</span>
          <span v-if="selected" class="bd__verchip">v{{ selected }}</span>
          <span v-else class="bd__verchip bd__verchip--draft">草稿</span>
          <select
            v-if="versions.length > 0"
            class="bd__select"
            :value="selected"
            aria-label="切换版本"
            @change="pickVersion(($event.target as HTMLSelectElement).value)"
          >
            <option value="">草稿（当前）</option>
            <option v-for="v in versions" :key="v.version" :value="v.version">
              v{{ v.version }} · 轮次 #{{ v.round }}{{ v.delta_summary ? ` · ${v.delta_summary}` : '' }}
            </option>
          </select>
        </div>
        <p v-if="shown" class="bd__meta">
          说明：{{ shown.statement.说明 }}　动机：{{ shown.statement.动机 }}　·　轮次 #{{ shown.round }}
        </p>
        <p class="bd__hint">只读浏览——修改走核心代理：在对话里提需求，它起草审批卡片，你批准后生效。</p>
      </header>

      <p v-if="draftLoading || (selected && !snapshot && !snapError)" class="bd__note">加载中…</p>
      <p v-else-if="snapError" class="bd__note bd__note--error">快照加载失败：{{ snapError }}</p>
      <p v-else-if="draftError" class="bd__note bd__note--error">草稿加载失败：{{ draftError }}</p>

      <DraftViewer
        v-else-if="shown"
        :block="{ id: block.id, title: block.title, status: 'published', current_published_version: shown.version, draft: shown.draft, versions: [] }"
      />
      <DraftViewer v-else-if="draft" :block="draft" />

      <section v-if="versions.length" class="bd__sec">
        <h2 class="bd__sec-title">版本历史（{{ versions.length }}）</h2>
        <table class="bd__table">
          <thead>
            <tr><th>版本</th><th>轮次</th><th>说明</th><th>变更</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.version" :class="{ 'bd__row--cur': v.version === selected }">
              <td><span class="bd__verchip">v{{ v.version }}</span></td>
              <td class="mono">#{{ v.round }}</td>
              <td class="bd__stmt">{{ v.statement.说明 }}</td>
              <td class="bd__delta">{{ v.delta_summary ?? '—' }}</td>
              <td>
                <button v-if="v.version !== selected" type="button" class="btn btn--ghost btn--sm" @click="pickVersion(v.version)">查看</button>
                <span v-else class="bd__curtag">当前查看</span>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
    <p v-else class="bd__note">模块不存在（可能已被删除）。</p>
  </div>
</template>

<style scoped>
.bd {
  padding: var(--sp-4);
  display: grid;
  gap: var(--sp-4);
  align-content: start;
}

.bd__head {
  display: grid;
  gap: var(--sp-1);
}

.bd__titlerow {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.bd__title {
  font-size: 18px;
  font-weight: 700;
}

.bd__id {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
}

.bd__status {
  font-size: var(--fs-13);
  padding: 0 var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  color: var(--c-ink-2);
}

.bd__status--pub {
  color: var(--c-ok);
  border-color: var(--c-ok-border);
}

.bd__selrow {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.bd__selabel {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
}

.bd__verchip {
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  color: var(--c-ok);
  border: 1px solid var(--c-ok-border);
  border-radius: var(--radius-s);
  padding: 0 6px;
  line-height: 18px;
}

.bd__verchip--draft {
  color: var(--c-ink-2);
  border-color: var(--c-border-strong);
}

.bd__select {
  font: inherit;
  font-size: var(--fs-13);
  color: var(--c-ink-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: 2px 6px;
  background: var(--c-panel);
  max-width: 280px;
}

.bd__meta {
  color: var(--c-ink-2);
  font-size: var(--fs-13);
}

.bd__hint {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
  background: var(--c-panel-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-1) var(--sp-2);
  justify-self: start;
}

.bd__note {
  color: var(--c-ink-3);
}

.bd__note--error {
  color: var(--c-danger);
}

.bd__sec {
  display: grid;
  gap: var(--sp-2);
}

.bd__sec-title {
  font-size: var(--fs-13);
  font-weight: 600;
}

.bd__table {
  width: 100%;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  border-collapse: collapse;
  font-size: var(--fs-13);
}

.bd__table th {
  text-align: left;
  font-weight: 500;
  color: var(--c-ink-3);
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
}

.bd__table td {
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
}

.bd__table tr:last-child td {
  border-bottom: none;
}

.bd__row--cur {
  background: var(--c-panel-2);
}

.bd__stmt {
  color: var(--c-ink-2);
}

.bd__delta {
  color: var(--c-ink-2);
  font-family: var(--font-mono);
}

.bd__curtag {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
}
</style>
