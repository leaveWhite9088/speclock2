<script setup lang="ts">
import { computed } from 'vue'
import type { FeedVersion } from '../api/client'

const props = defineProps<{
  versions: FeedVersion[]
  blockTitles: Record<string, string>
}>()

/** 版本链视图：沿链每一格都是一次业务事实的改变（DESIGN.md §6.1/A3） */
const sorted = computed(() =>
  [...props.versions].sort((a, b) => b.round - a.round || b.version.localeCompare(a.version)),
)

function blockName(id: string): string {
  return props.blockTitles[id] ?? `模块${id}`
}
</script>

<template>
  <div class="vchain">
    <p v-if="sorted.length === 0" class="vchain__empty">暂无版本。批准卡片后，每次批准在这里产生一个不可变快照。</p>
    <ol class="vchain__list">
      <li v-for="(v, i) in sorted" :key="`${v.block_id}-${v.version}-${v.round}`" class="vchain__item">
        <span class="vchain__dot" :class="{ 'vchain__dot--head': i === 0 }" aria-hidden="true"></span>
        <div class="vchain__body">
          <p class="vchain__ver">
            <code>{{ v.version }}</code>
            <span class="vchain__meta">轮次 #{{ v.round }} · {{ blockName(v.block_id) }}</span>
            <span v-if="v.delta_summary" class="vchain__delta">{{ v.delta_summary }}</span>
          </p>
          <p class="vchain__stmt">{{ v.statement.说明 }}</p>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.vchain__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.vchain__list {
  display: grid;
}

.vchain__item {
  display: flex;
  gap: var(--sp-2);
  padding: 0 0 var(--sp-3) var(--sp-2);
  position: relative;
}

.vchain__item::before {
  content: '';
  position: absolute;
  left: calc(var(--sp-2) + 4px);
  top: 10px;
  bottom: 0;
  width: 1px;
  background: var(--c-border);
}

.vchain__item:last-child::before {
  display: none;
}

.vchain__dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--c-border-strong);
  flex: none;
  margin-top: 4px;
  position: relative;
  z-index: 1;
}

.vchain__dot--head {
  background: var(--c-ok);
}

.vchain__body {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.vchain__ver {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  flex-wrap: wrap;
}

.vchain__ver code {
  font-family: var(--font-mono);
  color: var(--c-accent);
  font-weight: 700;
}

.vchain__meta {
  color: var(--c-ink-3);
}

.vchain__delta {
  color: var(--c-ink-2);
  font-family: var(--font-mono);
}

.vchain__stmt {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
}
</style>
