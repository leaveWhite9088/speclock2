<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApiClient, ModelEntry } from '../api/client'

/**
 * Harness×模型登记：工作台只负责唤醒 Harness，不替它配置模型——
 * 这里是纯信息记录（Harness 有啥模型就登记啥，两项一起填），
 * 添加主代理时 Harness 与模型只能从这里选。
 */
const props = defineProps<{
  client: ApiClient | null
  entries: ModelEntry[]
}>()

const emit = defineEmits<{
  (e: 'changed'): void
}>()

const HARNESS_OPTIONS = ['claude-code', 'codex', 'kimicode']

const formHarness = ref(HARNESS_OPTIONS[0])
const formModel = ref('')
const error = ref('')
const registering = ref(false)
const removingId = ref('')

/** 登记表按 Harness 分组（保持登记顺序） */
const grouped = computed<Array<{ harness: string; models: ModelEntry[] }>>(() => {
  const order: string[] = []
  const map = new Map<string, ModelEntry[]>()
  for (const e of props.entries) {
    if (!map.has(e.harness)) {
      map.set(e.harness, [])
      order.push(e.harness)
    }
    map.get(e.harness)!.push(e)
  }
  return order.map((harness) => ({ harness, models: map.get(harness)! }))
})

async function register(): Promise<void> {
  if (!props.client || registering.value) return
  const model = formModel.value.trim()
  if (!model) {
    error.value = '模型名必填（Harness 有什么模型就填什么）'
    return
  }
  registering.value = true
  error.value = ''
  try {
    await props.client.registerModel({ harness: formHarness.value, model })
    formModel.value = ''
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    registering.value = false
  }
}

async function remove(id: string): Promise<void> {
  if (!props.client || removingId.value) return
  removingId.value = id
  error.value = ''
  try {
    await props.client.removeModel(id)
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    removingId.value = ''
  }
}
</script>

<template>
  <div class="models">
    <p class="models__hint">
      工作台只负责<b>唤醒</b> Harness，不能替它配置模型——这里只是登记「这个 Harness 有哪些模型」。
      登记时两项一起填（Harness + 模型），添加主代理时从中选用。
    </p>

    <form class="models__form" @submit.prevent="register">
      <label class="models__field">
        Harness
        <select v-model="formHarness" class="models__input" :disabled="registering">
          <option v-for="h in HARNESS_OPTIONS" :key="h" :value="h">{{ h }}</option>
        </select>
      </label>
      <label class="models__field models__field--grow">
        模型
        <input
          v-model="formModel"
          class="models__input"
          type="text"
          placeholder="如 glm-4.7 / claude-sonnet-4.5"
          :disabled="registering"
        />
      </label>
      <button type="submit" class="btn btn--sm btn--primary models__add" :disabled="registering">
        {{ registering ? '登记中…' : '登记' }}
      </button>
    </form>

    <p v-if="error" class="models__error">{{ error }}</p>

    <div v-if="grouped.length" class="models__list">
      <section v-for="g in grouped" :key="g.harness" class="models__group">
        <h6 class="models__group-title">{{ g.harness }}</h6>
        <div v-for="e in g.models" :key="e.id" class="models__row">
          <span class="models__name">{{ e.model }}</span>
          <button
            type="button"
            class="models__del"
            :disabled="removingId !== ''"
            title="删除这条登记"
            @click="remove(e.id)"
          >删除</button>
        </div>
      </section>
    </div>
    <p v-else class="models__empty">还没有登记。先填上面两项，添加主代理时才有 Harness 与模型可选。</p>
  </div>
</template>

<style scoped>
.models {
  display: grid;
  gap: var(--sp-3);
}

.models__hint {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  background: var(--c-panel-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-2) var(--sp-3);
}

.models__form {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}

.models__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.models__field--grow {
  flex: 1;
  min-width: 0;
}

.models__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 5px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  color: var(--c-ink);
}

.models__input:focus {
  outline: none;
  border-color: var(--c-ink-3);
}

.models__add {
  flex: none;
}

.models__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.models__list {
  display: grid;
  gap: var(--sp-3);
}

.models__group {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-2) var(--sp-3);
  display: grid;
  gap: 2px;
}

.models__group-title {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
  font-family: var(--font-mono);
  padding-bottom: 2px;
}

.models__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 2px 0;
}

.models__name {
  font-size: var(--fs-13);
  font-family: var(--font-mono);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models__del {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid transparent;
  border-radius: var(--radius-m);
  padding: 1px 7px;
}

.models__del:hover:not(:disabled) {
  color: var(--c-danger);
  border-color: var(--c-danger-border);
}

.models__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}
</style>
