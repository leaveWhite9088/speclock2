<script setup lang="ts">
defineProps<{
  title: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <aside class="rdrawer" role="dialog" :aria-label="title">
    <header class="rdrawer__head">
      <span class="rdrawer__title">{{ title }}</span>
      <button type="button" class="rdrawer__close" title="关闭" @click="emit('close')">✕</button>
    </header>
    <div class="rdrawer__body">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.rdrawer {
  width: var(--drawer-w);
  max-width: calc(100vw - var(--sidebar-w));
  border-left: 1px solid var(--c-border);
  background: var(--c-panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.rdrawer__head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  font-weight: 700;
}

.rdrawer__close {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.rdrawer__close:hover {
  color: var(--c-ink);
}

.rdrawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
</style>
