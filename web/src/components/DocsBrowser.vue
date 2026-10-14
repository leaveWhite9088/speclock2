<script setup lang="ts">
/**
 * 文档浏览（主区页面，参考 v1 的文档树/文档页/模块页三层设计）：
 * - 树视图：业务域 → 文档 → 模块（新建流沿用），点击文档/模块进入下层；
 * - 文档视图：模块清单 + 文档版本时间线（每次批准 = 一版 manifest 快照，
 *   列出该文档全部模块截至该轮的 pin 版本）；
 * - 模块视图：完整快照阅读（业务背景/规则/契约/NFR）+ 版本切换 + 版本历史。
 * 只读——修改走核心代理（对话里提需求，它起草审批卡片）。
 */
import { ref, watch } from 'vue'
import type { ApiClient, FeedVersion, ProjectTree } from '../api/client'
import type { FeedRound } from '../types'
import DocsTree from './DocsTree.vue'
import DocDetail from './DocDetail.vue'
import BlockDetail from './BlockDetail.vue'

type View =
  | { kind: 'tree' }
  | { kind: 'document'; domainId: string; documentId: string }
  | { kind: 'block'; domainId: string; documentId: string; blockId: string }

const props = defineProps<{
  client: ApiClient | null
  slug: string
  feed: FeedRound[]
  versionsByBlock: Record<string, FeedVersion[]>
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const tree = ref<ProjectTree | null>(null)
const treeError = ref('')
const treeLoading = ref(false)
const treeLoaded = ref(false)

const view = ref<View>({ kind: 'tree' })

async function loadTree(): Promise<void> {
  if (!props.client || !props.slug) return
  treeLoading.value = true
  treeError.value = ''
  try {
    tree.value = await props.client.getTree(props.slug)
    treeLoaded.value = true
  } catch (err) {
    tree.value = null
    treeError.value = err instanceof Error ? err.message : String(err)
  } finally {
    treeLoading.value = false
  }
}

watch(
  () => [props.client, props.slug],
  () => {
    view.value = { kind: 'tree' }
    void loadTree()
  },
  { immediate: true },
)

function openDocument(domainId: string, documentId: string): void {
  view.value = { kind: 'document', domainId, documentId }
}

function openBlock(domainId: string, documentId: string, blockId: string): void {
  view.value = { kind: 'block', domainId, documentId, blockId }
}

/** 从当前文档视图下钻到模块（模板回调里规避联合类型窄化失效） */
function openBlockFromCurrentDoc(blockId: string): void {
  const v = view.value
  if (v.kind !== 'document' && v.kind !== 'block') return
  view.value = { kind: 'block', domainId: v.domainId, documentId: v.documentId, blockId }
}

function findDomain(domainId: string) {
  return tree.value?.items.find((d) => d.id === domainId) ?? null
}

function findDocument(domainId: string, documentId: string) {
  return findDomain(domainId)?.documents.find((d) => d.id === documentId) ?? null
}

function findBlock(domainId: string, documentId: string, blockId: string) {
  return findDocument(domainId, documentId)?.blocks.find((b) => b.id === blockId) ?? null
}

const crumbs = ref<Array<{ label: string; go: () => void }>>([])
watch(
  view,
  (v) => {
    if (v.kind === 'tree') {
      crumbs.value = []
    } else if (v.kind === 'document') {
      const doc = findDocument(v.domainId, v.documentId)
      crumbs.value = [{ label: doc?.title ?? v.documentId, go: () => (view.value = { ...v }) }]
    } else {
      const doc = findDocument(v.domainId, v.documentId)
      const block = findBlock(v.domainId, v.documentId, v.blockId)
      crumbs.value = [
        { label: doc?.title ?? v.documentId, go: () => (view.value = { kind: 'document', domainId: v.domainId, documentId: v.documentId }) },
        { label: block?.title ?? v.blockId, go: () => (view.value = { ...v }) },
      ]
    }
  },
  { immediate: true, deep: false },
)
</script>

<template>
  <div class="docs">
    <header class="docs__head">
      <nav class="docs__crumbs" aria-label="文档导航">
        <template v-for="(c, i) in crumbs" :key="i">
          <button type="button" class="docs__crumb" :class="{ 'docs__crumb--current': i === crumbs.length - 1 }" @click="c.go">{{ c.label }}</button>
          <span v-if="i < crumbs.length - 1" class="docs__crumb-sep" aria-hidden="true">/</span>
        </template>
      </nav>
      <button type="button" class="btn btn--ghost btn--sm" @click="emit('close')">← 返回对话</button>
    </header>

    <div class="docs__body">
      <DocsTree
        v-if="view.kind === 'tree'"
        :client="client"
        :slug="slug"
        :tree="tree"
        :loading="treeLoading && !treeLoaded"
        :error="treeError"
        @refresh="loadTree"
        @open-document="openDocument"
        @open-block="openBlock"
      />
      <DocDetail
        v-else-if="view.kind === 'document'"
        :domain="findDomain(view.domainId)"
        :document="findDocument(view.domainId, view.documentId)"
        :feed="feed"
        :versions-by-block="versionsByBlock"
        @open-block="openBlockFromCurrentDoc"
      />
      <BlockDetail
        v-else-if="view.kind === 'block'"
        :client="client"
        :slug="slug"
        :block="findBlock(view.domainId, view.documentId, view.blockId)"
        :versions-by-block="versionsByBlock"
      />
    </div>
  </div>
</template>

<style scoped>
.docs {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.docs__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg);
}

.docs__crumbs {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
  overflow: hidden;
}

.docs__crumb {
  font-size: var(--fs-13);
  color: var(--c-ink-2);
  padding: 2px 6px;
  border-radius: var(--radius-m);
  white-space: nowrap;
}

.docs__crumb:hover {
  color: var(--c-ink);
  background: var(--c-panel-2);
}

.docs__crumb--current {
  color: var(--c-ink);
  font-weight: 600;
}

.docs__crumb-sep {
  color: var(--c-ink-3);
}

.docs__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.docs__body > :deep(*) {
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
}
</style>
