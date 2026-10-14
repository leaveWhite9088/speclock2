<script setup lang="ts">
import type { ProjectTree } from '../api/client'
import DrawerSection from './DrawerSection.vue'

defineProps<{
  tree: ProjectTree | null
}>()
</script>

<template>
  <aside class="leftrail">
    <DrawerSection title="模块全景" :open="true">
      <ul v-if="tree && tree.items.length > 0" class="tree">
        <li v-for="domain in tree.items" :key="domain.id" class="tree__domain">
          {{ domain.title }}
          <ul>
            <li v-for="doc in domain.documents" :key="doc.id" class="tree__doc">
              {{ doc.title }}
              <ul>
                <li v-for="block in doc.blocks" :key="block.id" class="tree__block">
                  {{ block.title }}
                  <span class="tree__ver">{{ block.current_published_version ?? '草稿' }}</span>
                </li>
                <li v-if="doc.blocks.length === 0" class="tree__empty">（无模块）</li>
              </ul>
            </li>
            <li v-if="domain.documents.length === 0" class="tree__empty">（无文档）</li>
          </ul>
        </li>
      </ul>
      <template v-else>
        <ul class="tree-skeleton" aria-label="模块全景（占位）">
          <li class="tree-skeleton__domain">业务域
            <ul>
              <li class="tree-skeleton__doc">业务文档
                <ul>
                  <li class="tree-skeleton__block">模块 · v1.2.0</li>
                  <li class="tree-skeleton__block">模块 · 草稿</li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
        <p class="drawer-hint">占位：S1 切片接入 GET /api/p/{slug}/tree。</p>
      </template>
    </DrawerSection>

    <DrawerSection title="版本链">
      <p class="drawer-hint">占位：BlockVersion 快照链（每次批准产生一个不可变版本），S3 切片接入。</p>
    </DrawerSection>

    <DrawerSection title="规则违反榜">
      <p class="drawer-hint">占位：按规则 ID 统计历史违反次数，S5 切片接入。</p>
    </DrawerSection>

    <DrawerSection title="全局约定">
      <p class="drawer-hint">占位：项目级全局约定文档（版本化、需批准），S5 切片接入。</p>
    </DrawerSection>
  </aside>
</template>

<style scoped>
.leftrail {
  border-right: 1px solid var(--c-border);
  background: var(--c-panel);
  overflow-y: auto;
}

.tree,
.tree-skeleton {
  display: grid;
  gap: 2px;
  font-size: var(--fs-13);
}

.tree ul,
.tree-skeleton ul {
  margin-left: var(--sp-3);
  display: grid;
  gap: 2px;
}

.tree__domain,
.tree-skeleton__domain {
  font-weight: 600;
}

.tree__doc,
.tree-skeleton__doc {
  color: var(--c-ink-2);
}

.tree__block,
.tree-skeleton__block {
  color: var(--c-ink-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.tree__ver {
  margin-left: var(--sp-1);
  color: var(--c-accent);
}

.tree__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}
</style>
