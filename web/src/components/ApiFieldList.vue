<script setup lang="ts">
import type { ApiField } from '../api/client'

// 递归字段清单：name: type (必填|可选)，children 逐层缩进（DESIGN.md §5.4）
defineProps<{
  fields: ApiField[]
  depth?: number
}>()
</script>

<template>
  <ul class="field-list" :class="{ 'field-list--nested': (depth ?? 0) > 0 }">
    <li v-for="(f, i) in fields" :key="`${f.name}-${i}`" class="field-list__item">
      <div class="field-list__row">
        <code class="field-list__name">{{ f.name }}</code>
        <span class="field-list__type">{{ f.type }}</span>
        <span class="field-list__req" :class="{ 'field-list__req--yes': f.required }">
          {{ f.required ? '必填' : '可选' }}
        </span>
        <span v-if="f.description" class="field-list__desc">{{ f.description }}</span>
      </div>
      <ApiFieldList
        v-if="f.children && f.children.length > 0"
        :fields="f.children"
        :depth="(depth ?? 0) + 1"
      />
    </li>
  </ul>
</template>

<style scoped>
.field-list {
  display: grid;
  gap: 2px;
}

.field-list--nested {
  margin-left: var(--sp-3);
  padding-left: var(--sp-2);
  border-left: 2px solid var(--c-border);
}

.field-list__row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-13);
  flex-wrap: wrap;
}

.field-list__name {
  font-family: var(--font-mono);
  color: var(--c-ink);
}

.field-list__type {
  color: var(--c-ink-2);
}

.field-list__req {
  color: var(--c-ink-3);
}

.field-list__req--yes {
  color: var(--c-ink);
  font-weight: 600;
}

.field-list__desc {
  color: var(--c-ink-3);
}
</style>
