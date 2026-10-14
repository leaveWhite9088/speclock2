<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ApiClient, Block, Card, Rule, TreeBlockNode } from '../api/client'
import ModalShell from './ModalShell.vue'

/**
 * 起草卡片表单（M1：人工模拟主主代理起草，DESIGN.md §8）。
 * 选模块 → statement（说明/动机）→ rule_ops / api_ops 编辑 → POST cards。
 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', card: Card): void
}>()

interface RuleRow {
  op: 'add' | 'modify' | 'remove'
  ruleId: string
  name: string
  detail: string
}

interface ApiRow {
  op: 'upsert' | 'remove'
  key: string
  breaking: boolean
  changes: string
  breakingChanges: string
}

const blocks = ref<Array<TreeBlockNode & { path: string }>>([])
const selectedBlockId = ref('')
const blockDraft = ref<Block | null>(null)
const blockDraftError = ref('')

const stmtDesc = ref('')
const stmtMotive = ref('')

const ruleRows = ref<RuleRow[]>([])
const apiRows = ref<ApiRow[]>([])

const error = ref('')
const submitting = ref(false)

watch(
  () => [props.client, props.slug],
  async () => {
    if (!props.client || !props.slug) return
    try {
      const tree = await props.client.getTree(props.slug)
      blocks.value = tree.items.flatMap((d) =>
        d.documents.flatMap((doc) =>
          doc.blocks.map((b) => ({ ...b, path: `${d.title} / ${doc.title}` })),
        ),
      )
    } catch (err) {
      blockDraftError.value = err instanceof Error ? err.message : String(err)
    }
  },
  { immediate: true },
)

watch(selectedBlockId, async (id) => {
  blockDraft.value = null
  blockDraftError.value = ''
  ruleRows.value = []
  apiRows.value = []
  if (!props.client || !id) return
  try {
    blockDraft.value = await props.client.getBlock(props.slug, id)
  } catch (err) {
    blockDraftError.value = err instanceof Error ? err.message : String(err)
  }
})

const existingRules = computed<Rule[]>(() => blockDraft.value?.draft.rules ?? [])
const existingApiKeys = computed<string[]>(() => blockDraft.value?.draft.apis.map((a) => a.api) ?? [])

function addRuleRow(op: RuleRow['op']): void {
  ruleRows.value.push({ op, ruleId: '', name: '', detail: '' })
}

function addApiRow(op: ApiRow['op']): void {
  apiRows.value.push({ op, key: '', breaking: op === 'remove', changes: '', breakingChanges: '' })
}

/** 选中既有规则时预填当前值（modify 场景） */
function onRulePicked(row: RuleRow): void {
  const rule = existingRules.value.find((r) => r.id === row.ruleId)
  if (rule && row.op === 'modify') {
    row.name = rule.name
    row.detail = rule.detail
  }
}

