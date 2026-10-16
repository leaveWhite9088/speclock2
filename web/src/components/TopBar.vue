<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MasterInfo, ModelEntry } from '../api/client'
import type { DrawerKey, ModelPick } from '../types'
import { findChiefEntry } from '../types'
import ModelMenu from './ModelMenu.vue'

/**
 * 顶栏：右侧入口。模型区随会话对象切换——核心代理视图显示生效 harness+模型
 * （点击弹层切换，与 /model 同一端点）；主代理视图显示该主代理的绑定，
 * 点击弹层改为「编辑绑定」（数据源登记处，不调 /agent/model）。
 * 「重建会话」只在核心代理视图出现：归档当前 pi 会话，下次对话全新上下文
 * （DESIGN A1：会话可弃，账本是 SSOT）；后端 404 时弹层内提示降级。
 */
const emit = defineEmits<{
  (e: 'toggle-drawer', key: DrawerKey): void
  (e: 'toggle-docs'): void
  (e: 'pick-model', sel: ModelPick): void
  (e: 'manage-models'): void
  (e: 'edit-binding'): void
  (e: 'reset-agent'): void
}>()

const props = defineProps<{
  sessionTitle: string
  drawer: DrawerKey | null
  docsActive: boolean
  chiefModel: string | null
  modelEntries: ModelEntry[]
  projectHasDefault: boolean
  chipMaster: MasterInfo | null
  /** 重建会话请求进行中（确认按钮禁用） */
  resetBusy: boolean
  /** 后端未提供 /agent/reset（404）：弹层内提示 */
  resetUnsupported: boolean
  /** 重建成功计数：App 侧成功后 +1，弹层自动收起 */
  resetDoneTick: number
}>()

const entries: Array<{ key: DrawerKey; label: string; primary?: boolean }> = [
  { key: 'models', label: '模型' },
  { key: 'convention', label: '约定' },
  { key: 'queue', label: '队列', primary: true },
]

const modelMenuOpen = ref(false)
const resetOpen = ref(false)

watch(
  () => props.resetDoneTick,
  () => {
    resetOpen.value = false
  },
)

/** 核心代理 harness（按模型登记匹配当前模型；匹配不到不显示） */
const chiefHarnessName = computed(() => findChiefEntry(props.chiefModel, props.modelEntries)?.harness ?? null)
</script>

<template>
  <header class="topbar">
    <span class="topbar__title" :title="sessionTitle">{{ sessionTitle }}</span>
    <!-- 模型区：随会话对象切换（核心代理 = 切换弹层；主代理 = 编辑绑定） -->
    <div class="topbar__model">
      <button
        type="button"
        class="topbar__entry topbar__model-btn"
        :title="chipMaster
          ? `${chipMaster.name} 绑定：${chipMaster.harness} · ${chipMaster.model}（点击编辑）`
          : chiefModel
            ? `核心代理当前：${chiefHarnessName ? chiefHarnessName + ' · ' : ''}${chiefModel}（点击切换）`
            : '核心代理未运行（点击选择模型）'"
        @click="modelMenuOpen = !modelMenuOpen"
      >
        <span class="topbar__model-dot" aria-hidden="true"></span>
        <span class="topbar__model-name">
          <template v-if="chipMaster">{{ chipMaster.harness }} · {{ chipMaster.model }}</template>
          <template v-else><template v-if="chiefHarnessName">{{ chiefHarnessName }} · </template>{{ chiefModel ?? '模型' }}</template>
        </span>
      </button>
      <template v-if="modelMenuOpen">
        <div class="topbar__mmask" @click="modelMenuOpen = false"></div>
        <div class="topbar__mpanel">
          <!-- 主代理视图：编辑该主代理的 Harness×模型绑定（不调 /agent/model） -->
          <template v-if="chipMaster">
            <div class="topbar__bind">
              <p class="topbar__bind-line">
                <b>{{ chipMaster.name }}</b> 当前绑定
              </p>
              <p class="topbar__bind-val">
                <code>{{ chipMaster.harness }} · {{ chipMaster.model }}</code>
              </p>
              <button type="button" class="btn btn--sm btn--primary" @click="modelMenuOpen = false; emit('edit-binding')">
                编辑绑定
              </button>
            </div>
            <footer class="topbar__bind-foot">
              <button type="button" class="topbar__manage" @click="modelMenuOpen = false; emit('manage-models')">管理登记 →</button>
            </footer>
          </template>
          <!-- 核心代理视图：切换弹层 -->
          <ModelMenu
            v-else
            :entries="modelEntries"
            :current-model="chiefModel"
            :show-default="projectHasDefault"
            @pick="
              (sel) => {
                modelMenuOpen = false
                emit('pick-model', sel)
              }
            "
            @manage="
              () => {
                modelMenuOpen = false
                emit('manage-models')
              }
            "
          />
        </div>
      </template>
    </div>
    <!-- 重建会话：仅核心代理视图；确认弹层防误触 -->
    <div v-if="!chipMaster" class="topbar__reset">
      <button
        type="button"
        class="topbar__entry"
        title="归档当前 pi 会话，下次对话全新上下文"
        @click="resetOpen = !resetOpen"
      >重建会话</button>
      <template v-if="resetOpen">
        <div class="topbar__mmask" @click="resetOpen = false"></div>
        <div class="topbar__mpanel topbar__rpanel">
          <p class="topbar__rline">
            当前对话上下文将归档清空，对话历史仍可在事件日志里查看；核心代理会以全新上下文启动。
          </p>
          <p v-if="resetUnsupported" class="topbar__rerr">后端未提供重建会话（/agent/reset 未上线）。</p>
          <div class="topbar__ractions">
            <button type="button" class="btn btn--sm" :disabled="resetBusy" @click="resetOpen = false">取消</button>
            <button type="button" class="btn btn--sm btn--primary" :disabled="resetBusy" @click="emit('reset-agent')">
              {{ resetBusy ? '重建中…' : '确认重建' }}
            </button>
          </div>
        </div>
      </template>
    </div>
    <nav class="topbar__entries" aria-label="右侧入口">
      <button
        type="button"
        class="topbar__entry topbar__entry--primary"
        :class="{ 'is-active': docsActive }"
        @click="emit('toggle-docs')"
      >文档</button>
      <button
        v-for="entry in entries"
        :key="entry.key"
        type="button"
        class="topbar__entry"
        :class="{ 'is-active': drawer === entry.key, 'topbar__entry--primary': entry.primary }"
        @click="emit('toggle-drawer', entry.key)"
      >{{ entry.label }}</button>
    </nav>
  </header>
