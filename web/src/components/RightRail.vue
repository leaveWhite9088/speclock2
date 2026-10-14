<script setup lang="ts">
import { ref } from 'vue'
import type { ProjectDetail } from '../api/client'

defineProps<{
  detail: ProjectDetail | null
}>()

const collapsed = ref(false)
</script>

<template>
  <aside class="rightrail" :class="{ 'rightrail--collapsed': collapsed }">
    <button
      v-if="collapsed"
      type="button"
      class="rightrail__fold"
      title="展开右栏"
      @click="collapsed = false"
    >◂</button>
    <template v-else>
      <header class="rightrail__head">
        <span>当前任务包</span>
        <button
          type="button"
          class="rightrail__fold"
          title="折叠右栏"
          @click="collapsed = true"
        >▸</button>
      </header>
      <div class="rightrail__body">
        <template v-if="detail">
          <p class="rightrail__round">轮次 #{{ detail.current_round }} 状态</p>
          <template v-if="detail.open_card">
            <p class="rightrail__task">
              <span class="dot dot--queued"></span>后端：待派发
            </p>
            <p class="rightrail__task">
              <span class="dot dot--queued"></span>前端：待派发
            </p>
            <p class="drawer-hint">
              卡片 {{ detail.open_card.card_id }} 待批准；占位：S4 切片接入真实任务包状态（GET
              /api/p/{slug}/packages）。
            </p>
          </template>
          <p v-else class="rightrail__task rightrail__task--idle">当前轮次无待批准卡片</p>
        </template>
        <p v-else class="drawer-hint">未选择项目</p>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.rightrail {
  width: var(--right-rail-w);
  border-left: 1px solid var(--c-border);
  background: var(--c-panel);
  overflow-y: auto;
}

.rightrail--collapsed {
  width: 32px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: var(--sp-3);
}

.rightrail__fold {
  color: var(--c-ink-3);
  padding: 2px 6px;
}

.rightrail__fold:hover {
  color: var(--c-accent);
}

.rightrail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px var(--sp-3);
  font-size: var(--fs-13);
  font-weight: 600;
  border-bottom: 1px solid var(--c-border);
}

.rightrail__body {
  padding: var(--sp-3);
  display: grid;
  gap: var(--sp-2);
  font-size: var(--fs-13);
}

.rightrail__round {
  color: var(--c-ink-2);
}

.rightrail__task {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.rightrail__task--idle {
  color: var(--c-ink-3);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex: none;
}

.dot--queued {
  background: var(--c-warn);
}

.dot--running {
  background: var(--c-ok);
}
</style>
