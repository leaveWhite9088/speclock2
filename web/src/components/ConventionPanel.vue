<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { ApiClient, Convention } from '../api/client'

/** 全局约定面板：查看当前版 / 编辑草稿 / 批准（DESIGN.md §5.5，契约 v0.2 三端点） */
const props = defineProps<{
  client: ApiClient | null
  slug: string
}>()

const convention = ref<Convention | null>(null)
const loading = ref(false)
const error = ref('')

const draftMd = ref('')
const approveDesc = ref('')
const approveMotive = ref('')
const saving = ref(false)
const approving = ref(false)

async function load(): Promise<void> {
  if (!props.client || !props.slug) return
  loading.value = true
  error.value = ''
  try {
    convention.value = await props.client.getConvention(props.slug)
    draftMd.value = convention.value.draft_md ?? ''
  } catch (err) {
    convention.value = null
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void load()
})

watch(
  () => props.slug,
  () => {
    approveDesc.value = ''
    approveMotive.value = ''
    void load()
  },
)

async function saveDraft(): Promise<void> {
  if (!props.client) return
  saving.value = true
  error.value = ''
  try {
    convention.value = await props.client.updateConventionDraft(props.slug, { content_md: draftMd.value })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function approve(): Promise<void> {
  if (!props.client) return
  if (!approveDesc.value.trim() || !approveMotive.value.trim()) {
    error.value = '批准需填写说明与动机'
    return
  }
  approving.value = true
  error.value = ''
  try {
    if (draftMd.value.trim() !== '' && draftMd.value !== convention.value?.draft_md) {
      convention.value = await props.client.updateConventionDraft(props.slug, { content_md: draftMd.value })
    }
    convention.value = await props.client.approveConvention(props.slug, {
      说明: approveDesc.value.trim(),
      动机: approveMotive.value.trim(),
    })
    approveDesc.value = ''
    approveMotive.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    approving.value = false
  }
}
</script>

<template>
  <div class="conv">
    <p v-if="loading && !convention" class="conv__note">加载中…</p>
    <p v-else-if="error && !convention" class="conv__note conv__note--error">加载失败：{{ error }}</p>
    <template v-else-if="convention">
      <header class="conv__head">
        <span>当前版本 <code>{{ convention.version ?? '—' }}</code></span>
        <span v-if="convention.statement" class="conv__stmt">{{ convention.statement.说明 }}</span>
      </header>

      <section class="conv__sec">
        <h5 class="conv__sec-title">当前版内容</h5>
        <pre v-if="convention.content_md" class="conv__pre">{{ convention.content_md }}</pre>
        <p v-else class="conv__note">暂无已批准版本。编辑草稿并批准后，第一版在此产生。</p>
      </section>

      <section class="conv__sec">
        <h5 class="conv__sec-title">草稿（编辑后保存；批准后成为新版本）</h5>
        <textarea v-model="draftMd" class="conv__editor" rows="8" :disabled="saving || approving"></textarea>
        <div class="conv__row">
          <button type="button" class="btn btn--sm" :disabled="saving || approving" @click="saveDraft">
            {{ saving ? '保存中…' : '保存草稿' }}
          </button>
          <span v-if="convention.draft_md" class="conv__hint">有待批准草稿</span>
        </div>
      </section>

      <section class="conv__sec">
        <h5 class="conv__sec-title">批准草稿</h5>
        <div class="conv__grid2">
          <label class="conv__field">说明
            <input v-model="approveDesc" class="conv__input" type="text" :disabled="approving" placeholder="一句话，动词开头" />
          </label>
          <label class="conv__field">动机
            <input v-model="approveMotive" class="conv__input" type="text" :disabled="approving" placeholder="为什么改" />
          </label>
        </div>
        <button type="button" class="btn btn--sm btn--primary" :disabled="saving || approving" @click="approve">
          {{ approving ? '批准中…' : '批准（产生 ConventionVersion）' }}
        </button>
      </section>

      <p v-if="error && convention" class="conv__note conv__note--error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.conv {
  display: grid;
  gap: var(--sp-3);
}

.conv__note {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.conv__note--error {
  color: var(--c-danger);
  word-break: break-all;
}

.conv__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
  font-size: var(--fs-13);
}

.conv__head code {
  font-family: var(--font-mono);
  color: var(--c-accent);
  font-weight: 700;
}

.conv__stmt {
  color: var(--c-ink-2);
}

.conv__sec {
  display: grid;
  gap: var(--sp-2);
}

.conv__sec-title {
  font-size: var(--fs-12);
  font-weight: 600;
  color: var(--c-ink-3);
}

.conv__pre {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  background: var(--c-mono-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  white-space: pre-wrap;
  max-height: 180px;
  overflow-y: auto;
}

.conv__editor {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  background: var(--c-panel);
  color: var(--c-ink);
  resize: vertical;
}

.conv__editor:focus {
  outline: none;
  border-color: var(--c-accent);
}

.conv__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.conv__hint {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
}

.conv__grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
}

.conv__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.conv__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 4px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-panel);
  color: var(--c-ink);
}

.conv__input:focus {
  outline: none;
  border-color: var(--c-accent);
}
</style>
