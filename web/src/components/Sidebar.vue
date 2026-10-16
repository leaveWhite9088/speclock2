<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AgentStatus, ApiClient, CliSession, MasterInfo, ModelEntry, Project } from '../api/client'
import type { SessionTarget } from '../types'
import { findChiefEntry, formatDuration, formatTokens } from '../types'
import ModalShell from './ModalShell.vue'
import ProjectFormModal from './ProjectFormModal.vue'

/**
 * 左侧栏（Kimi Code 风）：上半是项目列表（挂跨项目徽标：别的项目待批准/运行中
 * 不切界面也看得见，§14.3），下半是当前项目的代理——核心代理（待批准徽标 +
 * 运行状态卡：模型/上下文占用，>80% 黄色告警 §12.3，未运行可一键启动）+
 * 主代理（完整状态：执行中/排队/待审计/超时，带任务号）。
 */
const props = defineProps<{
  client: ApiClient | null
  projects: Project[]
  currentSlug: string
  masters: MasterInfo[]
  session: SessionTarget
  projectStats: Record<string, { pending: number; running: number; queued: number; reviewing: number }>
  masterStates: Record<string, { label: string; kind: 'running' | 'queued' | 'auditing' | 'timeout' }>
  corePending: number
  /** 核心代理会话状态（10s 轮询；null = 探测中/不可用） */
  agent: AgentStatus | null
  /** 主代理最近一次任务遥测（耗时 + token 估） */
  masterTelemetry: Record<string, { ms: number; tokens: number } | null>
  /** Harness×模型登记（右上角「模型」维护）：主代理的属性只能从这里选 */
  modelEntries: ModelEntry[]
  /** CLI 内部的会话列表：主代理唤醒后接续选定的会话工作 */
  cliSessions: CliSession[]
  /** 顶栏「编辑绑定」请求：非空时打开对应主代理的编辑弹窗 */
  editMaster: MasterInfo | null
  /** 当前项目绑定的目录（null = 未绑定：会话选择区提示先绑定） */
  projectDir: string | null
  /** 核心代理正在流式回复（侧栏转圈提示；点它可停止） */
  chiefStreaming: boolean
}>()

const emit = defineEmits<{
  (e: 'select-project', slug: string): void
  (e: 'select-session', target: SessionTarget): void
  (e: 'masters-changed'): void
  (e: 'start-agent'): void
  (e: 'projects-changed', createdSlug?: string, chiefPick?: { provider: string | null; model: string | null } | null): void
  (e: 'master-edit-done'): void
  (e: 'stop-chief'): void
}>()

/** 新建 / 编辑项目弹窗（同一张表单复用） */
const projectModal = ref<null | { mode: 'create' } | { mode: 'edit'; project: Project }>(null)

/** 主代理新建 / 编辑弹窗；editViaRequest = 顶栏「编辑绑定」触发（关闭时回执） */
const masterModal = ref<null | { mode: 'add' } | { mode: 'edit'; master: MasterInfo }>(null)
const editViaRequest = ref(false)
/** 行菜单（项目/主代理）：confirm = 删除二次确认态；error = 行内报错（如 409 在跑任务） */
const projMenu = ref<null | { slug: string; confirm: boolean; error: string }>(null)
const masterMenu = ref<null | { id: string; confirm: boolean; error: string }>(null)
const menuBusy = ref(false)
/** 待验收清理弹层：点击项目徽标上的「N 待验收」后列出 reported 任务 */
const auditMenu = ref<
  | null
  | { slug: string; loading: boolean; busy: boolean; error: string; tasks: Array<{ id: string; master: string; summary: string }> }
>(null)