function submit(): void {
  if (!props.client || submitting.value) return
  error.value = ''
  if (!selectedBlockId.value) {
    error.value = '请选择模块（block）'
    return
  }
  if (!stmtDesc.value.trim() || !stmtMotive.value.trim()) {
    error.value = '业务变更说明书的「说明」与「动机」必填（DESIGN.md §6.2）'
    return
  }
  if (ruleRows.value.length + apiRows.value.length === 0) {
    error.value = '至少一条规则或契约变更'
    return
  }
  for (const [i, row] of ruleRows.value.entries()) {
    if (row.op === 'add' && (!row.name.trim() || !row.detail.trim())) {
      error.value = `规则变更 #${i + 1}：新增规则需填名称与详述`
      return
    }
    if (row.op !== 'add' && !row.ruleId) {
      error.value = `规则变更 #${i + 1}：修改/删除需选择既有规则`
      return
    }
    if (row.op === 'modify' && !row.detail.trim()) {
      error.value = `规则变更 #${i + 1}：修改需填新详述`
      return
    }
  }
  for (const [i, row] of apiRows.value.entries()) {
    if (!/^\s*[A-Z]+\s+\/\S+/.test(row.key)) {
      error.value = `契约变更 #${i + 1}：key 需形如 "GET /path"`
      return
    }
    if (row.op === 'remove' && !existingApiKeys.value.includes(row.key.trim())) {
      error.value = `契约变更 #${i + 1}：remove 的 key 需是模块既有契约`
      return
    }
    if (row.breaking && !row.breakingChanges.trim()) {
      error.value = `契约变更 #${i + 1}：破坏性变更需说明破坏点（如删除的枚举）`
      return
    }
  }

  const ruleOps = ruleRows.value.map((row) => {
    if (row.op === 'add') {
      return {
        op: 'add' as const,
        block_id: selectedBlockId.value,
        id: '',
        before: null,
        after: { id: '', name: row.name.trim(), detail: row.detail.trim() },
      }
    }
    const before = existingRules.value.find((r) => r.id === row.ruleId) ?? null
    if (row.op === 'remove') {
      return { op: 'remove' as const, block_id: selectedBlockId.value, id: row.ruleId, before, after: null }
    }
    return {
      op: 'modify' as const,
      block_id: selectedBlockId.value,
      id: row.ruleId,
      before,
      after: { id: row.ruleId, name: row.name.trim(), detail: row.detail.trim() },
    }
  })

  const apiOps = apiRows.value.map((row) => {
    const key = row.key.trim()
    const existed = existingApiKeys.value.includes(key)
    if (row.op === 'remove') {
      return {
        op: 'remove' as const,
        block_id: selectedBlockId.value,
        key,
        entry: null,
        breaking: true,
        existed: true,
      }
    }
    const changes = row.changes.trim() ? [row.changes.trim()] : []
    const breakingChanges = row.breaking && row.breakingChanges.trim() ? [row.breakingChanges.trim()] : []
    return {
      op: 'upsert' as const,
      block_id: selectedBlockId.value,
      key,
      entry: {
        name: key.split(' ').slice(1).join(' ') || key,
        api: key,
        desc: row.changes.trim() || `契约变更：${key}`,
        request: [],
        response: [],
      },
      breaking: row.breaking,
      existed,
      changes,
      breaking_changes: breakingChanges,
    }
  })

  submitting.value = true
  props.client
    .createCard(props.slug, {
      statement: { 说明: stmtDesc.value.trim(), 动机: stmtMotive.value.trim() },
      rule_ops: ruleOps,
      api_ops: apiOps,
    })
    .then((card) => emit('created', card))
    .catch((err: unknown) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      submitting.value = false
    })
}
</script>

