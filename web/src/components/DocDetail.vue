<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FeedVersion, TreeDocumentNode, TreeDomainNode } from '../api/client'
import type { FeedRound } from '../types'

/**
 * 文档视图（v1 DocumentView 的 v2 版）：
 * 模块清单（独立版本/状态）+ 文档版本时间线——每次批准产生一版 manifest 快照，
 * 可展开查看该文档全部模块"截至该轮"的 pin 版本。
 */
const props = defineProps<{
  domain: TreeDomainNode | null
  document: TreeDocumentNode | null
  feed: FeedRound[]
  versionsByBlock: Record<string, FeedVersion[]>
}>()

const emit = defineEmits<{
  (e: 'open-block', blockId: string): void
}>()

const openManifest = ref<Record<number, boolean>>({})

const docTitle = computed(() => props.document?.title ?? '文档')

function asOfVersion(blockId: string, round: number): FeedVersion | null {
  return [...(props.versionsByBlock[blockId] ?? [])]
    .filter((v) => v.round <= round)
    .sort((a, b) => a.round - b.round)
    .at(-1) ?? null
}

/** 文档版本时间线：有发布行为的轮次（倒序），manifest = 该文档模块的 pin 表 */
const docVersions = computed(() => {
  const blocks = props.document?.blocks ?? []
  return props.feed
    .filter((fr) => fr.versions.some((v) => blocks.some((b) => b.id === v.block_id)))
    .slice()
    .reverse()
    .map((fr) => ({
      round: fr.info.n,
      closedAt: fr.info.closed_at,
      statement: fr.cards.find((c) => c.card_id === fr.info.approval_card_id)?.statement ?? null,
      manifest: blocks
        .map((b) => ({ block: b, v: asOfVersion(b.id, fr.info.n) }))
        .filter((x): x is { block: typeof blocks[number]; v: FeedVersion } => x.v !== null),
    }))
})

function toggleManifest(round: number): void {
  openManifest.value = { ...openManifest.value, [round]: !openManifest.value[round] }
}
</script>

