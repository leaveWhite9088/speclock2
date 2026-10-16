<script setup lang="ts">
import { ref } from 'vue'
import type { Task, TaskReceipt } from '../api/client'
import { TASK_STATUS_LABELS, formatDuration, formatTokens, masterLabel } from '../types'

const props = defineProps<{
  task: Task
  busy?: boolean
  error?: string
}>()

const emit = defineEmits<{
  (e: 'dispatch', payload: { taskId: string; minutes: number }): void
  (e: 'receipt', payload: { taskId: string; body: TaskReceipt }): void
  (e: 'audit', payload: { taskId: string; result: 'pass' | 'fail'; note: string }): void
}>()

type ActionMode = 'dispatch' | 'receipt' | 'audit' | null

const actionMode = ref<ActionMode>(null)
const minutes = ref(60)
const filesText = ref('')
const selfCheck = ref('')
const summary = ref('')
const auditNote = ref('')
const formError = ref('')

function switchMode(mode: ActionMode): void {
  formError.value = ''
  actionMode.value = actionMode.value === mode ? null : mode
}

function submitDispatch(): void {
  const n = Number(minutes.value)
  if (!Number.isFinite(n) || n < 1) {
    formError.value = '看门狗分钟数需为 ≥1 的整数（1 分钟可演示超时）'
    return
  }
  emit('dispatch', { taskId: props.task.task_id, minutes: n })
  actionMode.value = null
}

function submitReceipt(): void {
  if (!selfCheck.value.trim() || !summary.value.trim()) {
    formError.value = '自检与摘要必填'
    return
  }
  emit('receipt', {
    taskId: props.task.task_id,
    body: {
      files_changed: filesText.value.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
      self_check: selfCheck.value.trim(),
      summary: summary.value.trim(),
    },
  })
  actionMode.value = null
}

function submitAudit(result: 'pass' | 'fail'): void {
  emit('audit', { taskId: props.task.task_id, result, note: auditNote.value.trim() })
  actionMode.value = null
}
</script>

<template>
  <div class="taskrow" :class="{ 'taskrow--alert': task.status === 'timeout' }">
    <div class="taskrow__main">
      <code class="taskrow__id">{{ task.task_id }}</code>
      <span class="taskrow__master">{{ masterLabel(task.master) }}</span>
      <span class="badge" :class="`badge--${task.status}`">{{ TASK_STATUS_LABELS[task.status] }}</span>
      <span
        v-if="task.duration_ms != null || task.tokens != null"
        class="taskrow__tele"
        title="过程遥测：派发→回执的耗时与 token 消耗（估算）"
      >⏱ {{ task.duration_ms != null ? formatDuration(task.duration_ms) : '—' }} · {{ task.tokens != null ? `${formatTokens(task.tokens)} tokens(估)` : '—' }}</span>
      <span class="taskrow__actions">
        <button
          v-if="task.status === 'queued' || task.status === 'timeout'"
          type="button"
          class="btn btn--sm"
          :disabled="busy"
          @click="switchMode('dispatch')"
        >{{ task.status === 'timeout' ? '重派' : '派发' }}</button>
        <button
          v-if="task.status === 'dispatched' || task.status === 'running'"
          type="button"
          class="btn btn--sm"
          :disabled="busy"
          @click="switchMode('receipt')"
        >回执</button>
        <button
          v-if="task.status === 'reported' || task.status === 'auditing'"
          type="button"
          class="btn btn--sm"
          :disabled="busy"
          @click="switchMode('audit')"
        >审计</button>
      </span>
    </div>

    <div v-if="actionMode === 'dispatch'" class="taskrow__form">
      <label class="taskrow__field">
        看门狗（分钟；1 分钟可演示超时）
        <input v-model.number="minutes" type="number" min="1" :disabled="busy" />
      </label>
      <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="submitDispatch">确认派发</button>
    </div>

    <form v-else-if="actionMode === 'receipt'" class="taskrow__form" @submit.prevent="submitReceipt">
      <label class="taskrow__field">
        改动文件（每行一个）
        <textarea v-model="filesText" rows="2" :disabled="busy" placeholder="backend/export.py"></textarea>
      </label>
      <label class="taskrow__field">
        自检
        <input v-model="selfCheck" type="text" :disabled="busy" placeholder="如：pytest 全绿" />
      </label>
      <label class="taskrow__field">
        摘要
        <input v-model="summary" type="text" :disabled="busy" placeholder="做了什么" />
      </label>
      <button type="submit" class="btn btn--sm btn--primary" :disabled="busy">提交回执</button>
    </form>

    <div v-else-if="actionMode === 'audit'" class="taskrow__form">
      <label class="taskrow__field">
        审计备注（可选）
        <input v-model="auditNote" type="text" :disabled="busy" placeholder="如：契约测试通过" />
      </label>
      <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="submitAudit('pass')">通过</button>
      <button type="button" class="btn btn--sm" :disabled="busy" @click="submitAudit('fail')">不通过（打回）</button>
    </div>

    <p v-if="formError || error" class="taskrow__error">{{ formError || error }}</p>
  </div>
</template>

<style scoped>
.taskrow {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
  background: var(--c-panel);
}

.taskrow--alert {
  border-color: var(--c-danger-border);
  background: var(--c-danger-bg);
}

.taskrow__main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-1) var(--sp-2);
  font-size: var(--fs-12);
}

.taskrow__id {
  font-family: var(--font-mono);
  white-space: nowrap;
}

.taskrow__master {
  color: var(--c-ink-2);
  white-space: nowrap;
}

.taskrow__tele {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.taskrow__actions {
  margin-left: auto;
  display: flex;
  flex: none;
  gap: var(--sp-1);
  white-space: nowrap;
}

.taskrow__form {
  display: grid;
  gap: var(--sp-2);
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-2);
}

.taskrow__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.taskrow__field input,
.taskrow__field textarea {
  font: inherit;
  font-size: var(--fs-12);
  padding: 3px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-panel);
  color: var(--c-ink);
}

.taskrow__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}
</style>
