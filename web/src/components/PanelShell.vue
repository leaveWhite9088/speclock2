<script setup lang="ts">
defineProps<{
  title: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <section class="panel-shell" role="dialog" :aria-label="title">
    <header class="panel-shell__head">
      <span>{{ title }}</span>
      <button type="button" class="panel-shell__close" title="关闭" @click="emit('close')">✕</button>
    </header>
    <div class="panel-shell__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel-shell {
  position: fixed;
  top: calc(var(--topbar-h) + var(--sp-2));
  right: var(--sp-3);
  width: 480px;
  max-width: calc(100vw - 2 * var(--sp-3));
  max-height: calc(100vh - var(--topbar-h) - var(--sp-4));
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  z-index: 50;
}

.panel-shell__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  font-weight: 700;
  flex: none;
}

.panel-shell__close {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.panel-shell__close:hover {
  color: var(--c-danger);
}

.panel-shell__body {
  padding: var(--sp-3);
  overflow-y: auto;
}
</style>
