<script setup lang="ts">
import { ref } from 'vue'
import type { ApiClient, MasterInfo, Project } from '../api/client'
import type { SessionTarget } from '../types'
import ModalShell from './ModalShell.vue'

/**
 * 左侧栏（Kimi Code 风）：上半是项目列表（挂跨项目徽标：别的项目待批准/运行中
 * 不切界面也看得见，§14.3），下半是当前项目的代理——核心代理（待批准徽标）+
 * 主代理（完整状态：执行中/排队/待审计/超时，带任务号）。
 */
const props = defineProps<{
  client: ApiClient | null
  projects: Project[]
  currentSlug: string
  masters: MasterInfo[]
  session: SessionTarget
  projectStats: Record<string, { pending: number; active: number }>
  masterStates: Record<string, { label: string; kind: 'running' | 'queued' | 'auditing' | 'timeout' }>
  corePending: number
}>()

const emit = defineEmits<{
  (e: 'select-project', slug: string): void
  (e: 'select-session', target: SessionTarget): void
  (e: 'masters-changed'): void
}>()

const HARNESS_OPTIONS = ['claude-code', 'codex', 'kimicode']
const MODEL_SUGGESTIONS = ['glm-4.7', 'claude-sonnet-4.5', 'gpt-5.2', 'deepseek-v3.2', 'qwen3-max']

const showModal = ref(false)
const newName = ref('')
const newDuty = ref('')
const newDir = ref('')
const newHarness = ref(HARNESS_OPTIONS[0])
const newModel = ref(MODEL_SUGGESTIONS[0])
const addError = ref('')
const creating = ref(false)

function openAdd(): void {
  showModal.value = true
  newName.value = ''
  newDuty.value = ''
  newDir.value = ''
  newHarness.value = HARNESS_OPTIONS[0]
  newModel.value = MODEL_SUGGESTIONS[0]
  addError.value = ''
}

function closeAdd(): void {
  showModal.value = false
  addError.value = ''
}

async function submitAdd(): Promise<void> {
  if (!props.client || creating.value) return
  if (!newName.value.trim() || !newDuty.value.trim()) {
    addError.value = '名称与职责必填'
    return
  }
  if (!newDir.value.trim()) {
    addError.value = '目录必填（这个主代理只能动它的目录，如 backend/）'
    return
  }
  creating.value = true
  addError.value = ''
  try {
    await props.client.createMaster(props.currentSlug, {
      name: newName.value,
      duty: newDuty.value,
      dir: newDir.value,
      harness: newHarness.value,
      model: newModel.value,
    })
    closeAdd()
    emit('masters-changed')
  } catch (err) {
    addError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

function avatarText(name: string): string {
  return name.replace(/主代理$/, '').slice(0, 1) || '代'
}
</script>

<template>
  <aside class="sidebar">
    <header class="sidebar__brand">
      <span class="sidebar__logo">SL</span>
      <span class="sidebar__name">SpecLock2</span>
    </header>

    <section class="sidebar__sec">
      <h6 class="sidebar__sec-title">项目</h6>
      <ul class="sidebar__list">
        <li v-for="p in projects" :key="p.slug">
          <button
            type="button"
            class="sidebar__item"
            :class="{ 'is-active': p.slug === currentSlug }"
            @click="emit('select-project', p.slug)"
          >
            <span class="sidebar__avatar" aria-hidden="true">{{ p.name.slice(0, 1) }}</span>
            <span class="sidebar__item-text">
              <span class="sidebar__item-name">{{ p.name }}</span>
              <span class="sidebar__item-sub">{{ p.slug }}</span>
            </span>
            <span
              v-if="(projectStats[p.slug]?.pending ?? 0) > 0"
              class="sidebar__flag sidebar__flag--pending"
              title="有待批准卡片"
            >待批准 {{ projectStats[p.slug].pending }}</span>
            <span
              v-else-if="(projectStats[p.slug]?.active ?? 0) > 0"
              class="sidebar__flag"
              title="有任务在运行"
            >{{ projectStats[p.slug].active }} 运行中</span>
          </button>
        </li>
        <li v-if="projects.length === 0" class="sidebar__empty">（暂无项目）</li>
      </ul>
    </section>

    <section class="sidebar__sec">
      <h6 class="sidebar__sec-title">代理 · {{ currentSlug || '—' }}</h6>
      <ul class="sidebar__list">
        <li>
          <button
            type="button"
            class="sidebar__item"
            :class="{ 'is-active': session.kind === 'core' }"
            title="需求澄清、提案起草、汇报与决策支持——平时只看它"
            @click="emit('select-session', { kind: 'core' })"
          >
            <span class="sidebar__avatar" aria-hidden="true">核</span>
            <span class="sidebar__item-text">
              <span class="sidebar__item-name">核心代理</span>
              <span class="sidebar__item-sub">需求澄清 · 提案起草 · 汇报</span>
            </span>
            <span v-if="corePending > 0" class="sidebar__flag sidebar__flag--pending" title="有待批准卡片">
              待批准 {{ corePending }}
            </span>
          </button>
        </li>

        <li v-for="m in masters" :key="m.id">
          <button
            type="button"
            class="sidebar__item"
            :class="{ 'is-active': session.kind === 'master' && session.masterId === m.id }"
            :title="`${m.duty}（${m.dir}）`"
            @click="emit('select-session', { kind: 'master', masterId: m.id })"
          >
            <span class="sidebar__avatar" aria-hidden="true">{{ avatarText(m.name) }}</span>
            <span class="sidebar__item-text">
              <span class="sidebar__item-name">{{ m.name }}</span>
              <span class="sidebar__item-sub">
                <template v-if="masterStates[m.id]">{{ masterStates[m.id].label }}</template>
                <template v-else>{{ m.duty }}</template>
              </span>
            </span>
            <span
              v-if="masterStates[m.id]"
              class="sidebar__dot"
              :class="`sidebar__dot--${masterStates[m.id].kind}`"
              :title="masterStates[m.id].label"
            ></span>
          </button>
        </li>
      </ul>

      <button v-if="!showModal" type="button" class="sidebar__add" :disabled="!client" @click="openAdd">＋ 添加主代理</button>
    </section>

    <footer class="sidebar__foot">
      <slot name="foot" />
    </footer>

    <!-- 添加主代理：详细弹窗（后续要与核心代理通信，配置要一次说清） -->
    <ModalShell v-if="showModal" title="添加主代理" @close="closeAdd">
      <form class="amaster" @submit.prevent="submitAdd">
        <label class="amaster__field">
          名称
          <input v-model="newName" class="amaster__input" type="text" placeholder="如：数据主代理" :disabled="creating" />
        </label>
        <label class="amaster__field">
          职责（它负责什么；核心代理据此派活与汇报）
          <textarea v-model="newDuty" class="amaster__input" rows="2" placeholder="如：负责数据管道与报表生成：数据清洗、聚合任务" :disabled="creating"></textarea>
        </label>
        <div class="amaster__grid2">
          <label class="amaster__field">
            Harness
            <select v-model="newHarness" class="amaster__input" :disabled="creating">
              <option v-for="h in HARNESS_OPTIONS" :key="h" :value="h">{{ h }}</option>
            </select>
          </label>
          <label class="amaster__field">
            模型
            <input v-model="newModel" class="amaster__input" type="text" list="amaster-models" :disabled="creating" />
            <datalist id="amaster-models">
              <option v-for="m in MODEL_SUGGESTIONS" :key="m" :value="m" />
            </datalist>
          </label>
        </div>
        <label class="amaster__field">
          目录（所有权边界：只能动这个目录）
          <input v-model="newDir" class="amaster__input" type="text" placeholder="如 data/ 或 web/src/" :disabled="creating" />
        </label>

        <p v-if="addError" class="amaster__error">{{ addError }}</p>

        <footer class="amaster__actions">
          <button type="button" class="btn" :disabled="creating" @click="closeAdd">取消</button>
          <button type="submit" class="btn btn--primary" :disabled="creating">
            {{ creating ? '创建中…' : '创建主代理' }}
          </button>
        </footer>
      </form>
    </ModalShell>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  border-right: 1px solid var(--c-border);
  background: var(--c-panel-2);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  /* 侧栏滚动条隐藏（滚轮仍可滚）：页面唯一的纵向滚动条保持在窗口最右 */
  scrollbar-width: none;
}

.sidebar::-webkit-scrollbar {
  display: none;
}

.sidebar__brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
}

