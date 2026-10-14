<script setup lang="ts">
defineProps<{
  title: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <section class="panel" role="dialog" :aria-label="title">
    <header class="panel__head">
      <span>{{ title }}</span>
      <button type="button" class="panel__close" title="关闭" @click="emit('close')">✕</button>
    </header>
    <div class="panel__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  position: fixed;
  top: calc(var(--topbar-h) + var(--sp-2));
  right: var(--sp-3);
  width: 360px;
  max-width: calc(100vw - 2 * var(--sp-3));
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  z-index: 50;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  font-weight: 600;
}

.panel__close {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.panel__close:hover {
  color: var(--c-danger);
}

.panel__body {
  padding: var(--sp-3);
}
</style>
