<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ApiClient, ProjectTree } from '../api/client'

/**
 * 文档树（v1 HomeView 的 v2 版，占主区）：业务域 → 文档 → 模块，
 * 每级行内新建；点击文档/模块进入对应视图。
 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
  tree: ProjectTree | null
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  (e: 'refresh'): void
  (e: 'open-document', domainId: string, documentId: string): void
  (e: 'open-block', domainId: string, documentId: string, blockId: string): void
}>()

type CreateTarget =
  | { kind: 'domain' }
  | { kind: 'document'; domainId: string; domainTitle: string }
  | { kind: 'block'; documentId: string; documentTitle: string }

const rootEl = ref<HTMLElement | null>(null)
const expandedDomains = ref(new Set<string>())
const expandedDocuments = ref(new Set<string>())

const createTarget = ref<CreateTarget | null>(null)
const createTitle = ref('')
const createError = ref('')
const creating = ref(false)

const createLabel = computed(() => {
  const t = createTarget.value
  if (!t) return ''
  if (t.kind === 'domain') return '新建业务域'
  if (t.kind === 'document') return `在「${t.domainTitle}」下新建文档`
  return `在「${t.documentTitle}」下新建模块`
})

onMounted(() => {
  void expandAllOnce()
})

/** 首次拿到树时默认全展开（树是异步加载的，挂载时可能还没有数据） */
async function expandAllOnce(): Promise<void> {
  if (!props.tree) {
    await new Promise<void>((resolve) => {
      const stop = watch(
        () => props.tree,
        (t) => {
          if (t) {
            stop()
            resolve()
          }
        },
      )
    })
  }
  for (const domain of props.tree?.items ?? []) {
    expandedDomains.value.add(domain.id)
    for (const doc of domain.documents) expandedDocuments.value.add(doc.id)
  }
}

function toggleDomain(id: string): void {
  if (expandedDomains.value.has(id)) expandedDomains.value.delete(id)
  else expandedDomains.value.add(id)
}

function toggleDocument(id: string): void {
  if (expandedDocuments.value.has(id)) expandedDocuments.value.delete(id)
  else expandedDocuments.value.add(id)
}

function openCreate(target: CreateTarget): void {
  createTarget.value = target
  createTitle.value = ''
  createError.value = ''
}

function cancelCreate(): void {
  createTarget.value = null
  createTitle.value = ''
  createError.value = ''
}

