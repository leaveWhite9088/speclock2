<script setup lang="ts">
defineProps<{
  title: string
  wide?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <section class="modal" :class="{ 'modal--wide': wide }" role="dialog" :aria-label="title">
      <header class="modal__head">
        <span>{{ title }}</span>
        <button type="button" class="modal__close" title="关闭" @click="emit('close')">✕</button>
      </header>
      <div class="modal__body">
        <slot />
      </div>
    </section>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(29, 37, 48, 0.35);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh var(--sp-4) var(--sp-4);
  z-index: 60;
}

.modal {
  width: 380px;
  max-width: 100%;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
}

.modal--wide {
  width: 640px;
}

.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  font-weight: 700;
  flex: none;
}

.modal__close {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.modal__close:hover {
  color: var(--c-danger);
}

.modal__body {
  padding: var(--sp-4);
  overflow-y: auto;
}
</style>