</template>

<style scoped>
.topbar {
  position: relative;
  height: var(--topbar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 0 var(--sp-4);
  background: var(--c-bg);
  border-bottom: 1px solid var(--c-border);
}

.topbar__title {
  font-size: var(--fs-14);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.topbar__entries {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.topbar__entry {
  padding: 4px 10px;
  border-radius: var(--radius-m);
  font-size: var(--fs-13);
  color: var(--c-ink-2);
}

.topbar__entry--primary {
  color: var(--c-ink);
  font-weight: 600;
}

.topbar__entry:hover {
  background: var(--c-panel-2);
  color: var(--c-ink);
}

.topbar__entry.is-active {
  background: var(--c-panel);
  box-shadow: inset 0 0 0 1px var(--c-border-strong);
  color: var(--c-ink);
}

/* 当前模型按钮：mono 字直接显示生效模型名（贴会话名右侧） */
.topbar__model {
  position: relative;
  flex: none;
}

.topbar__model-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  max-width: 260px;
}

.topbar__model-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-ok);
  flex: none;
}

.topbar__model-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar__mmask {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.topbar__mpanel {
  position: absolute;
  top: calc(100% - 2px);
  left: 0;
  z-index: 51;
  width: 300px;
  background: var(--c-panel);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  box-shadow: 0 8px 24px rgba(29, 37, 48, 0.12);
  padding: var(--sp-1);
  max-height: 340px;
  overflow-y: auto;
}

/* 重建会话：按钮贴模型区右侧，弹层同款下拉 */
.topbar__reset {
  position: relative;
  flex: none;
}

.topbar__rpanel {
  width: 320px;
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
}

.topbar__rline {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  line-height: 1.6;
}

.topbar__rerr {
  font-size: var(--fs-12);
  color: var(--c-danger);
}

.topbar__ractions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}

/* 主代理视图的绑定面板 */
.topbar__bind {
  display: grid;
  gap: var(--sp-1);
  padding: var(--sp-2);
}

.topbar__bind-line {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.topbar__bind-val code {
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  color: var(--c-ink);
}

.topbar__bind-foot {
  border-top: 1px solid var(--c-border);
  margin-top: 2px;
  padding: var(--sp-1) var(--sp-2);
}

.topbar__bind-foot .topbar__manage {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  padding: 2px 6px;
}

.topbar__bind-foot .topbar__manage:hover {
  color: var(--c-ink);
}
</style>
