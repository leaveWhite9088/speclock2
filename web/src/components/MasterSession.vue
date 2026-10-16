<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ApiClient, MasterInfo, Package } from '../api/client'
import type { ActivityItem } from '../types'
import { PARSE_QUALITY_HINTS, REPORT_STATUS_BADGE, REPORT_STATUS_LABELS, TASK_STATUS_LABELS, formatDuration, formatTokens } from '../types'
import RoleDocEditor from './RoleDocEditor.vue'

/**
 * 主代理工作流：盯进程时才看——工具调用、文件编辑、思考耗时等技术过程；
 * 过程直播（SSE master_output，按当前主代理的任务过滤）与最近回执摘要也在这。
 */
const props = defineProps<{
  master: MasterInfo
  activity: ActivityItem[]
  packages: Package[]
  /** SSE master_output 按 task_id 聚合的输出尾部（≤50 行，App 捕获） */
  liveOutputs: Record<string, string[]>
  /** 核心代理正在流式回复（跨视图可见的占用状态） */
  chiefStreaming: boolean
  /** 角色文档编辑所需 */
  client: ApiClient | null
  slug: string
}>()

const emit = defineEmits<{
  (e: 'stop-chief'): void
}>()

const el = ref<HTMLElement | null>(null)
const termEl = ref<HTMLElement | null>(null)

const myTasks = computed(() =>
  props.packages
    .flatMap((pkg) => pkg.tasks.map((t) => ({ pkg, task: t })))
    .filter(
      ({ task }) =>
        task.master === props.master.id ||
        task.master === props.master.name || // live 名册校验按名称派发（tasks.master = 主代理名）
        (task.master === null && props.master.id === 'frontend'),
    )
    .slice(0, 8),
)

/** 在跑（或本会话有直播输出）的任务：终端风逐个展示输出尾部（timeout 已死，不再等输出） */
const liveTasks = computed(() =>
  myTasks.value.filter(({ task }) => {
    const busy = ['dispatched', 'running'].includes(task.status)
    return busy || (props.liveOutputs[task.task_id]?.length ?? 0) > 0
  }),
)

/** 空闲态：最近一个有回执的任务（显示回执摘要） */
const lastReceiptTask = computed(() =>
  myTasks.value.find(({ task }) => task.receipt && ['done', 'reported', 'auditing', 'rejected'].includes(task.status))?.task ?? null,
)

/** 最近回执的结构化报告（契约 v0.6）；老回执为 null，走原有文字显示 */
const lastReport = computed(() => lastReceiptTask.value?.receipt?.report ?? null)

const lastReceiptText = computed(() => {
  const t = lastReceiptTask.value
  if (!t?.receipt) return ''
  return `${t.receipt.summary}\n自检：${t.receipt.self_check}\n改动文件：${t.receipt.files_changed.join('、')}`
})

/** 累计遥测：该主代理已完成任务的耗时与 token 总量（DESIGN §13.5 仪表盘一行的原料） */
const totals = computed(() => {
  const done = myTasks.value.filter(({ task }) => task.status === 'done' || task.status === 'reported')
  let ms = 0
  let tokens = 0
  let counted = 0
  for (const { task } of done) {
    if (task.duration_ms != null) ms += task.duration_ms
    if (task.tokens != null) tokens += task.tokens
    if (task.duration_ms != null || task.tokens != null) counted++
  }
  return { tasks: done.length, counted, ms, tokens }
})

const activityCount = computed(() => props.activity.length)

async function scrollToEnd(): Promise<void> {
  await nextTick()
  if (el.value) el.value.scrollTop = el.value.scrollHeight
}

onMounted(() => {
  void scrollToEnd()
})

watch(
  () => props.activity.length,
  () => {
    void scrollToEnd()
  },
)

// 过程直播：新输出到达时终端自动滚底
watch(
  () => props.liveOutputs,
  () => {
    nextTick(() => {
      const node = termEl.value
      if (node) node.scrollTop = node.scrollHeight
    })
  },
  { deep: true },
)
</script>

