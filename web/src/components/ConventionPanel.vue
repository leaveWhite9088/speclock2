<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { ApiClient, Convention } from '../api/client'

/**
 * 全局约定：一份文档——约定全项目生效的细节性、全局性问题
 * （错误格式、分页、时间、金额、枚举……）。直接编辑、直接保存，
 * 没有草稿/审批流；平时由核心代理维护，要调整就在对话里告诉它。
 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
}>()

const convention = ref<Convention | null>(null)
const loading = ref(false)
const error = ref('')

const editing = ref(false)
const editText = ref('')
const saving = ref(false)

async function load(): Promise<void> {
  if (!props.client || !props.slug) return
  loading.value = true
  error.value = ''
  try {
    convention.value = await props.client.getConvention(props.slug)
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
    editing.value = false
    void load()
  },
)

function startEdit(): void {
  editText.value = convention.value?.content_md ?? ''
  editing.value = true
  error.value = ''
}

function cancelEdit(): void {
  editing.value = false
}

async function save(): Promise<void> {
  if (!props.client || saving.value) return
  saving.value = true
  error.value = ''
  try {
    // 保存即生效（版本落档在账本里完成，界面上不暴露草稿/审批概念）
    await props.client.updateConventionDraft(props.slug, { content_md: editText.value })
    convention.value = await props.client.approveConvention(props.slug, {
      说明: '更新全局约定',
      动机: '核心代理维护（或人工在约定面板直接修改）',
    })
    editing.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="conv">
    <p v-if="loading && !convention" class="conv__note">加载中…</p>
    <p v-else-if="error && !convention" class="conv__note conv__note--error">加载失败：{{ error }}</p>
    <template v-else-if="convention">
      <p class="conv__hint">
        全局约定是全项目生效的细节性约定（错误格式、分页、时间、金额、枚举…）。
        平时由<b>核心代理</b>维护——要调整，直接在对话里告诉它；也可以在这里手动改。
      </p>

      <div v-if="!editing" class="conv__view">
        <pre class="conv__pre">{{ convention.content_md || '（空文档——点「编辑」写入第一份约定，或让核心代理起草）' }}</pre>
        <div class="conv__bar">
          <span class="conv__ver">版本 {{ convention.version ?? '—' }}</span>
          <button type="button" class="btn btn--sm" @click="startEdit">编辑</button>
        </div>
      </div>

      <div v-else class="conv__edit">
        <textarea v-model="editText" class="conv__editor" rows="14" :disabled="saving"></textarea>
        <div class="conv__bar">
          <span class="conv__note">{{ saving ? '保存中…' : '保存后立即对全项目生效' }}</span>
          <button type="button" class="btn btn--sm" :disabled="saving" @click="cancelEdit">取消</button>
          <button type="button" class="btn btn--sm btn--primary" :disabled="saving" @click="save">保存</button>
        </div>
      </div>

      <p v-if="error && convention" class="conv__note conv__note--error">{{ error }}</p>
    </template>
  </div>
</template>

<style scoped>
.conv {
  display: grid;
  gap: var(--sp-3);
}

.conv__hint {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  background: var(--c-panel-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-2) var(--sp-3);
}

.conv__note {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.conv__note--error {
  color: var(--c-danger);
  word-break: break-all;
}

.conv__view,
.conv__edit {
  display: grid;
  gap: var(--sp-2);
}

.conv__pre {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-3);
  white-space: pre-wrap;
}

.conv__editor {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: var(--sp-3);
  background: var(--c-panel);
  color: var(--c-ink);
  resize: vertical;
  min-height: 240px;
}

.conv__editor:focus {
  outline: none;
  border-color: var(--c-ink-3);
}

.conv__bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.conv__ver {
  margin-right: auto;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  font-family: var(--font-mono);
}
</style>
