<script setup lang="ts">
const emit = defineEmits<{
  (e: 'open-card'): void
  (e: 'open-tech'): void
}>()
</script>

<template>
  <footer class="composer">
    <input
      class="composer__input"
      type="text"
      disabled
      placeholder="主主代理将于接入轮上线（R-M2）"
      aria-label="对话输入框（M1 占位）"
    />
    <button type="button" class="btn" title="技术通道：不动业务的变更走技术任务单（DESIGN.md §6.4）" @click="emit('open-tech')">
      技术任务单
    </button>
    <button type="button" class="btn btn--primary" title="业务通道：起草文档变更卡片（DESIGN.md §8）" @click="emit('open-card')">
      起草卡片
    </button>
  </footer>
</template>

<style scoped>
.composer {
  flex: none;
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--c-border);
  background: var(--c-panel);
}

.composer__input {
  flex: 1;
  font: inherit;
  font-size: var(--fs-13);
  padding: 6px 12px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel-2);
  color: var(--c-ink-3);
}

.composer__input:disabled {
  cursor: not-allowed;
}
</style>