<template>
  <div class="msession">
    <header class="msession__head">
      <span class="msession__avatar" aria-hidden="true">{{ master.name.slice(0, 1) }}</span>
      <div class="msession__t">
        <span class="msession__name">{{ master.name }}</span>
        <span class="msession__duty">
          {{ master.duty }} · {{ master.dir }} · {{ master.harness }} · {{ master.model }}<template v-if="master.session">
            · 会话 {{ master.session_title || master.session }}</template
          >
        </span>
      </div>
      <span class="msession__count">
        {{ activityCount }} 条过程记录<template v-if="totals.counted > 0">
          · 累计 {{ totals.tasks }} 个任务 {{ formatDuration(totals.ms) }} · {{ formatTokens(totals.tokens) }} tokens(估)</template
        >
      </span>
    </header>

    <div class="msession__body">
      <div class="msession__inner">
        <!-- 通道说明 + 核心代理占用状态（跨视图可见） -->
        <p class="msession__notice">
          该主代理由任务派发驱动，对话请回<span class="msession__notice-b">核心代理</span>。
          <template v-if="chiefStreaming">
            核心代理正在回复…
            <button type="button" class="msession__stop" @click="emit('stop-chief')">停止</button>
          </template>
        </p>

        <section class="msession__sec">
          <h6 class="msession__sec-title">任务</h6>
          <p v-if="myTasks.length === 0" class="msession__empty">暂无分配到的任务。</p>
          <ul v-else class="msession__tasks">
          <li v-for="{ pkg, task } in myTasks" :key="task.task_id" class="msession__task">
            <code>{{ task.task_id }}</code>
            <span class="msession__pkg">{{ pkg.package_id }}{{ pkg.origin === 'tech' ? ' · 技术单' : '' }}</span>
            <span class="badge" :class="`badge--${task.status}`">{{ TASK_STATUS_LABELS[task.status] }}</span>
            <span v-if="task.duration_ms != null || task.tokens != null" class="msession__tele">
              ⏱ {{ task.duration_ms != null ? formatDuration(task.duration_ms) : '—' }} · {{ task.tokens != null ? `${formatTokens(task.tokens)} tokens(估)` : '—' }}
            </span>
          </li>
          </ul>
        </section>

        <section class="msession__sec">
          <h6 class="msession__sec-title">过程直播</h6>
          <p v-if="liveTasks.length === 0" class="msession__empty">
            暂无在跑的任务的过程输出（派发任务后这里实时滚动该主代理的输出尾部）。
          </p>
          <div v-else ref="termEl" class="mterm">
            <div v-for="{ pkg, task } in liveTasks" :key="task.task_id" class="mterm__blk">
              <p class="mterm__head">
                <span class="mterm__dot" aria-hidden="true"></span>
                <code>{{ task.task_id }}</code>
                <span class="mterm__pkg">{{ pkg.package_id }}{{ pkg.origin === 'tech' ? ' · 技术单' : '' }}</span>
                <span class="badge" :class="`badge--${task.status}`">{{ TASK_STATUS_LABELS[task.status] }}</span>
              </p>
              <pre class="mterm__body">{{ (liveOutputs[task.task_id] ?? []).join('\n') || '（等待输出…）' }}</pre>
            </div>
          </div>
          <div v-if="liveTasks.length === 0 && lastReceiptTask?.receipt" class="mterm mterm--idle">
            <p class="mterm__head">
              <span class="mterm__dot mterm__dot--idle" aria-hidden="true"></span>
              <code>{{ lastReceiptTask.task_id }}</code>
              <span class="mterm__pkg">最近回执</span>
            </p>
            <div v-if="lastReport" class="mrep">
              <p class="mrep__line">
                <span class="badge" :class="REPORT_STATUS_BADGE[lastReport.status]">{{ REPORT_STATUS_LABELS[lastReport.status] }}</span>
                <span
                  v-if="lastReport.parse_quality !== 'structured' && lastReport.parse_quality !== 'manual'"
                  class="mrep__warn"
                  :title="PARSE_QUALITY_HINTS[lastReport.parse_quality]"
                >⚠ 主代理没有按规定格式报告</span>
              </p>
              <p class="mrep__summary">{{ lastReport.summary }}</p>
              <p class="mrep__label">改动文件 {{ lastReport.files_changed.length }} 个</p>
              <ul v-if="lastReport.files_changed.length > 0" class="mrep__list">
                <li v-for="f in lastReport.files_changed" :key="f"><code>{{ f }}</code></li>
              </ul>
              <template v-if="lastReport.issues.length > 0">
                <p class="mrep__label">问题</p>
                <ul class="mrep__list mrep__list--issue">
                  <li v-for="(it, i) in lastReport.issues" :key="i">{{ it }}</li>
                </ul>
              </template>
            </div>
            <pre v-else class="mterm__body">{{ lastReceiptText }}</pre>
          </div>
        </section>

        <section class="msession__sec">
          <h6 class="msession__sec-title">过程流</h6>
          <p v-if="activity.length === 0" class="msession__empty">
            暂无派发记录（派发任务并产出回执后，这里显示任务时间线、回执摘要与输出尾部）。
          </p>
          <ul v-else ref="el" class="msession__feed">
            <li v-for="item in activity" :key="item.id" class="act" :class="`act--${item.kind}`">
              <span v-if="item.ts" class="act__ts">{{ item.ts.slice(11, 19) }}</span>
              <span v-if="item.kind === 'thinking'" class="act__text act__text--dim">⏻ {{ item.text }}</span>
              <span v-else-if="item.kind === 'tool'" class="act__text">
                <span class="act__tool">{{ item.text }}</span>
                <code class="act__meta">{{ item.meta }}</code>
              </span>
              <span v-else-if="item.kind === 'edit'" class="act__text">
                <span class="act__file">{{ item.text }}</span>
                <code class="act__meta">{{ item.meta }}</code>
              </span>
              <span v-else-if="item.kind === 'note'" class="act__text act__text--dim">{{ item.text }}</span>
              <span v-else class="act__text act__text--msg">{{ item.text }}</span>
            </li>
          </ul>
        </section>

        <RoleDocEditor :client="client" :slug="slug" :target="{ kind: 'master', name: master.name }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.msession {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.msession__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg);
}

