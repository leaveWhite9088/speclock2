<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ApiClient, ProtocolText, RolePreview, RoleTarget } from '../api/client'
import { setDirty } from '../composables/useDirtyGuard'

/**
 * 角色文档（AGENTS.md）编辑：核心代理与主代理共用。
 * 可编辑段由用户维护；协议段由系统追加，只能在“实际注入内容”里只读查看。
 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
  target: RoleTarget
  /** 仅核心代理：重建会话的状态，入口复用 App 已有的重建逻辑 */
  resetBusy?: boolean
  resetUnsupported?: boolean
  resetDoneTick?: number
}>()

const emit = defineEmits<{ (e: 'reset-agent'): void }>()

const saved = ref('')
const text = ref('')
const isDefault = ref(true)
const needsRestart = ref(false)
const loading = ref(false)
const saving = ref(false)
const error = ref('')

const previewOpen = ref(false)
const preview = ref<RolePreview | null>(null)
const previewError = ref('')

const protocolOpen = ref(false)
const protocol = ref<ProtocolText | null>(null)
const protocolError = ref('')

const dirty = computed(() => text.value !== saved.value)
const dirtyKey = computed(() => `role:${props.slug}:${props.target.kind === 'chief' ? 'chief' : props.target.name}`)
const isChief = computed(() => props.target.kind === 'chief')

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function load(keepDraft = false): Promise<void> {
  if (!props.client) return
  loading.value = true
  try {
    const doc = await props.client.getRole(props.slug, props.target)
    needsRestart.value = isChief.value && doc.needs_restart
    isDefault.value = doc.is_default
    if (!keepDraft || !dirty.value) text.value = doc.content
    saved.value = doc.content
    error.value = ''
  } catch (e) {
    error.value = `读取角色文档失败：${errMsg(e)}`
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  if (!props.client || !dirty.value || saving.value) return
  saving.value = true
  try {
    const doc = await props.client.putRole(props.slug, props.target, text.value)
    saved.value = doc.content
    text.value = doc.content
    isDefault.value = doc.is_default
    needsRestart.value = isChief.value && doc.needs_restart
    error.value = ''
    if (previewOpen.value) void loadPreview()
  } catch (e) {
    // 保存失败：文本框内容保留，只显示错误
    error.value = `保存失败：${errMsg(e)}`
  } finally {
    saving.value = false
  }
}

async function restoreDefault(): Promise<void> {
  if (!props.client || saving.value) return
  if (!window.confirm('恢复为默认模板？当前内容（含未保存的修改）会被覆盖。')) return
  saving.value = true
  try {
    await props.client.resetRole(props.slug, props.target)
    text.value = ''
    saved.value = ''
    await load()
    if (previewOpen.value) void loadPreview()
  } catch (e) {
    error.value = `恢复默认失败：${errMsg(e)}`
  } finally {
    saving.value = false
  }
}

async function loadPreview(): Promise<void> {
  if (!props.client) return
  try {
    preview.value = await props.client.previewRole(props.slug, props.target)
    previewError.value = ''
  } catch (e) {
    previewError.value = `读取注入内容失败：${errMsg(e)}`
  }
}

function togglePreview(): void {
  previewOpen.value = !previewOpen.value
  if (previewOpen.value) void loadPreview()
}

async function toggleProtocol(): Promise<void> {
  protocolOpen.value = !protocolOpen.value
  if (!protocolOpen.value || protocol.value || !props.client) return
  try {
    protocol.value = await props.client.getProtocol()
    protocolError.value = ''
  } catch (e) {
    protocolError.value = `读取报告格式失败：${errMsg(e)}`
  }
}

watch(
  () => [props.slug, props.target.kind, props.target.kind === 'master' ? props.target.name : ''],
  () => {
    preview.value = null
    previewOpen.value = false
    void load()
  },
  { immediate: true },
)

// 重建会话完成：刷新 needs_restart，不覆盖未保存的草稿
watch(
  () => props.resetDoneTick,
  () => void load(true),
)

watch([dirty, dirtyKey], ([d, key], [, oldKey]) => {
  if (oldKey && oldKey !== key) setDirty(oldKey, false)
  setDirty(key, d)
})

onBeforeUnmount(() => setDirty(dirtyKey.value, false))
</script>

<template>
  <section class="role">
    <header class="role__head">
      <h6 class="role__title">角色文档</h6>
      <span v-if="!isDefault" class="badge badge--reported role__custom">已自定义</span>
      <span v-if="dirty" class="role__dirty">有未保存的修改</span>
    </header>
    <p class="role__note">协议段由系统追加，不可编辑。这里只改角色说明。</p>

    <p v-if="needsRestart" class="role__restart">
      角色文档已修改，重建会话后生效。
      <button type="button" class="btn btn--sm" :disabled="resetBusy" @click="emit('reset-agent')">
        {{ resetBusy ? '重建中…' : '重建会话' }}
      </button>
      <span v-if="resetUnsupported" class="role__restart-err">后端暂不支持重建会话。</span>
    </p>

    <textarea
      v-model="text"
      class="role__text"
      rows="12"
      spellcheck="false"
      :disabled="loading || !client"
      aria-label="角色文档内容"
    ></textarea>

    <p v-if="error" class="role__error" role="alert">{{ error }}</p>

    <div class="role__actions">
      <button type="button" class="btn btn--primary btn--sm" :disabled="!dirty || saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
      <button type="button" class="btn btn--sm" :disabled="saving || loading" @click="restoreDefault">恢复默认</button>
    </div>

    <div class="role__fold">
      <button type="button" class="role__toggle" :aria-expanded="previewOpen" @click="togglePreview">
        {{ previewOpen ? '▾' : '▸' }} 查看实际注入内容
      </button>
      <div v-if="previewOpen" class="role__body">
        <p v-if="previewError" class="role__error">{{ previewError }}</p>
        <template v-else-if="preview">
          <p class="role__counts">
            可编辑段 <b>{{ preview.editable_chars }}</b> 字 · 协议段 <b>{{ preview.protocol_chars }}</b> 字
          </p>
          <pre class="role__pre">{{ preview.composed }}</pre>
        </template>
        <p v-else class="role__muted">读取中…</p>
      </div>
    </div>

    <div class="role__fold">
      <button type="button" class="role__toggle" :aria-expanded="protocolOpen" @click="toggleProtocol">
        {{ protocolOpen ? '▾' : '▸' }} 系统规定的报告格式（只读）
      </button>
      <div v-if="protocolOpen" class="role__body">
        <p v-if="protocolError" class="role__error">{{ protocolError }}</p>
        <template v-else-if="protocol">
          <p class="role__sub">主代理向系统报告</p>
          <pre class="role__pre">{{ protocol.report_format }}</pre>
          <p class="role__sub">系统向人汇报</p>
          <pre class="role__pre">{{ protocol.human_report_format }}</pre>
        </template>
        <p v-else class="role__muted">读取中…</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.role {
  display: grid;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
}

.role__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.role__title {
  font-size: var(--fs-13);
  font-weight: 700;
}

.role__dirty {
  margin-left: auto;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
}

.role__note,
.role__muted {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
}

.role__restart {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  font-size: var(--fs-12);
  color: var(--c-ink);
  background: var(--c-panel-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  padding: var(--sp-1) var(--sp-2);
}

.role__restart-err {
  color: var(--c-danger);
}

.role__text {
  width: 100%;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.6;
  padding: var(--sp-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-mono-bg);
  color: var(--c-ink);
  resize: vertical;
}

.role__error {
  font-size: var(--fs-12);
  color: var(--c-danger);
  word-break: break-all;
}

.role__actions {
  display: flex;
  gap: var(--sp-2);
}

.role__fold {
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-1);
}

.role__toggle {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.role__toggle:hover {
  color: var(--c-ink);
}

.role__body {
  display: grid;
  gap: var(--sp-1);
  margin-top: var(--sp-1);
}

.role__counts {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.role__sub {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
}

.role__pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  background: var(--c-mono-bg);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.6;
  color: var(--c-ink-2);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