<template>
  <ModalShell title="起草卡片（人工模拟主主代理）" wide @close="emit('close')">
    <form class="cc" @submit.prevent="submit">
      <label class="cc__field">
        模块（block）
        <select v-model="selectedBlockId" class="cc__input">
          <option value="" disabled>选择模块</option>
          <option v-for="b in blocks" :key="b.id" :value="b.id">{{ b.path }} / {{ b.title }}</option>
        </select>
      </label>
      <p v-if="blockDraftError" class="cc__error">{{ blockDraftError }}</p>

      <div class="cc__grid2">
        <label class="cc__field">
          说明（一句话，动词开头）
          <input v-model="stmtDesc" class="cc__input" type="text" placeholder="如：导出支持 Excel" />
        </label>
        <label class="cc__field">
          动机
          <input v-model="stmtMotive" class="cc__input" type="text" placeholder="如：财务需要带格式的月报" />
        </label>
      </div>

      <section class="cc__sec">
        <header class="cc__sec-head">
          <h4>业务规则 ops（L1）</h4>
          <span class="cc__sec-actions">
            <button type="button" class="btn btn--sm" :disabled="!selectedBlockId" @click="addRuleRow('add')">＋新增</button>
            <button type="button" class="btn btn--sm" :disabled="!selectedBlockId" @click="addRuleRow('modify')">＋修改</button>
            <button type="button" class="btn btn--sm" :disabled="!selectedBlockId" @click="addRuleRow('remove')">＋删除</button>
          </span>
        </header>
        <p v-if="!selectedBlockId" class="cc__hint">先选模块。</p>
        <div v-for="(row, i) in ruleRows" :key="`r-${i}`" class="cc__row">
          <select v-model="row.op" class="cc__input cc__input--op">
            <option value="add">add</option>
            <option value="modify">modify</option>
            <option value="remove">remove</option>
          </select>
          <select
            v-if="row.op !== 'add'"
            v-model="row.ruleId"
            class="cc__input"
            @change="onRulePicked(row)"
          >
            <option value="" disabled>选既有规则</option>
            <option v-for="r in existingRules" :key="r.id" :value="r.id">{{ r.id }} {{ r.name }}</option>
          </select>
          <input
            v-if="row.op !== 'remove'"
            v-model="row.name"
            class="cc__input"
            type="text"
            placeholder="规则名"
          />
          <input
            v-if="row.op !== 'remove'"
            v-model="row.detail"
            class="cc__input"
            type="text"
            placeholder="规则详述"
          />
          <button type="button" class="cc__del" title="删除此行" @click="ruleRows.splice(i, 1)">✕</button>
        </div>
      </section>

      <section class="cc__sec">
        <header class="cc__sec-head">
          <h4>契约 ops（L2）</h4>
          <span class="cc__sec-actions">
            <button type="button" class="btn btn--sm" :disabled="!selectedBlockId" @click="addApiRow('upsert')">＋upsert</button>
            <button type="button" class="btn btn--sm" :disabled="!selectedBlockId" @click="addApiRow('remove')">＋remove</button>
          </span>
        </header>
        <p v-if="!selectedBlockId" class="cc__hint">先选模块。</p>
        <div v-for="(row, i) in apiRows" :key="`a-${i}`" class="cc__row cc__row--api">
          <select v-model="row.op" class="cc__input cc__input--op">
            <option value="upsert">upsert</option>
            <option value="remove">remove</option>
          </select>
          <input v-model="row.key" class="cc__input" type="text" placeholder="GET /export" />
          <label v-if="row.op === 'upsert'" class="cc__check">
            <input v-model="row.breaking" type="checkbox" />
            破坏性
          </label>
          <input
            v-if="row.op === 'upsert'"
            v-model="row.changes"
            class="cc__input"
            type="text"
            placeholder="变更说明（如：请求 +format）"
          />
          <input
            v-if="row.op === 'upsert' && row.breaking"
            v-model="row.breakingChanges"
            class="cc__input cc__input--breaking"
            type="text"
            placeholder="破坏点（如：删除枚举 ok_old）"
          />
          <button type="button" class="cc__del" title="删除此行" @click="apiRows.splice(i, 1)">✕</button>
        </div>
      </section>

      <p v-if="error" class="cc__error">{{ error }}</p>

      <footer class="cc__actions">
        <button type="button" class="btn" :disabled="submitting" @click="emit('close')">取消</button>
        <button type="submit" class="btn btn--primary" :disabled="submitting">
          {{ submitting ? '提交中…' : '提交起草（卡片进入当前轮次，待批准）' }}
        </button>
      </footer>
    </form>
  </ModalShell>
</template>

<style scoped>
.cc {
  display: grid;
  gap: var(--sp-3);
}

.cc__grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}

.cc__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.cc__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 4px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-panel);
  color: var(--c-ink);
  min-width: 0;
}

.cc__input:focus {
  outline: none;
  border-color: var(--c-accent);
}

.cc__input--op {
  width: 96px;
  flex: none;
}

.cc__input--breaking {
  border-color: var(--c-danger-border);
}

.cc__sec {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
}

.cc__sec-head {
  display: flex;
  align-items: center;
}

.cc__sec-head h4 {
  font-size: var(--fs-13);
}

.cc__sec-actions {
  margin-left: auto;
  display: flex;
  gap: var(--sp-1);
}

.cc__hint {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.cc__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.cc__row--api .cc__input:not(.cc__input--op) {
  flex: 1;
}

.cc__check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-12);
  color: var(--c-danger);
  flex: none;
}

.cc__del {
  color: var(--c-ink-3);
  padding: 0 4px;
  flex: none;
}

.cc__del:hover {
  color: var(--c-danger);
}

.cc__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.cc__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
</style>
