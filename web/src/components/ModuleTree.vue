<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ApiClient, Block, FeedVersion, ProjectTree, VersionDetail } from '../api/client'
import DraftViewer from './DraftViewer.vue'

/**
 * 文档抽屉（模块全景）：三层树 + 新建流 + 草稿查看 + 版本切换。
 * 版本沿用 v1 的独立粒度：每个模块可单独调版本（看当时快照），
 * 每个大业务（域）也能整体调版本（域内模块各自取"该轮次时"的最新版本）。
 */
const props = defineProps<{
  client: ApiClient | null
  slug: string
  /** 按模块分组的版本发布记录（含轮次），由账本投影提供 */
  versionsByBlock: Record<string, FeedVersion[]>
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

/** 版本视角：blockId → 选中查看的历史版本（'' = 当前）；domainId → 域级回看的轮次 */
const blockView = ref<Record<string, string>>({})
const domainView = ref<Record<string, number | 'current'>>({})
const snapshot = ref<VersionDetail | null>(null)
const snapshotLoading = ref(false)
const snapshotError = ref('')

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

function blockVersions(id: string): FeedVersion[] {
  return [...(props.versionsByBlock[id] ?? [])].sort((a, b) => a.round - b.round)
}

/** 域内出现过的版本发布轮次（倒序） */
function domainRounds(domainId: string, documents: ProjectTree['items'][number]['documents']): number[] {
  const rounds = new Set<number>()
  for (const doc of documents) {
    for (const b of doc.blocks) {
      for (const v of blockVersions(b.id)) rounds.add(v.round)
    }
  }
  void domainId
  return [...rounds].sort((a, b) => b - a)
}

/** 某模块"截至轮次 R"时的最新版本 */
function asOfVersion(blockId: string, round: number): FeedVersion | null {
  return blockVersions(blockId).filter((v) => v.round <= round).at(-1) ?? null
}

/** 树上模块行的版本徽标：显式块级选择 > 域级回看 > 当前版本 */
function badgeText(b: { id: string; current_published_version: string | null }): string {
  const view = blockView.value[b.id]
  if (view) return view
  const domain = tree.value?.items.find((d) => d.documents.some((doc) => doc.blocks.some((x) => x.id === b.id)))
  const round = domain ? domainView.value[domain.id] : undefined
  if (typeof round === 'number') return asOfVersion(b.id, round)?.version ?? '未发布'
  return b.current_published_version ?? '草稿'
}

async function loadTree(expandAll: boolean): Promise<void> {
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

function resetSelection(): void {
  selectedBlockId.value = null
  block.value = null
  blockError.value = ''
  snapshot.value = null
  snapshotError.value = ''
}

function toggleDomain(id: string): void {
  if (expandedDomains.value.has(id)) expandedDomains.value.delete(id)
  else expandedDomains.value.add(id)
}

function toggleDocument(id: string): void {
  if (expandedDocuments.value.has(id)) expandedDocuments.value.delete(id)
  else expandedDocuments.value.add(id)
}

async function loadSnapshot(blockId: string, version: string): Promise<void> {
  if (!props.client) return
  snapshot.value = null
  snapshotError.value = ''
  snapshotLoading.value = true
  try {
    snapshot.value = await props.client.getBlockVersion(props.slug, blockId, version)
  } catch (err) {
    snapshotError.value = err instanceof Error ? err.message : String(err)
  } finally {
    snapshotLoading.value = false
  }
}

/** 点击模块：历史视角下看对应版本快照，否则看当前草稿 */
async function selectBlock(id: string): Promise<void> {
  if (!props.client) return
  if (selectedBlockId.value === id && !blockView.value[id]) {
    resetSelection()
    return
  }
  selectedBlockId.value = id
  block.value = null
  blockError.value = ''
  snapshot.value = null
  snapshotError.value = ''
  const view = blockView.value[id]
  if (view) {
    await loadSnapshot(id, view)
    return
  }
  const domain = tree.value?.items.find((d) => d.documents.some((doc) => doc.blocks.some((x) => x.id === id)))
  const round = domain ? domainView.value[domain.id] : undefined
  const asOf = typeof round === 'number' ? asOfVersion(id, round) : null
  if (asOf) {
    await loadSnapshot(id, asOf.version)
    return
  }
  blockLoading.value = true
  try {
    block.value = await props.client.getBlock(props.slug, id)
  } catch (err) {
    blockError.value = err instanceof Error ? err.message : String(err)
  } finally {
    blockLoading.value = false
  }
}

function onBlockVersionChange(id: string, version: string): void {
  blockView.value = { ...blockView.value, [id]: version }
  if (selectedBlockId.value === id) void selectBlock(id)
  else void selectBlock(id)
}

function backToCurrent(id: string): void {
  blockView.value = { ...blockView.value, [id]: '' }
  void selectBlock(id)
}

/** 域级回看：切到某轮次 → 域内各模块徽标变为"截至该轮"的版本 */
function onDomainRoundChange(domainId: string, value: string): void {
  domainView.value = { ...domainView.value, [domainId]: value === 'current' ? 'current' : Number(value) }
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
            <select
              v-if="domainRounds(domain.id, domain.documents).length > 0"
              class="tree__verselect"
              :value="String(domainView[domain.id] ?? 'current')"
              title="域级版本回看：切到某轮次，域内模块各自显示截至该轮的版本"
              @change="onDomainRoundChange(domain.id, ($event.target as HTMLSelectElement).value)"
            >
              <option value="current">当前</option>
              <option v-for="r in domainRounds(domain.id, domain.documents)" :key="r" :value="String(r)">轮次 #{{ r }}</option>
            </select>
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
                  <button type="button" class="tree__block" title="查看" @click="selectBlock(b.id)">
                    {{ b.title }}
                  </button>
                  <select
                    v-if="blockVersions(b.id).length > 0"
                    class="tree__verselect tree__verselect--block"
                    :value="blockView[b.id] ?? ''"
                    title="模块版本：切到历史版本查看当时快照"
                    @change="onBlockVersionChange(b.id, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">{{ b.current_published_version ?? '草稿' }}</option>
                    <option v-for="v in [...blockVersions(b.id)].reverse()" :key="v.version" :value="v.version">
                      {{ v.version }}（轮次 #{{ v.round }}）
                    </option>
                  </select>
                  <span v-else class="tree__ver" :class="b.status === 'published' ? 'tree__ver--published' : ''">
                    {{ badgeText(b) }}
                  </span>
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
        <span class="draft-pane__title">
          <template v-if="snapshot">{{ snapshot.version }} · 轮次 #{{ snapshot.round }}（历史快照）</template>
          <template v-else>草稿 · {{ block?.title ?? '…' }}</template>
        </span>
        <span class="draft-pane__actions">
          <button
            v-if="snapshot && selectedBlockId"
            type="button"
            class="draft-pane__back"
            @click="backToCurrent(selectedBlockId)"
          >回到当前</button>
          <button type="button" class="draft-pane__close" title="关闭" @click="resetSelection">✕</button>
        </span>
      </header>
      <p v-if="snapshotLoading" class="mtree__note">快照加载中…</p>
      <p v-else-if="snapshotError" class="mtree__note mtree__note--error">快照加载失败：{{ snapshotError }}</p>
      <template v-else-if="snapshot">
        <p class="draft-pane__stmt">说明：{{ snapshot.statement.说明 }}　动机：{{ snapshot.statement.动机 }}</p>
        <DraftViewer :block="{
          id: snapshot.block_id,
          title: block?.title ?? `模块${snapshot.block_id}`,
          status: 'published',
          current_published_version: snapshot.version,
          draft: snapshot.draft,
          versions: [],
        }" />
      </template>
      <p v-else-if="blockLoading" class="mtree__note">草稿加载中…</p>
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
  color: var(--c-ink-2);
  text-decoration: underline;
  font-size: var(--fs-12);
}

.mtree__new-domain {
  justify-self: start;
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: 3px 10px;
}

.mtree__new-domain:hover:not(:disabled) {
  color: var(--c-ink);
  border-color: var(--c-ink-3);
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
  border-radius: var(--radius-m);
  padding: 1px 2px;
}

.tree__row.is-flash {
  background: var(--c-panel-2);
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
  width: 1px;
  background: var(--c-border);
}

.tree__row--block.is-selected {
  background: var(--c-panel-2);
  box-shadow: inset 0 0 0 1px var(--c-border-strong);
}

.tree__toggle {
  color: var(--c-ink-3);
  width: 14px;
  flex: none;
  font-size: var(--fs-12);
}

.tree__toggle:hover {
  color: var(--c-ink);
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
  color: var(--c-ink);
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
  color: var(--c-ink-2);
}

.tree__ver {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: 0 6px;
  line-height: 16px;
}

.tree__ver--published {
  color: var(--c-ok);
  border-color: var(--c-ok-border);
}

.tree__verselect {
  margin-left: auto;
  flex: none;
  max-width: 150px;
  font-size: var(--fs-12);
  font-family: var(--font-mono);
  color: var(--c-ink-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: 0 4px;
  height: 20px;
  background: var(--c-panel);
}

.tree__verselect--block {
  margin-left: auto;
}

.tree__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding-left: 18px;
}

.create-form {
  border: 1px solid var(--c-border-strong);
  background: var(--c-panel);
  border-radius: var(--radius-m);
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
  border-color: var(--c-ink-3);
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

.draft-pane__actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.draft-pane__back {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  text-decoration: underline;
}

.draft-pane__back:hover {
  color: var(--c-ink);
}

.draft-pane__close {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.draft-pane__close:hover {
  color: var(--c-ink);
}

.draft-pane__stmt {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
}
</style>