async function submitCreate(): Promise<void> {
  if (!props.client || !createTarget.value || creating.value) return
  const title = createTitle.value.trim()
  if (!title) {
    createError.value = '名称不能为空'
    return
  }
  const target = createTarget.value
  creating.value = true
  createError.value = ''
  try {
    if (target.kind === 'domain') await props.client.createDomain(props.slug, { title })
    else if (target.kind === 'document')
      await props.client.createDocument(props.slug, { domain_id: target.domainId, title })
    else await props.client.createBlock(props.slug, { document_id: target.documentId, title })
    cancelCreate()
    emit('refresh')
    await nextTick()
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

void rootEl
</script>

<template>
  <div ref="rootEl" class="dtree">
    <p v-if="!client" class="dtree__note">连接后端中…</p>
    <p v-else-if="loading" class="dtree__note">加载中…</p>
    <p v-else-if="error" class="dtree__note dtree__note--error">
      加载失败：{{ error }}
      <button type="button" class="dtree__retry" @click="emit('refresh')">重试</button>
    </p>

    <template v-else-if="tree && tree.items.length > 0">
      <ul class="tree">
        <li v-for="domain in tree.items" :key="domain.id" class="tree__node">
          <div class="tree__row">
            <button type="button" class="tree__toggle" :aria-expanded="expandedDomains.has(domain.id)" @click="toggleDomain(domain.id)">
              {{ expandedDomains.has(domain.id) ? '▾' : '▸' }}
            </button>
            <span class="tree__domain">{{ domain.title }}</span>
            <button
              type="button"
              class="tree__add"
              title="在此业务域下新建文档"
              @click="openCreate({ kind: 'document', domainId: domain.id, domainTitle: domain.title })"
            >＋文档</button>
          </div>
          <ul v-if="expandedDomains.has(domain.id)" class="tree__children">
            <li v-if="domain.documents.length === 0" class="tree__empty">（无文档）</li>
            <li v-for="doc in domain.documents" :key="doc.id" class="tree__node">
              <div class="tree__row">
                <button type="button" class="tree__toggle" :aria-expanded="expandedDocuments.has(doc.id)" @click="toggleDocument(doc.id)">
                  {{ expandedDocuments.has(doc.id) ? '▾' : '▸' }}
                </button>
                <button type="button" class="tree__doc" :title="`打开文档「${doc.title}」`" @click="emit('open-document', domain.id, doc.id)">
                  {{ doc.title }}
                </button>
                <span class="tree__count">{{ doc.blocks.length }}</span>
                <button
                  type="button"
                  class="tree__add"
                  title="在此文档下新建模块"
                  @click="openCreate({ kind: 'block', documentId: doc.id, documentTitle: doc.title })"
                >＋模块</button>
              </div>
              <ul v-if="expandedDocuments.has(doc.id)" class="tree__children">
                <li v-if="doc.blocks.length === 0" class="tree__empty">（无模块）</li>
                <li v-for="b in doc.blocks" :key="b.id" class="tree__row tree__row--block">
                  <button type="button" class="tree__block" :title="`打开模块「${b.title}」`" @click="emit('open-block', domain.id, doc.id, b.id)">
                    {{ b.title }}
                  </button>
                  <span class="ver" :class="{ 'ver--pub': b.status === 'published' }">
                    {{ b.current_published_version ?? '草稿' }}
                  </span>
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </template>
    <template v-else>
      <p class="dtree__note">暂无业务域</p>
    </template>

    <button v-if="!createTarget" type="button" class="dtree__new" :disabled="!client" @click="openCreate({ kind: 'domain' })">
      ＋ 新建业务域
    </button>

    <form v-if="createTarget" class="cform" @submit.prevent="submitCreate">
      <p class="cform__label">{{ createLabel }}</p>
      <input v-model="createTitle" class="cform__input" type="text" placeholder="名称" :disabled="creating" />
      <p v-if="createError" class="cform__error">{{ createError }}</p>
      <div class="cform__actions">
        <button type="submit" class="btn btn--primary btn--sm" :disabled="creating">
          {{ creating ? '创建中…' : '创建' }}
        </button>
        <button type="button" class="btn btn--ghost btn--sm" :disabled="creating" @click="cancelCreate">取消</button>
      </div>
    </form>

    <p class="dtree__hint">只读浏览。要修改：在对话里告诉核心代理，它起草审批卡片，你批准后生效。</p>
  </div>
</template>

<style scoped>
.dtree {
  padding: var(--sp-4);
  display: grid;
  gap: var(--sp-3);
  align-content: start;
}

.dtree__note {
  color: var(--c-ink-3);
}

.dtree__note--error {
  color: var(--c-danger);
}

.dtree__retry {
  color: var(--c-ink-2);
  text-decoration: underline;
}

.dtree__new {
  justify-self: start;
  color: var(--c-ink-2);
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: 3px 10px;
}

.dtree__new:hover:not(:disabled) {
  color: var(--c-ink);
  border-color: var(--c-ink-3);
}

.dtree__hint {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.tree {
  display: grid;
  gap: 2px;
}

.tree__node {
  display: grid;
  gap: 2px;
}

.tree__children {
  margin-left: 16px;
  display: grid;
  gap: 2px;
  border-left: 1px solid var(--c-border);
  padding-left: var(--sp-2);
}

.tree__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 1px 2px;
}

.tree__toggle {
  color: var(--c-ink-3);
  width: 14px;
  flex: none;
}

.tree__toggle:hover {
  color: var(--c-ink);
}

.tree__domain {
  font-weight: 600;
  font-size: var(--fs-14);
}

.tree__doc {
  color: var(--c-ink-2);
  font-size: var(--fs-13);
}

.tree__doc:hover {
  color: var(--c-ink);
  text-decoration: underline;
}

.tree__count {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  border: 1px solid var(--c-border);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}

.tree__add {
  margin-left: auto;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding: 0 4px;
  flex: none;
}

.tree__add:hover {
  color: var(--c-ink);
}

.tree__block {
  color: var(--c-ink);
  font-family: var(--font-mono);
  font-size: var(--fs-13);
}

.tree__block:hover {
  text-decoration: underline;
}

.ver {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: 0 6px;
  line-height: 16px;
}

.ver--pub {
  color: var(--c-ok);
  border-color: var(--c-ok-border);
}

.tree__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.cform {
  border: 1px solid var(--c-border-strong);
  background: var(--c-panel);
  border-radius: var(--radius-m);
  padding: var(--sp-3);
  display: grid;
  gap: var(--sp-2);
  max-width: 360px;
}

.cform__label {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  font-weight: 600;
}

.cform__input {
  font: inherit;
  padding: 5px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  color: var(--c-ink);
}

.cform__input:focus {
  outline: none;
  border-color: var(--c-ink-3);
}

.cform__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
}

.cform__actions {
  display: flex;
  gap: var(--sp-2);
}
</style>