.sidebar__logo {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-s);
  background: var(--c-accent);
  color: var(--c-accent-ink);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.sidebar__name {
  font-size: var(--fs-14);
  font-weight: 700;
}

.sidebar__sec {
  padding: var(--sp-2) var(--sp-2) var(--sp-3);
  display: grid;
  gap: var(--sp-1);
}

.sidebar__sec-title {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
  padding: 0 var(--sp-1) var(--sp-1);
}

.sidebar__list {
  display: grid;
  gap: 1px;
}

.sidebar__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px var(--sp-2);
  border-radius: var(--radius-m);
  text-align: left;
}

.sidebar__item:hover {
  background: var(--c-border);
}

.sidebar__item.is-active {
  background: var(--c-panel);
  box-shadow: inset 0 0 0 1px var(--c-border-strong);
}

.sidebar__avatar {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-s);
  border: 1px solid var(--c-border-strong);
  background: var(--c-panel);
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.sidebar__item-text {
  display: grid;
  min-width: 0;
}

.sidebar__item-name {
  font-size: var(--fs-13);
  color: var(--c-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__item-sub {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 跨项目徽标 / 核心代理待批准徽标（§14.3） */
.sidebar__flag {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  padding: 0 7px;
  line-height: 17px;
  white-space: nowrap;
}

.sidebar__flag--pending {
  color: var(--c-danger);
  border-color: var(--c-danger-border);
  background: var(--c-danger-bg);
  font-weight: 600;
}

/* 主代理状态点：执行中绿 / 排队灰 / 待审计灰 / 超时红 */
.sidebar__dot {
  flex: none;
  margin-left: auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--c-ink-3);
}

.sidebar__dot--running {
  background: var(--c-ok);
}

.sidebar__dot--queued,
.sidebar__dot--auditing {
  background: var(--c-border-strong);
}

.sidebar__dot--timeout {
  background: var(--c-danger);
}

.sidebar__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding: var(--sp-1) var(--sp-2);
}

.sidebar__add {
  justify-self: start;
  margin: var(--sp-1) var(--sp-1) 0;
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  padding: 3px 8px;
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-m);
}

.sidebar__add:hover:not(:disabled) {
  color: var(--c-ink);
  border-color: var(--c-ink-3);
}

.sidebar__add:disabled {
  color: var(--c-ink-3);
  cursor: not-allowed;
}

.amaster {
  display: grid;
  gap: var(--sp-3);
}

.amaster__grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}

.amaster__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.amaster__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 5px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  color: var(--c-ink);
  resize: vertical;
}

.amaster__input:focus {
  outline: none;
  border-color: var(--c-ink-3);
}

.amaster__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.amaster__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}

.sidebar__foot {
  margin-top: auto;
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--c-border);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
</style>
