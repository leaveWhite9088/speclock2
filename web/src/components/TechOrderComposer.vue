<script setup lang="ts">
import { ref } from 'vue'
import type { ApiClient, TechOrder } from '../api/client'
import ModalShell from './ModalShell.vue'

/** 技术任务单建单表单（DESIGN.md §6.4：intent / scope=契约 / baseline / acceptance） */
const props = defineProps<{
  client: ApiClient | null
  slug: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', order: TechOrder): void
}>()

const intent = ref('')
const scopeText = ref('web/src/')
const baselineText = ref('')
const acceptanceText = ref('npm run build 通过')

const error = ref('')
const submitting = ref(false)

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

function submit(): void {
  if (!props.client || submitting.value) return
  error.value = ''
  const scope = lines(scopeText.value)
  const acceptance = lines(acceptanceText.value)
  if (!intent.value.trim()) {
    error.value = 'intent 必填：一句话意图，必须能回答"为什么动"'
    return
  }
  if (scope.length === 0) {
    error.value = 'scope 至少一项：范围声明是技术任务的契约'
    return
  }
  if (acceptance.length === 0) {
    error.value = 'acceptance 至少一项：验收方式'
    return
  }
  const baseline: Record<string, string> = {}
  for (const line of lines(baselineText.value)) {
    const idx = line.indexOf(':')
    const key = idx < 0 ? line : line.slice(0, idx).trim()
    const value = idx < 0 ? '' : line.slice(idx + 1).trim()
    if (key) baseline[key] = value
  }

  submitting.value = true
  props.client
    .createTechOrder(props.slug, {
      intent: intent.value.trim(),
      scope,
      baseline: Object.keys(baseline).length > 0 ? baseline : undefined,
      acceptance,
    })
    .then((order) => emit('created', order))
    .catch((err: unknown) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      submitting.value = false
    })
}
</script>

<template>
  <ModalShell title="技术任务单（不动业务的变更走技术通道，DESIGN.md §6.4）" @close="emit('close')">
    <form class="to" @submit.prevent="submit">
      <label class="to__field">
        intent（一句话意图）
        <input v-model="intent" class="to__input" type="text" placeholder="如：前端视觉重设计，按新设计稿" />
      </label>
      <label class="to__field">
        scope（范围声明 = 技术任务的契约；每行一个路径）
        <textarea v-model="scopeText" class="to__input" rows="3" placeholder="web/src/"></textarea>
      </label>
      <label class="to__field">
        baseline（可选，基准材料；每行一个 key: value）
        <textarea v-model="baselineText" class="to__input" rows="2" placeholder="设计稿: path/to/mock.png"></textarea>
      </label>
      <label class="to__field">
        acceptance（验收方式；每行一条）
        <textarea v-model="acceptanceText" class="to__input" rows="3" placeholder="npm run build 通过"></textarea>
      </label>

      <p v-if="error" class="to__error">{{ error }}</p>

      <footer class="to__actions">
        <button type="button" class="btn" :disabled="submitting" @click="emit('close')">取消</button>
        <button type="submit" class="btn btn--primary" :disabled="submitting">
          {{ submitting ? '提交中…' : '建单（生成 origin=tech 任务包）' }}
        </button>
      </footer>
    </form>
  </ModalShell>
</template>

<style scoped>
.to {
  display: grid;
  gap: var(--sp-3);
}

.to__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.to__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 4px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-panel);
  color: var(--c-ink);
}

.to__input:focus {
  outline: none;
  border-color: var(--c-accent);
}

.to__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.to__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
</style>
