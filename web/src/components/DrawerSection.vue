<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  title: string
  open?: boolean
}>()

const isOpen = ref(props.open ?? false)
</script>

<template>
  <section class="drawer">
    <button type="button" class="drawer__head" :aria-expanded="isOpen" @click="isOpen = !isOpen">
      <span class="drawer__arrow" aria-hidden="true">{{ isOpen ? '▾' : '▸' }}</span>
      <span class="drawer__title">{{ title }}</span>
    </button>
    <div v-if="isOpen" class="drawer__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.drawer {
  border-bottom: 1px solid var(--c-border);
}

.drawer__head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 10px var(--sp-3);
  font-size: var(--fs-13);
  font-weight: 600;
  text-align: left;
}

.drawer__head:hover {
  background: var(--c-panel-2);
}

.drawer__arrow {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  width: 12px;
  flex: none;
}

.drawer__body {
  padding: 0 var(--sp-3) var(--sp-3) calc(var(--sp-3) + 20px);
  font-size: var(--fs-13);
}
</style>
