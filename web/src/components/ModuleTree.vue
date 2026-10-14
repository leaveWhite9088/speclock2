<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ApiClient, Block, ProjectTree } from '../api/client'
import DraftViewer from './DraftViewer.vue'

// 模块全景（S1 迁入 chat-first 左面板）：自取树、自管新建流与草稿查看
const props = defineProps<{
  client: ApiClient | null
  slug: string
}>()

type CreateTarget =
  | { kind: 'domain' }
  | { kind: 'document'; domainId: string; domainTitle: string }
  | { kind: 'block'; documentId: string; documentTitle: string }

const rootEl = ref<HTMLElement | null>(null)

const tree = ref<ProjectTree | null>(null)
const treeError = ref('')
const treeLoading = ref(false)
const treeLoaded = ref(false)

const expandedDomains = ref(new Set<string>())
const expandedDocuments = ref(new Set<string>())

const selectedBlockId = ref<string | null>(null)
const block = ref<Block | null>(null)
const blockError = ref('')
const blockLoading = ref(false)

const createTarget = ref<CreateTarget | null>(null)
const createTitle = ref('')
const createError = ref('')
const creating = ref(false)

const flashKey = ref('')

const createLabel = computed(() => {
  const t = createTarget.value
  if (!t) return ''
  if (t.kind === 'domain') return '新建业务域'
  if (t.kind === 'document') return `在「${t.domainTitle}」下新建文档`
  return `在「${t.documentTitle}」下新建模块`
})

async function loadTree(expandAll: boolean): Promise<void> {
  // client 就绪可能早于项目选定（bootstrap 时序），空 slug 不发请求
  if (!props.client || !props.slug) return
  treeLoading.value = true
  treeError.value = ''
  try {
    const data = await props.client.getTree(props.slug)
    tree.value = data
    if (expandAll) {
      for (const domain of data.items) {
        expandedDomains.value.add(domain.id)
        for (const doc of domain.documents) expandedDocuments.value.add(doc.id)
      }
    }
    treeLoaded.value = true
  } catch (err) {
    tree.value = null
    treeError.value = err instanceof Error ? err.message : String(err)
  } finally {
    treeLoading.value = false
  }
}

watch(
  () => props.client,
  (c) => {
    if (c) void loadTree(true)
  },
  { immediate: true },
)

/** 批准卡片会发布新版本：树上的版本徽标需要刷新 */
watch(
  () => props.slug,
  () => {
    resetSelection()
  },
)

function toggleDomain(id: string): void {
  if (expandedDomains.value.has(id)) expandedDomains.value.delete(id)
  else expandedDomains.value.add(id)
}

function toggleDocument(id: string): void {
  if (expandedDocuments.value.has(id)) expandedDocuments.value.delete(id)
  else expandedDocuments.value.add(id)
}

function resetSelection(): void {
  selectedBlockId.value = null
  block.value = null
  blockError.value = ''
}