.msession__avatar {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-m);
  border: 1px solid var(--c-border-strong);
  background: var(--c-panel);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-13);
  color: var(--c-ink-2);
}

.msession__t {
  display: grid;
}

.msession__name {
  font-weight: 700;
  font-size: var(--fs-14);
}

.msession__duty {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
}

.msession__count {
  margin-left: auto;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.msession__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* 滚动容器占满整列（滚动条贴窗口最右），内容限宽只约束内部 */
.msession__inner {
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
  padding: var(--sp-4);
  display: grid;
  gap: var(--sp-4);
  align-content: start;
}

.msession__sec {
  display: grid;
  gap: var(--sp-2);
}

.msession__sec-title {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
}

.msession__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

/* 通道提示 + 核心代理占用状态 */
.msession__notice {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-1) var(--sp-2);
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex-wrap: wrap;
}

.msession__notice-b {
  color: var(--c-ink-2);
  font-weight: 600;
}

.msession__stop {
  font-size: var(--fs-12);
  color: var(--c-ink);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: 0 8px;
}

.msession__stop:hover {
  border-color: var(--c-ink-3);
}

/* 过程直播终端：等宽、限高、自动滚底；空闲态展示最近回执摘要 */
.mterm {
  display: grid;
  gap: var(--sp-2);
}

.mterm__blk {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  overflow: hidden;
}

.mterm--idle {
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: var(--sp-2);
}

.mterm__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  padding: var(--sp-1) var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}

.mterm__head code {
  font-family: var(--font-mono);
}

.mterm__pkg {
  color: var(--c-ink-3);
}

.mterm__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--c-ok);
  flex: none;
}

.mterm__dot--idle {
  background: var(--c-border-strong);
}

.mterm__body {
  margin: 0;
  padding: var(--sp-2);
  max-height: 220px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  line-height: 1.6;
  color: var(--c-ink-2);
  white-space: pre-wrap;
  word-break: break-all;
}

/* 最近回执：结构化报告 */
.mrep {
  display: grid;
  gap: var(--sp-1);
  padding: var(--sp-2);
  font-size: var(--fs-12);
}

.mrep__line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.mrep__warn {
  color: var(--c-ink-2);
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-s);
  padding: 0 6px;
  cursor: help;
}

.mrep__summary {
  color: var(--c-ink);
  line-height: 1.6;
}

.mrep__label {
  color: var(--c-ink-3);
  font-weight: 600;
}

.mrep__list {
  display: grid;
  gap: 2px;
}

.mrep__list code {
  font-family: var(--font-mono);
  color: var(--c-ink-2);
  white-space: pre-wrap;
  word-break: break-all;
}

.mrep__list--issue {
  padding-left: var(--sp-4);
  list-style: disc;
  color: var(--c-danger);
}

.msession__tasks {
  display: grid;
  gap: 2px;
}

.msession__task {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  padding: 3px 0;
}

.msession__task code {
  font-family: var(--font-mono);
}

.msession__pkg {
  color: var(--c-ink-3);
}

.msession__tele {
  margin-left: auto;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.msession__feed {
  display: grid;
  gap: 1px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  padding: var(--sp-2);
  max-height: 46vh;
  overflow-y: auto;
}

.act {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  padding: 2px 0;
}

.act__ts {
  font-family: var(--font-mono);
  color: var(--c-ink-3);
  flex: none;
}

.act__text {
  min-width: 0;
}

.act__text--dim {
  color: var(--c-ink-3);
}

.act__text--msg {
  color: var(--c-ink);
}

.act__tool {
  font-family: var(--font-mono);
  color: var(--c-ink);
  font-weight: 600;
}

.act__file {
  font-family: var(--font-mono);
  color: var(--c-ink);
}

.act__meta {
  font-family: var(--font-mono);
  color: var(--c-ink-3);
  margin-left: var(--sp-2);
}
</style>