<template>
  <div class="doc">
    <header class="doc__head">
      <h1 class="doc__title">{{ docTitle }}</h1>
      <span v-if="domain" class="doc__domain">{{ domain.title }}</span>
    </header>
    <p class="doc__desc">模块独立发布；每次批准（轮次关闭）都会为本文档定格一版 manifest 快照（全部模块的 pin 版本表）。</p>

    <section class="doc__sec">
      <h2 class="doc__sec-title">模块（{{ document?.blocks.length ?? 0 }}）</h2>
      <div v-if="document && document.blocks.length" class="doc__list">
        <div v-for="b in document.blocks" :key="b.id" class="doc__row">
          <button type="button" class="doc__row-title" @click="emit('open-block', b.id)">{{ b.title }}</button>
          <span class="doc__status" :class="{ 'doc__status--pub': b.status === 'published' }">
            {{ b.status === 'published' ? '已发布' : '草稿' }}
          </span>
          <span v-if="b.current_published_version" class="doc__ver">v{{ b.current_published_version }}</span>
          <span v-else class="doc__unpub">未发布</span>
        </div>
      </div>
      <p v-else class="doc__empty">本文档还没有模块。回到文档树为「{{ docTitle }}」新建第一个模块。</p>
    </section>

    <section class="doc__sec">
      <h2 class="doc__sec-title">版本历史（{{ docVersions.length }}）</h2>
      <div v-if="docVersions.length" class="doc__tl">
        <article v-for="v in docVersions" :key="v.round" class="doc__tl-item">
          <span class="doc__tl-dot" aria-hidden="true"></span>
          <div class="doc__tl-card">
            <header class="doc__tl-head">
              <span class="doc__tl-round">轮次 #{{ v.round }}</span>
              <span class="doc__tl-note">{{ v.statement?.说明 ?? '（无变更说明）' }}</span>
              <button type="button" class="btn btn--ghost btn--sm" @click="toggleManifest(v.round)">
                {{ openManifest[v.round] ? '收起 manifest' : `manifest（${v.manifest.length}）` }}
              </button>
            </header>
            <p v-if="v.statement" class="doc__tl-meta">动机：{{ v.statement.动机 }}</p>
            <table v-if="openManifest[v.round]" class="doc__manifest">
              <thead>
                <tr><th>模块</th><th>pin 版本</th><th>本轮变更</th></tr>
              </thead>
              <tbody>
                <tr v-for="m in v.manifest" :key="m.block.id">
                  <td>
                    <button type="button" class="doc__link" @click="emit('open-block', m.block.id)">{{ m.block.title }}</button>
                  </td>
                  <td><span class="doc__ver">v{{ m.v.version }}</span></td>
                  <td class="doc__delta">{{ m.v.delta_summary ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </article>
      </div>
      <p v-else class="doc__empty">还没有文档版本。第一次批准后，这里会自动出现第一版 manifest 快照。</p>
    </section>
  </div>
</template>

<style scoped>
.doc {
  padding: var(--sp-4);
  display: grid;
  gap: var(--sp-4);
  align-content: start;
}

.doc__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

.doc__title {
  font-size: 18px;
  font-weight: 700;
}

.doc__domain {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
}

.doc__desc {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
  margin-top: calc(-1 * var(--sp-2));
}

.doc__sec {
  display: grid;
  gap: var(--sp-2);
}

.doc__sec-title {
  font-size: var(--fs-13);
  font-weight: 600;
}

.doc__list {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  padding: 0 var(--sp-3);
}

.doc__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}

.doc__row + .doc__row {
  border-top: 1px solid var(--c-border);
}

.doc__row-title {
  font-weight: 500;
}

.doc__row-title:hover {
  text-decoration: underline;
}

.doc__status {
  font-size: var(--fs-13);
  padding: 0 var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  color: var(--c-ink-2);
}

.doc__status--pub {
  color: var(--c-ok);
  border-color: var(--c-ok-border);
}

.doc__ver {
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  color: var(--c-ok);
  border: 1px solid var(--c-ok-border);
  border-radius: var(--radius-s);
  padding: 0 6px;
  line-height: 16px;
}

.doc__unpub {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
}

.doc__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-13);
}

.doc__tl {
  position: relative;
  padding-left: var(--sp-4);
  display: grid;
  gap: var(--sp-3);
}

.doc__tl::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 10px;
  bottom: 10px;
  width: 1px;
  background: var(--c-border);
}

.doc__tl-item {
  position: relative;
}

.doc__tl-dot {
  position: absolute;
  left: calc(-1 * var(--sp-4) + 1px);
  top: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-panel);
  border: 2px solid var(--c-ink-3);
}

.doc__tl-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  padding: var(--sp-3);
  display: grid;
  gap: var(--sp-1);
}

.doc__tl-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.doc__tl-round {
  font-weight: 700;
  font-size: var(--fs-13);
}

.doc__tl-note {
  font-size: var(--fs-13);
  color: var(--c-ink-2);
  flex: 1;
  min-width: 160px;
}

.doc__tl-meta {
  font-size: var(--fs-13);
  color: var(--c-ink-3);
}

.doc__manifest {
  width: 100%;
  margin-top: var(--sp-1);
  border-top: 1px solid var(--c-border);
  border-collapse: collapse;
  font-size: var(--fs-13);
}

.doc__manifest th {
  text-align: left;
  font-weight: 500;
  color: var(--c-ink-3);
  padding: var(--sp-1) 0;
}

.doc__manifest td {
  padding: var(--sp-1) 0;
  border-top: 1px solid var(--c-border);
}

.doc__link:hover {
  text-decoration: underline;
}

.doc__delta {
  color: var(--c-ink-2);
  font-family: var(--font-mono);
}
</style>