/** 点击模块节点：加载并展开草稿四件套（只读）；再点一次收起 */
async function selectBlock(id: string): Promise<void> {
  if (!props.client) return
  if (selectedBlockId.value === id) {
    resetSelection()
    return
  }
  selectedBlockId.value = id
  block.value = null
  blockError.value = ''
  blockLoading.value = true
  try {
    block.value = await props.client.getBlock(props.slug, id)
  } catch (err) {
    blockError.value = err instanceof Error ? err.message : String(err)
  } finally {
    blockLoading.value = false
  }
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
    if (target.kind === 'domain') {
      const created = await props.client.createDomain(props.slug, { title })
      cancelCreate()
      await loadTree(false)
      await locateNode('domain', created.id)
    } else if (target.kind === 'document') {
      const created = await props.client.createDocument(props.slug, {
        domain_id: target.domainId,
        title,
      })
      cancelCreate()
      await loadTree(false)
      await locateNode('document', created.id)
    } else {
      const created = await props.client.createBlock(props.slug, {
        document_id: target.documentId,
        title,
      })
      cancelCreate()
      await loadTree(false)
      await locateNode('block', created.id)
      await selectBlock(created.id)
    }
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

/** 定位新节点：展开祖先 + 高亮 + 滚动到可见 */
async function locateNode(kind: string, id: string): Promise<void> {
  const key = `${kind}-${id}`
  if (tree.value) {
    for (const domain of tree.value.items) {
      if (kind === 'document' || kind === 'block') expandedDomains.value.add(domain.id)
      if (kind === 'block') {
        for (const doc of domain.documents) expandedDocuments.value.add(doc.id)
      }
    }
  }
  flashKey.value = key
  await nextTick()
  rootEl.value?.querySelector(`[data-node="${key}"]`)?.scrollIntoView({ block: 'nearest' })
}

defineExpose({
  reloadTree: () => void loadTree(false),
})
</script>

<template>
  <div ref="rootEl" class="mtree">
    <p v-if="!client" class="mtree__note">连接后端中…</p>
    <p v-else-if="treeLoading && !treeLoaded" class="mtree__note">加载中…</p>
    <p v-else-if="treeError" class="mtree__note mtree__note--error">
      加载失败：{{ treeError }}
      <button type="button" class="mtree__retry" @click="loadTree(true)">重试</button>
    </p>
    <template v-else-if="tree && tree.items.length > 0">
      <ul class="tree">
        <li v-for="domain in tree.items" :key="domain.id" class="tree__node">
          <div
            class="tree__row"
            :data-node="`domain-${domain.id}`"
            :class="{ 'is-flash': flashKey === `domain-${domain.id}` }"
          >
            <button
              type="button"
              class="tree__toggle"
              :aria-expanded="expandedDomains.has(domain.id)"
              @click="toggleDomain(domain.id)"
            >{{ expandedDomains.has(domain.id) ? '▾' : '▸' }}</button>
            <span class="tree__domain" :title="domain.title">{{ domain.title }}</span>
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
              <div
                class="tree__row"
                :data-node="`document-${doc.id}`"
                :class="{ 'is-flash': flashKey === `document-${doc.id}` }"
              >
                <button
                  type="button"
                  class="tree__toggle"
                  :aria-expanded="expandedDocuments.has(doc.id)"
                  @click="toggleDocument(doc.id)"
                >{{ expandedDocuments.has(doc.id) ? '▾' : '▸' }}</button>
                <span class="tree__doc" :title="doc.title">{{ doc.title }}</span>
                <button
                  type="button"
                  class="tree__add"
                  title="在此文档下新建模块"
                  @click="openCreate({ kind: 'block', documentId: doc.id, documentTitle: doc.title })"
                >＋模块</button>
              </div>
              <ul v-if="expandedDocuments.has(doc.id)" class="tree__children">
                <li v-if="doc.blocks.length === 0" class="tree__empty">（无模块）</li>
                <li
                  v-for="b in doc.blocks"
                  :key="b.id"
                  class="tree__row tree__row--block"
                  :data-node="`block-${b.id}`"
                  :class="{
                    'is-flash': flashKey === `block-${b.id}`,
                    'is-selected': selectedBlockId === b.id,
                  }"
                >
                  <button type="button" class="tree__block" title="查看草稿" @click="selectBlock(b.id)">
                    {{ b.title }}
                  </button>
                  <span
                    class="tree__ver"
                    :class="b.status === 'published' ? 'tree__ver--published' : ''"
                  >{{ b.current_published_version ?? '草稿' }}</span>
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </template>
    <template v-else>
      <p class="mtree__note">暂无业务域</p>
    </template>

    <button
      v-if="!createTarget"
      type="button"
      class="mtree__new-domain"
      :disabled="!client"
      @click="openCreate({ kind: 'domain' })"
    >＋ 新建业务域</button>

    <form v-if="createTarget" class="create-form" @submit.prevent="submitCreate">
      <p class="create-form__label">{{ createLabel }}</p>
      <input
        v-model="createTitle"
        class="create-form__input"
        type="text"
        placeholder="名称"
        :disabled="creating"
      />
      <p v-if="createError" class="create-form__error">{{ createError }}</p>
      <div class="create-form__actions">
        <button type="submit" class="btn btn--primary btn--sm" :disabled="creating">
          {{ creating ? '创建中…' : '创建' }}
        </button>
        <button type="button" class="btn btn--ghost btn--sm" :disabled="creating" @click="cancelCreate">
          取消
        </button>
      </div>
    </form>

    <div v-if="selectedBlockId" class="draft-pane">
      <header class="draft-pane__head">
        <span class="draft-pane__title">草稿 · {{ block?.title ?? '…' }}</span>
        <button type="button" class="draft-pane__close" title="关闭草稿" @click="resetSelection">✕</button>
      </header>
      <p v-if="blockLoading" class="mtree__note">草稿加载中…</p>
      <p v-else-if="blockError" class="mtree__note mtree__note--error">草稿加载失败：{{ blockError }}</p>
      <DraftViewer v-else-if="block" :block="block" />
    </div>
  </div>
