<script setup lang="ts">
import { ref } from 'vue'
import type { ApiClient, FeedVersion } from '../api/client'
import DrawerSection from './DrawerSection.vue'
import ModuleTree from './ModuleTree.vue'
import VersionChain from './VersionChain.vue'

defineProps<{
  client: ApiClient | null
  slug: string
  versions: FeedVersion[]
  blockTitles: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'open-convention'): void
}>()

const collapsed = ref(false)
</script>

<template>
  <aside class="leftpanel" :class="{ 'leftpanel--collapsed': collapsed }">
    <button
      v-if="collapsed"
      type="button"
      class="leftpanel__fold"
      title="展开左面板"
      @click="collapsed = false"
    >▸</button>
    <template v-else>
      <header class="leftpanel__head">
        <span>左面板</span>
        <button
          type="button"
          class="leftpanel__fold"
          title="折叠左面板，让宽给对话"
          @click="collapsed = true"
        >◂</button>
      </header>
      <div class="leftpanel__body">
        <DrawerSection title="模块全景" :open="true">
          <ModuleTree :client="client" :slug="slug" />
        </DrawerSection>

        <DrawerSection title="版本链" :open="true">
          <VersionChain :versions="versions" :block-titles="blockTitles" />
        </DrawerSection>

        <DrawerSection title="规则违反榜">
          <p class="drawer-hint">占位：按规则 ID 统计历史违反次数（M4 调整清单接入）。</p>
        </DrawerSection>

        <DrawerSection title="全局约定">
          <p class="drawer-hint">项目级全局约定文档（版本化、需批准），入口在顶栏「约定」。</p>
          <button type="button" class="btn btn--sm" @click="emit('open-convention')">打开约定面板</button>
        </DrawerSection>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.leftpanel {
  width: var(--left-panel-w, 280px);
  border-right: 1px solid var(--c-border);
  background: var(--c-panel);
  overflow-y: auto;
}

.leftpanel--collapsed {
  width: 32px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: var(--sp-3);
}

.leftpanel__fold {
  color: var(--c-ink-3);
  padding: 2px 6px;
}

.leftpanel__fold:hover {
  color: var(--c-accent);
}

.leftpanel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px var(--sp-3);
  font-size: var(--fs-12);
  font-weight: 600;
  color: var(--c-ink-3);
  border-bottom: 1px solid var(--c-border);
}

.leftpanel__body {
  padding-bottom: var(--sp-3);
}
</style>