async function openAuditMenu(slug: string): Promise<void> {
  auditMenu.value = { slug, loading: true, busy: false, error: '', tasks: [] }
  if (!props.client) return
  try {
    const pkgs = (await props.client.listPackages(slug)).items
    const tasks = pkgs
      .flatMap((p) => p.tasks.map((t) => ({ task: t })))
      .filter(({ task }) => task.status === 'reported' || task.status === 'auditing')
      .map(({ task }) => ({
        id: task.task_id,
        master: task.master ?? '待定',
        summary: task.receipt?.summary ?? '（无回执摘要）',
      }))
    auditMenu.value = { slug, loading: false, busy: false, error: '', tasks }
  } catch (err) {
    auditMenu.value = { slug, loading: false, busy: false, error: err instanceof Error ? err.message : String(err), tasks: [] }
  }
}

async function auditAllNow(slug: string): Promise<void> {
  if (!props.client || !auditMenu.value || auditMenu.value.busy) return
  auditMenu.value.busy = true
  try {
    await props.client.auditAll(slug)
    auditMenu.value = null
    emit('projects-changed')
  } catch (err) {
    if (auditMenu.value) auditMenu.value = { ...auditMenu.value, busy: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const newName = ref('')
const newDuty = ref('')
const newDir = ref('')
const newHarness = ref('')
const newModel = ref('')
const newSession = ref('')
const addError = ref('')
const creating = ref(false)

/** 可选 Harness = 登记里出现过的（保持登记顺序） */
const harnessOptions = computed(() => [...new Set(props.modelEntries.map((e) => e.harness))])

/** 可选模型 = 当前 Harness 名下登记的 */
const modelOptions = computed(() =>
  props.modelEntries.filter((e) => e.harness === newHarness.value).map((e) => e.model),
)

// 切 Harness 后模型不在其名下时，回落到该 Harness 的第一个登记模型
watch(
  () => newHarness.value,
  () => {
    if (!modelOptions.value.includes(newModel.value)) newModel.value = modelOptions.value[0] ?? ''
  },
)

function sessionLabel(s: CliSession): string {
  const day = s.updated_at.slice(5, 16).replace('T', ' ')
  return `${s.title} · ${s.id} · ${day}`
}

function openMasterAdd(): void {
  masterModal.value = { mode: 'add' }
  editViaRequest.value = false
  newName.value = ''
  newDuty.value = ''
  newDir.value = ''
  newHarness.value = harnessOptions.value[0] ?? ''
  newModel.value = modelOptions.value[0] ?? ''
  newSession.value = ''
  addError.value = ''
}

function openMasterEdit(m: MasterInfo): void {
  masterModal.value = { mode: 'edit', master: m }
  newName.value = m.name
  newDuty.value = m.duty
  newDir.value = m.dir
  newHarness.value = m.harness
  newModel.value = m.model
  newSession.value = m.session ?? ''
  addError.value = ''
}

function closeMasterModal(): void {
  masterModal.value = null
  addError.value = ''
  if (editViaRequest.value) {
    editViaRequest.value = false
    emit('master-edit-done')
  }
}

/** 顶栏「编辑绑定」请求：打开对应主代理的编辑弹窗 */
watch(
  () => props.editMaster,
  (m) => {
    if (m) {
      editViaRequest.value = true
      openMasterEdit(m)
    }
  },
)

async function submitMaster(): Promise<void> {
  if (!props.client || creating.value) return
  if (!newName.value.trim() || !newDuty.value.trim()) {
    addError.value = '名称与职责必填'
    return
  }
  if (!newDir.value.trim()) {
    addError.value = '目录必填（这个主代理只能动它的目录，如 backend/）'
    return
  }
  if (!newHarness.value || !newModel.value) {
    addError.value = 'Harness 与模型从登记里选——先在右上角「模型」里登记'
    return
  }
  // 会话空 = 「开始新对话」（不绑定 CLI 会话），不拦提交
  const body = {
    name: newName.value,
    duty: newDuty.value,
    dir: newDir.value,
    harness: newHarness.value,
    model: newModel.value,
    session: newSession.value,
  }
  creating.value = true
  addError.value = ''
  try {
    if (masterModal.value?.mode === 'edit') {
      await props.client.updateMaster(props.currentSlug, masterModal.value.master.id, body)
    } else {
      await props.client.createMaster(props.currentSlug, body)
    }
    closeMasterModal()
    emit('masters-changed')
  } catch (err) {
    addError.value = err instanceof Error ? err.message : String(err)
  } finally {
    creating.value = false
  }
}

/* ---------- 行菜单动作 ---------- */

async function removeProject(slug: string): Promise<void> {
  if (!props.client || menuBusy.value) return
  menuBusy.value = true
  try {
    await props.client.deleteProject(slug)
    projMenu.value = null
    emit('projects-changed')
  } catch (err) {
    if (projMenu.value) projMenu.value = { ...projMenu.value, error: err instanceof Error ? err.message : String(err) }
  } finally {
    menuBusy.value = false
  }
}

async function removeMaster(id: string): Promise<void> {
  if (!props.client || menuBusy.value) return
  menuBusy.value = true
  try {
    await props.client.deleteMaster(props.currentSlug, id)
    masterMenu.value = null
    emit('masters-changed')
  } catch (err) {
    if (masterMenu.value) masterMenu.value = { ...masterMenu.value, error: err instanceof Error ? err.message : String(err) }
  } finally {
    menuBusy.value = false
  }
}

function avatarText(name: string): string {
  return name.replace(/主代理$/, '').slice(0, 1) || '代'
}

/** 项目活动徽标：运行中/排队部分；待验收单独成可点击徽标（清理入口） */
function runQueuedLabel(slug: string): string {
  const s = props.projectStats[slug]
  if (!s) return ''
  const parts: string[] = []
  if (s.running > 0) parts.push(`${s.running} 运行中`)
  if (s.queued > 0) parts.push(`${s.queued} 排队`)
  return parts.join(' · ')
}

/** 核心代理当前模型对应的 harness（按模型登记匹配；匹配不到不显示） */
const chiefHarnessName = computed(() => findChiefEntry(props.agent?.model ?? null, props.modelEntries)?.harness ?? null)
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
        <li v-for="p in projects" :key="p.slug" class="sidebar__proj">
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
              <span v-if="p.working_dir" class="sidebar__item-sub sidebar__dir" :title="p.working_dir">{{ p.working_dir }}</span>
            </span>
            <span
              v-if="(projectStats[p.slug]?.pending ?? 0) > 0"
              class="sidebar__flag sidebar__flag--pending"
              title="有待批准卡片"
            >待批准 {{ projectStats[p.slug].pending }}</span>
            <template v-else>
              <span v-if="runQueuedLabel(p.slug)" class="sidebar__flag" title="运行中/排队任务（按任务状态统计）">
                {{ runQueuedLabel(p.slug) }}
              </span>
              <button
                v-if="(projectStats[p.slug]?.reviewing ?? 0) > 0"
                type="button"
                class="sidebar__flag sidebar__flag--review"
                title="有待验收的回执，点击查看并批量清理"
                @click.stop="openAuditMenu(p.slug)"
              >{{ projectStats[p.slug].reviewing }} 待验收</button>
            </template>
          </button>
          <button
            type="button"
            class="sidebar__gear"
            title="项目菜单"
            @click.stop="projMenu = projMenu?.slug === p.slug ? null : { slug: p.slug, confirm: false, error: '' }"
          >
            <svg
              class="sidebar__gear-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path
                d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
              />
            </svg>
          </button>
          <!-- 项目行菜单：设置 / 删除（二次确认，账本保留为 .deleted） -->
          <template v-if="projMenu?.slug === p.slug">
            <div class="rowmenu__mask" @click="projMenu = null"></div>
            <div class="rowmenu">
              <template v-if="!projMenu.confirm">
                <button type="button" class="rowmenu__item" @click="projectModal = { mode: 'edit', project: p }; projMenu = null">
                  项目设置…
                </button>
                <button type="button" class="rowmenu__item rowmenu__item--danger" @click="projMenu = { ...projMenu, confirm: true }">
                  删除项目…
                </button>
              </template>
              <template v-else>
                <p class="rowmenu__warn">删除后不可恢复；账本文件将保留为 <code>.deleted</code>。</p>
                <p v-if="projMenu.error" class="rowmenu__error">{{ projMenu.error }}</p>
                <div class="rowmenu__acts">
                  <button type="button" class="rowmenu__cancel" :disabled="menuBusy" @click="projMenu = null">取消</button>
                  <button type="button" class="rowmenu__del" :disabled="menuBusy" @click="removeProject(p.slug)">
                    {{ menuBusy ? '删除中…' : '确认删除' }}
                  </button>
                </div>
              </template>
            </div>
          </template>
          <!-- 待验收清理弹层：列出 reported 任务，一键 audit-all -->
          <template v-if="auditMenu?.slug === p.slug">
            <div class="rowmenu__mask" @click="auditMenu = null"></div>
            <div class="rowmenu rowmenu--audit">
              <p class="rowmenu__warn">待验收回执（{{ auditMenu.tasks.length }}）</p>
              <p v-if="auditMenu.loading" class="rowmenu__hint">读取中…</p>
              <p v-else-if="auditMenu.error" class="rowmenu__error">{{ auditMenu.error }}</p>
              <template v-else-if="auditMenu.tasks.length">
                <ul class="rowmenu__tasks">
                  <li v-for="t in auditMenu.tasks" :key="t.id">
                    <code>{{ t.id }}</code>
                    <span class="rowmenu__task-master">{{ t.master }}</span>
                    <span class="rowmenu__task-sum">{{ t.summary }}</span>
                  </li>
                </ul>
                <div class="rowmenu__acts">
                  <button type="button" class="rowmenu__cancel" :disabled="auditMenu.busy" @click="auditMenu = null">取消</button>
                  <button type="button" class="rowmenu__del" :disabled="auditMenu.busy" @click="auditAllNow(p.slug)">
                    {{ auditMenu.busy ? '验收中…' : '全部标记为已验收' }}
                  </button>
                </div>
              </template>
              <p v-else class="rowmenu__hint">没有待验收的任务了。</p>
            </div>
          </template>
        </li>
        <li v-if="projects.length === 0" class="sidebar__empty">
          （暂无项目）
          <button type="button" class="sidebar__add" @click="projectModal = { mode: 'create' }">＋ 新建项目</button>
        </li>
      </ul>
      <button v-if="projects.length > 0" type="button" class="sidebar__add" @click="projectModal = { mode: 'create' }">＋ 新建项目</button>
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
              <span
                v-if="agent && agent.running"
                class="sidebar__item-sub"
                :class="{ 'is-warn': (agent.context_usage_percent ?? 0) > 80 }"
                :title="(agent.context_usage_percent ?? 0) > 80 ? '上下文占用超过 80%：会话退化信号，建议停止后重新启动（账本可重建一切，§12.3）' : '核心代理会话运行中'"
              ><template v-if="chiefHarnessName">{{ chiefHarnessName }} · </template>{{ agent.model ?? '运行中' }} · 上下文 {{ agent.context_usage_percent ?? '—' }}%</span>
              <span v-else-if="agent && !agent.running" class="sidebar__item-sub">未运行（发消息会自动唤醒）</span>
              <span v-else class="sidebar__item-sub">需求澄清 · 提案起草 · 汇报</span>
            </span>
            <span v-if="corePending > 0" class="sidebar__flag sidebar__flag--pending" title="有待批准卡片">
              待批准 {{ corePending }}
            </span>
            <span
              v-if="agent && !agent.running"
              class="sidebar__start"
              role="button"
              title="启动核心代理会话"
              @click.stop="emit('start-agent')"
            >启动</span>
            <button
              v-if="chiefStreaming"
              type="button"
              class="sidebar__typing"
              title="核心代理正在回复，点击停止"
              @click.stop="emit('stop-chief')"
            ><span class="sidebar__typing-dot" aria-hidden="true"></span>回复中</button>
          </button>
        </li>

        <li v-for="m in masters" :key="m.id" class="sidebar__proj">
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
              <span class="sidebar__meta">
                <code class="sidebar__harness" :title="`Harness：${m.harness} · 模型：${m.model}`">{{ m.harness }} · {{ m.model }}</code>
                <span
                  v-if="['mcode', 'opencode'].includes(m.harness)"
                  class="sidebar__mcode"
                  :title="`绑定 ${m.harness}（可派发 harness）`"
                >{{ m.harness === 'mcode' ? 'M' : 'O' }}</span>
                <template v-if="masterTelemetry[m.id]">
                  · ⏱ {{ formatDuration(masterTelemetry[m.id]!.ms) }} · {{ formatTokens(masterTelemetry[m.id]!.tokens) }} tokens(估)
                </template>
              </span>
            </span>
            <span
              v-if="masterStates[m.id]"
              class="sidebar__dot"
              :class="`sidebar__dot--${masterStates[m.id].kind}`"
              :title="masterStates[m.id].label"
            ></span>
          </button>
          <button
            type="button"
            class="sidebar__gear"
            title="主代理菜单"
            @click.stop="masterMenu = masterMenu?.id === m.id ? null : { id: m.id, confirm: false, error: '' }"
          >
            <svg class="sidebar__gear-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <!-- 主代理行菜单：编辑（PATCH）/ 删除（409 在跑任务行内提示） -->
          <template v-if="masterMenu?.id === m.id">
            <div class="rowmenu__mask" @click="masterMenu = null"></div>
            <div class="rowmenu">
              <template v-if="!masterMenu.confirm">
                <button type="button" class="rowmenu__item" @click="openMasterEdit(m); masterMenu = null">
                  编辑…
                </button>
                <button type="button" class="rowmenu__item rowmenu__item--danger" @click="masterMenu = { ...masterMenu, confirm: true }">
                  删除…
                </button>
              </template>
              <template v-else>
                <p class="rowmenu__warn">删除主代理 {{ m.name }}？</p>
                <p v-if="masterMenu.error" class="rowmenu__error">{{ masterMenu.error }}</p>
                <div class="rowmenu__acts">
                  <button type="button" class="rowmenu__cancel" :disabled="menuBusy" @click="masterMenu = null">取消</button>
                  <button type="button" class="rowmenu__del" :disabled="menuBusy" @click="removeMaster(m.id)">
                    {{ menuBusy ? '删除中…' : '确认删除' }}
                  </button>
                </div>
              </template>
            </div>
          </template>
        </li>
      </ul>

      <button v-if="!masterModal" type="button" class="sidebar__add" :disabled="!client" @click="openMasterAdd">＋ 添加主代理</button>
    </section>

    <footer class="sidebar__foot">
      <slot name="foot" />
    </footer>

    <!-- 添加 / 编辑主代理：同一张表单（编辑走 PATCH，绑定从登记与会话列表选） -->
    <ModalShell v-if="masterModal" :title="masterModal.mode === 'add' ? '添加主代理' : '编辑主代理'" @close="closeMasterModal">
      <form class="amaster" @submit.prevent="submitMaster">
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
            Harness（从「模型」登记里选）
            <select v-model="newHarness" class="amaster__input" :disabled="creating || harnessOptions.length === 0">
              <option v-if="harnessOptions.length === 0" value="">（未登记）</option>
              <option v-for="h in harnessOptions" :key="h" :value="h">{{ h }}</option>
            </select>
          </label>
          <label class="amaster__field">
            模型
            <select v-model="newModel" class="amaster__input" :disabled="creating || modelOptions.length === 0">
              <option v-if="modelOptions.length === 0" value="">（未登记）</option>
              <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
        </div>
        <label class="amaster__field">
          会话（{{ projectDir ? '列出当前项目目录下的 CLI 会话' : '按项目目录过滤' }}）
          <select v-if="projectDir" v-model="newSession" class="amaster__input" :disabled="creating">
            <option value="">开始新对话（不绑定 CLI 会话）</option>
            <option v-for="s in cliSessions" :key="s.id" :value="s.id">{{ sessionLabel(s) }}</option>
          </select>
          <span v-else class="amaster__hint">先在项目设置里绑定目录，才能列出该目录下的 CLI 会话。</span>
        </label>
        <label class="amaster__field">
          目录（所有权边界：只能动这个目录）
          <input v-model="newDir" class="amaster__input" type="text" placeholder="如 data/ 或 web/src/" :disabled="creating" />
        </label>

        <p v-if="addError" class="amaster__error">{{ addError }}</p>

        <footer class="amaster__actions">
          <button type="button" class="btn" :disabled="creating" @click="closeMasterModal">取消</button>
          <button type="submit" class="btn btn--primary" :disabled="creating">
            {{ creating ? '保存中…' : masterModal.mode === 'add' ? '创建主代理' : '保存' }}
          </button>
        </footer>
      </form>
    </ModalShell>

    <!-- 新建 / 编辑项目（同一张表单：目录 + 核心代理 LLM） -->
    <ProjectFormModal
      v-if="projectModal"
      :key="projectModal.mode + (projectModal.mode === 'edit' ? projectModal.project.slug : '')"
      :client="client"
      :mode="projectModal.mode"
      :project="projectModal.mode === 'edit' ? projectModal.project : null"
      :model-entries="modelEntries"
      @close="projectModal = null"
      @created="
        (s) => {
          projectModal = null
          emit('projects-changed', s)
        }
      "
      @saved="
        (pick) => {
          projectModal = null
          emit('projects-changed', undefined, pick)
        }
      "
    />
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

/* 项目条目：悬停时在 slug 下方追加显示绑定的目录（高亮），右侧浮出设置齿轮 */
.sidebar__proj {
  position: relative;
}

.sidebar__proj .sidebar__item {
  padding-right: 26px;
}

.sidebar__gear {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%);
  display: none;
  width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  color: var(--c-ink-3);
  border-radius: var(--radius-m);
  z-index: 1;
}

.sidebar__gear:hover {
  color: var(--c-ink);
  background: var(--c-border);
}

.sidebar__gear-icon {
  width: 14px;
  height: 14px;
}

/* 行菜单（项目/主代理齿轮弹出）：设置/编辑 + 删除二次确认 */
.rowmenu__mask {
  position: fixed;
  inset: 0;
  z-index: 45;
}

.rowmenu {
  position: absolute;
  right: 6px;
  top: calc(100% + 2px);
  z-index: 46;
  width: 200px;
  background: var(--c-panel);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  box-shadow: 0 8px 24px rgba(29, 37, 48, 0.14);
  padding: var(--sp-1);
  display: grid;
  gap: 1px;
}

.rowmenu__item {
  width: 100%;
  text-align: left;
  font-size: var(--fs-13);
  color: var(--c-ink);
  padding: 5px 9px;
  border-radius: var(--radius-m);
}

.rowmenu__item:hover {
  background: var(--c-panel-2);
}

.rowmenu__item--danger {
  color: var(--c-danger);
}

.rowmenu__warn {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  padding: 4px 8px 2px;
}

.rowmenu__warn code {
  font-family: var(--font-mono);
  color: var(--c-danger);
}

.rowmenu__error {
  font-size: var(--fs-12);
  color: var(--c-danger);
  padding: 2px 8px;
  word-break: break-all;
}

.rowmenu__acts {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding: var(--sp-1);
}

.rowmenu__cancel {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  padding: 2px 8px;
}

.rowmenu__cancel:hover {
  color: var(--c-ink);
}

.rowmenu__del {
  font-size: var(--fs-12);
  font-weight: 600;
  color: #fff;
  background: var(--c-danger);
  border-radius: var(--radius-m);
  padding: 2px 10px;
}

.rowmenu__del:disabled {
  opacity: 0.6;
}

/* 待验收清理弹层：任务清单 */
.rowmenu--audit {
  width: 250px;
}

.rowmenu__hint {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  padding: 4px 8px;
}

.rowmenu__tasks {
  max-height: 200px;
  overflow-y: auto;
  display: grid;
  gap: 2px;
  padding: 2px 4px;
}

.rowmenu__tasks li {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  padding: 3px 6px;
  border-radius: var(--radius-m);
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 6px;
  align-items: baseline;
}

.rowmenu__tasks li:hover {
  background: var(--c-panel-2);
}

.rowmenu__tasks code {
  font-family: var(--font-mono);
  flex: none;
}

.rowmenu__task-master {
  flex: none;
  color: var(--c-ink-3);
}

.rowmenu__task-sum {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.amaster__hint {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  padding: 4px 0;
}

.sidebar__proj:hover .sidebar__gear {
  display: inline-flex;
}

.sidebar__dir {
  display: none;
  color: var(--c-ink-2);
  font-weight: 500;
}

.sidebar__proj:hover .sidebar__dir {
  display: block;
}

.sidebar__flag--pending {
  color: var(--c-danger);
  border-color: var(--c-danger-border);
  background: var(--c-danger-bg);
  font-weight: 600;
}

/* 待验收徽标：可点击的清理入口 */
.sidebar__flag--review {
  color: var(--c-warn);
  border-color: var(--c-warn);
  background: var(--c-warn-bg);
  font-weight: 600;
}

.sidebar__flag--review:hover {
  filter: brightness(0.96);
}

/* 核心代理回复中：脉冲点 + 可点击停止 */
.sidebar__typing {
  flex: none;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  padding: 0 8px;
  line-height: 17px;
  white-space: nowrap;
}

.sidebar__typing:hover {
  color: var(--c-ink);
  border-color: var(--c-ink-3);
}

.sidebar__typing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--c-ok);
  animation: sidebar-pulse 1s ease-in-out infinite;
}

@keyframes sidebar-pulse {
  50% {
    opacity: 0.25;
  }
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

/* 核心代理状态：上下文占用告警（>80%，会话退化信号 §12.3）与启动按钮 */
.sidebar__item-sub.is-warn {
  color: var(--c-warn);
  font-weight: 600;
}

.sidebar__start {
  flex: none;
  margin-left: auto;
  font-size: var(--fs-12);
  color: var(--c-ink);
  font-weight: 600;
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  padding: 0 8px;
  line-height: 17px;
  background: var(--c-panel);
}

.sidebar__start:hover {
  border-color: var(--c-ink-3);
}

.sidebar__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding: var(--sp-1) var(--sp-2);
}

/* 主代理条目第三行：harness 名 + 最近遥测 */
.sidebar__meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar__harness {
  font-family: var(--font-mono);
  color: var(--c-ink-2);
  flex: none;
}

.sidebar__mcode {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  line-height: 12px;
  color: var(--c-warn);
  border: 1px solid var(--c-warn);
  border-radius: 3px;
  padding: 0 3px;
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
  /* minmax(0,1fr)：列可收缩到容器宽——select 的固有宽（最长选项文本，
     如 CLI 会话长标题）不许把表单撑出弹窗 */
  grid-template-columns: minmax(0, 1fr);
  gap: var(--sp-3);
}

.amaster__grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--sp-3);
}

.amaster__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.amaster__input {
  width: 100%;
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