</template>

<style scoped>
.mtree {
  display: grid;
  gap: var(--sp-2);
}

.mtree__note {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.mtree__note--error {
  color: var(--c-danger);
  word-break: break-all;
}

.mtree__retry {
  color: var(--c-accent);
  text-decoration: underline;
  font-size: var(--fs-12);
}

.mtree__new-domain {
  justify-self: start;
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-s);
  padding: 3px 10px;
}

.mtree__new-domain:hover:not(:disabled) {
  color: var(--c-accent);
  border-color: var(--c-accent);
}

.mtree__new-domain:disabled {
  color: var(--c-ink-3);
  cursor: not-allowed;
}

.tree {
  display: grid;
  gap: 2px;
  font-size: var(--fs-13);
}

.tree__node {
  display: grid;
  gap: 2px;
}

.tree__children {
  margin-left: 14px;
  display: grid;
  gap: 2px;
}

.tree__row {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  border-radius: var(--radius-s);
  padding: 1px 2px;
}

.tree__row.is-flash {
  background: var(--c-accent-bg);
}

.tree__row--block {
  padding-left: 18px;
  position: relative;
}

.tree__row--block::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--c-border);
}

.tree__row--block.is-selected {
  background: var(--c-accent-bg);
}

.tree__toggle {
  color: var(--c-ink-3);
  width: 14px;
  flex: none;
  font-size: var(--fs-12);
}

.tree__toggle:hover {
  color: var(--c-accent);
}

.tree__domain {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree__doc {
  color: var(--c-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree__add {
  margin-left: auto;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding: 0 4px;
  flex: none;
}

.tree__add:hover {
  color: var(--c-accent);
}

.tree__block {
  color: var(--c-ink);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.tree__block:hover {
  color: var(--c-accent);
}

.tree__ver {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid var(--c-border);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}

.tree__ver--published {
  color: var(--c-ok);
  border-color: var(--c-ok-border);
  background: var(--c-ok-bg);
}

.tree__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding-left: 18px;
}

.create-form {
  border: 1px solid var(--c-accent-border);
  background: var(--c-accent-bg);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
}

.create-form__label {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  font-weight: 600;
}

.create-form__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 4px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  background: var(--c-panel);
  color: var(--c-ink);
  width: 100%;
}

.create-form__input:focus {
  outline: none;
  border-color: var(--c-accent);
}

.create-form__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.create-form__actions {
  display: flex;
  gap: var(--sp-2);
}

.draft-pane {
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-3);
  display: grid;
  gap: var(--sp-2);
}

.draft-pane__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-13);
  font-weight: 600;
}

.draft-pane__close {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.draft-pane__close:hover {
  color: var(--c-danger);
}
</style>
