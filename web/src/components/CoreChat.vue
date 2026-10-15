<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ModelEntry } from '../api/client'
import type { ChatBubble, FeedRound, ModelPick } from '../types'
import { formatDuration, formatTokens, masterLabel } from '../types'
import RoundDivider from './RoundDivider.vue'
import ApprovalCard from './ApprovalCard.vue'
import ModelMenu from './ModelMenu.vue'

/**
 * 核心代理会话：平时只看这里——对话（chat.* 事件投影，按轮次内嵌）、流式打字机、
 * 审批卡片内联呈现。人只发自然语言与 /model 命令；卡片由核心代理经 draft_card 起草。
 */
const props = defineProps<{
  feed: FeedRound[]
  /** 对话历史 + 即时消息，按轮次分组（与卡片/版本保持真实时序） */
  chatByRound: Record<number, ChatBubble[]>
  streaming: boolean
  streamText: string
  /** /model 命令弹出的模型选择层 */
  modelMenu: boolean
  modelEntries: ModelEntry[]
  currentModel: string | null
  projectHasDefault: boolean
  emptyNote?: string
  cardBusy: Record<string, boolean>
  cardError: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'send', text: string): void
  (e: 'stop'): void
  (e: 'retry'): void
  (e: 'pick-model', sel: ModelPick): void
  (e: 'close-model-menu'): void
  (e: 'manage-models'): void
  (e: 'start-retry', bubble: ChatBubble): void
  (e: 'approve', cardId: string): void
  (e: 'reject', cardId: string): void
}>()

const el = ref<HTMLElement | null>(null)
const draft = ref('')
/** 钉底：用户上翻查看历史时解除，出现「回到最新」；内容更新只在其钉底时跟随 */
const pinned = ref(true)
let lastMsgCount = 0
/** 程序化滚动保护窗：平滑滚底途中产生的 scroll 事件不当作用户上翻 */
let programmaticUntil = 0

const hasChat = computed(() => Object.keys(props.chatByRound).length > 0)

/** 轮次分组之外的消息（轮次尚未入列等边界情况），跟在最后渲染 */
const tailChat = computed(() => {
  const rounds = new Set(props.feed.map((fr) => fr.info.n))
  return Object.entries(props.chatByRound)
    .filter(([n]) => !rounds.has(Number(n)))
    .flatMap(([, list]) => list)
})

const msgCount = computed(() => Object.values(props.chatByRound).reduce((n, list) => n + list.length, 0))

function onScroll(): void {
  const node = el.value
  if (!node) return
  if (Date.now() < programmaticUntil) return
  pinned.value = node.scrollHeight - node.scrollTop - node.clientHeight < 80
}

/** rAF 平滑滚动；rAF 不活跃的环境（内嵌浏览器节流成 0 帧）200ms 内直接落位 */
let scrollAnim = 0

function animateScrollTo(node: HTMLElement, target: number): void {
  cancelAnimationFrame(scrollAnim)
  const from = node.scrollTop
  const dist = target - from
  if (Math.abs(dist) < 1) return
  let fired = false
  const t0 = performance.now()
  const dur = 320
  const step = (t: number): void => {
    fired = true
    const p = Math.min(1, (t - t0) / dur)
    node.scrollTop = from + dist * (1 - (1 - p) ** 3)
    if (p < 1) scrollAnim = requestAnimationFrame(step)
  }
  scrollAnim = requestAnimationFrame(step)
  setTimeout(() => {
    if (!fired) {
      cancelAnimationFrame(scrollAnim)
      node.scrollTop = target
    }
  }, 200)
}

function scrollToEnd(behavior: ScrollBehavior = 'auto'): void {
  nextTick(() => {
    const node = el.value
    if (!node) return
    const target = node.scrollHeight
    if (behavior === 'smooth') {
      animateScrollTo(node, target)
      programmaticUntil = Date.now() + 480
    } else {
      node.scrollTop = target
      programmaticUntil = Date.now() + 100
    }
  })
}

function jumpToLatest(): void {
  pinned.value = true
  scrollToEnd('smooth')
}

onMounted(() => {
  void scrollToEnd()
})

watch(
  () => [props.feed, msgCount.value, props.streaming, props.streamText],
  ([, count], prev) => {
    if (!pinned.value) return
    // 新消息落底用平滑滚动，流式增量用瞬时跟随
    const newMsg = Array.isArray(prev) && (count as number) > (prev[1] as number)
    scrollToEnd(newMsg || (count as number) > lastMsgCount ? 'smooth' : 'auto')
    lastMsgCount = count as number
  },
)

function send(): void {
  const text = draft.value.trim()
  if (!text || props.streaming) return
  draft.value = ''
  pinned.value = true
  scrollToEnd('smooth')
  emit('send', text)
}

/** 核心代理的口语化汇报：从账本事实派生（不是 AI 转述，A2） */
function cardIntro(round: FeedRound['cards'][number]): string {
  const breaking = round.breaking_count > 0 || round.api_ops.some((o) => o.breaking || o.op === 'remove')
  if (round.status === 'pending') {
    return `${round.statement.说明}——${round.statement.动机}。我整理成了这张卡片${breaking ? '，其中有一处破坏性变更，建议重点看那一条' : ''}：`
  }
  return ''
}

function packageLines(fr: FeedRound): string[] {
  return fr.packages.map((pkg) => {
    const masters = [...new Set(pkg.tasks.map((t) => masterLabel(t.master)))].join('、')
    return pkg.origin === 'tech'
      ? `技术任务单 ${pkg.package_id} 已建好，交给 ${masters}（不动业务、不进版本链）。到「队列」里可以一键开始。`
      : `任务包 ${pkg.package_id} 已排入队列，会派给 ${masters}，包内并行执行。到「队列」里可以一键开始。`
  })
}

function receiptLines(fr: FeedRound): string[] {
  const lines: string[] = []
  for (const pkg of fr.packages) {
    for (const task of pkg.tasks) {
      if (task.receipt && (task.status === 'done' || task.status === 'reported' || task.status === 'auditing' || task.status === 'rejected')) {
        const tele =
          task.duration_ms != null && task.tokens != null
            ? `，用时 ${formatDuration(task.duration_ms)}、约 ${formatTokens(task.tokens)} tokens`
            : ''
        lines.push(`${masterLabel(task.master)}完成了 ${task.task_id}：${task.receipt.summary}（改了 ${task.receipt.files_changed.length} 个文件${tele}）`)
      }
    }
  }
  return lines
}

function verdictLines(fr: FeedRound): string[] {
  return fr.verdictEvents.map((ev) => `${ev.type.endsWith('passed') ? '✓ 验收通过' : '✗ 验收未通过'}：${String(ev.ref.task ?? '')}${typeof ev.payload.note === 'string' && ev.payload.note ? `（${ev.payload.note}）` : ''}`)
}
</script>

<template>
  <div class="core">
    <div ref="el" class="core__feed" @scroll.passive="onScroll">
      <div class="core__inner">
        <p v-if="feed.length === 0 && !hasChat" class="core__empty">{{ emptyNote ?? '和核心代理的对话在这里进行。' }}</p>

        <template v-for="fr in feed" :key="fr.info.n">
          <RoundDivider :info="fr.info" />

          <!-- 轮内账本事实在前（卡片/版本/派发与回执汇报）…… -->
          <template v-for="card in fr.cards" :key="card.card_id">
            <div v-if="cardIntro(card)" class="core__msg core__msg--core">
              <span class="core__avatar" aria-hidden="true">核</span>
              <div class="core__bubble core__bubble--core">{{ cardIntro(card) }}</div>
            </div>
            <ApprovalCard
              class="core__card"
              :card="card"
              :busy="cardBusy[card.card_id] ?? false"
              :error="cardError[card.card_id] ?? ''"
              @approve="emit('approve', card.card_id)"
              @reject="emit('reject', card.card_id)"
            />
          </template>

          <p
            v-for="v in fr.versions"
            :key="`${fr.info.n}-${v.block_id}-${v.version}`"
            class="core__version"
          >✓ 已生成版本 {{ v.version }}（{{ v.delta_summary ?? '—' }}），文档库已定格，可在「文档」里回看当时全貌</p>

          <div v-for="(line, i) in [...packageLines(fr), ...receiptLines(fr), ...verdictLines(fr)]" :key="`l-${fr.info.n}-${i}`" class="core__msg core__msg--core">
            <span class="core__avatar" aria-hidden="true">核</span>
            <div class="core__bubble core__bubble--core">{{ line }}</div>
          </div>

          <!-- ……对话沉底：新消息始终出现在底部（时间正序） -->
          <template v-for="(msg, i) in chatByRound[fr.info.n] ?? []" :key="`c-${fr.info.n}-${i}`">
            <div v-if="msg.who === 'system'" class="core__sys">{{ msg.text }}</div>
            <div v-else-if="msg.who === 'error'" class="core__msg core__msg--core">
              <span class="core__avatar" aria-hidden="true">核</span>
              <div class="core__bubble core__bubble--error">
                {{ msg.text }}
                <button
                  v-if="msg.action?.kind === 'start-retry-model'"
                  type="button"
                  class="core__retry"
                  @click="emit('start-retry', msg)"
                >启动核心代理</button>
                <button v-else type="button" class="core__retry" @click="emit('retry')">重试</button>
              </div>
            </div>
            <div v-else class="core__msg" :class="`core__msg--${msg.who}`">
              <span v-if="msg.who === 'core'" class="core__avatar" aria-hidden="true">核</span>
              <div class="core__bubble" :class="`core__bubble--${msg.who}`">{{ msg.text }}</div>
            </div>
          </template>
        </template>

        <!-- 轮次未入列时的兜底渲染（如轮次列表尚未刷新） -->
        <template v-for="(msg, i) in tailChat" :key="`t-${i}`">
          <div v-if="msg.who === 'system'" class="core__sys">{{ msg.text }}</div>
          <div v-else-if="msg.who === 'error'" class="core__msg core__msg--core">
            <span class="core__avatar" aria-hidden="true">核</span>
            <div class="core__bubble core__bubble--error">
              {{ msg.text }}
              <button
                v-if="msg.action?.kind === 'start-retry-model'"
                type="button"
                class="core__retry"
                @click="emit('start-retry', msg)"
              >启动核心代理</button>
              <button v-else type="button" class="core__retry" @click="emit('retry')">重试</button>
            </div>
          </div>
          <div v-else class="core__msg" :class="`core__msg--${msg.who}`">
            <span v-if="msg.who === 'core'" class="core__avatar" aria-hidden="true">核</span>
            <div class="core__bubble" :class="`core__bubble--${msg.who}`">{{ msg.text }}</div>
          </div>
        </template>

        <!-- 流式生成中（message_delta 打字机） -->
        <div v-if="streaming" class="core__msg core__msg--core">
          <span class="core__avatar" aria-hidden="true">核</span>
          <div class="core__bubble core__bubble--core core__bubble--typing">
            {{ streamText || '正在思考…' }}<span class="core__caret" aria-hidden="true"></span>
          </div>
        </div>
      </div>

      <!-- 用户上翻后出现；新内容不再强制拽回 -->
      <button v-if="!pinned" type="button" class="core__jump" @click="jumpToLatest">↓ 回到最新</button>
    </div>

    <footer class="core__composer">
      <!-- /model 命令的选择弹层（命令本身不进对话正文） -->
      <div v-if="modelMenu" class="core__mmask" @click="emit('close-model-menu')"></div>
      <div v-if="modelMenu" class="core__mpanel">
        <header class="core__mhead">
          <span>切换核心代理模型</span>
          <button type="button" class="core__mclose" title="关闭" @click="emit('close-model-menu')">✕</button>
        </header>
        <ModelMenu
          :entries="modelEntries"
          :current-model="currentModel"
          :show-default="projectHasDefault"
          @pick="emit('pick-model', $event)"
          @manage="emit('manage-models')"
        />
      </div>
      <input
        v-model="draft"
        class="core__input"
        type="text"
        placeholder="给核心代理发消息…（/model 切换模型，Enter 发送）"
        aria-label="核心代理输入框"
        :disabled="streaming"
        @keydown.enter.prevent="send"
      />
      <button v-if="streaming" type="button" class="btn" @click="emit('stop')">停止</button>
      <button v-else type="button" class="btn btn--primary" :disabled="!draft.trim()" @click="send">发送</button>
    </footer>
  </div>
</template>

<style scoped>
.core {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.core__feed {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* 滚动容器占满整列（滚动条贴窗口最右），内容限宽只约束内部 */
.core__inner {
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.core__empty {
  color: var(--c-ink-3);
  padding: var(--sp-5);
  text-align: center;
}

/* 上翻后悬浮的「回到最新」 */
.core__jump {
  position: sticky;
  bottom: 12px;
  margin: -34px auto 0;
  display: block;
  z-index: 5;
  font-size: var(--fs-12);
  color: var(--c-ink);
  background: var(--c-panel);
  border: 1px solid var(--c-border-strong);
  border-radius: 999px;
  padding: 4px 14px;
  box-shadow: 0 4px 14px rgba(29, 37, 48, 0.14);
}

.core__msg {
  display: flex;
  gap: var(--sp-2);
  align-items: flex-start;
}

.core__msg--human {
  justify-content: flex-end;
}

.core__avatar {
  width: 24px;
  height: 24px;
  border-radius: var(--radius-s);
  border: 1px solid var(--c-border-strong);
  background: var(--c-panel);
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-top: 2px;
}

.core__bubble {
  max-width: 78%;
  padding: 7px 12px;
  border-radius: var(--radius-m);
  font-size: var(--fs-13);
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.core__bubble--core {
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  color: var(--c-ink);
}

.core__bubble--human {
  background: var(--c-accent);
  color: var(--c-accent-ink);
}

.core__bubble--typing {
  color: var(--c-ink-3);
}

.core__bubble--error {
  border-color: var(--c-danger-border);
  background: var(--c-danger-bg);
  color: var(--c-danger);
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.core__retry {
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-danger);
  border: 1px solid var(--c-danger-border);
  border-radius: var(--radius-m);
  padding: 0 8px;
}

.core__retry:hover {
  background: var(--c-danger);
  color: #fff;
}

/* 流式打字机光标 */
.core__caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--c-ink-3);
  animation: core-caret 1s steps(1) infinite;
}

@keyframes core-caret {
  50% {
    opacity: 0;
  }
}

.core__sys {
  text-align: center;
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  padding: 2px 0;
}

.core__card {
  margin-left: 32px;
}

.core__version {
  color: var(--c-ok);
  font-size: var(--fs-12);
  padding-left: 32px;
}

.core__composer {
  position: relative;
  flex: none;
  display: flex;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--c-border);
  background: var(--c-bg);
  max-width: 812px;
  width: 100%;
  margin: 0 auto;
}

/* /model 弹层：透明遮罩点击关闭，面板浮在输入框上方 */
.core__mmask {
  position: fixed;
  inset: 0;
  z-index: 40;
}

.core__mpanel {
  position: absolute;
  bottom: calc(100% + 6px);
  left: var(--sp-4);
  right: var(--sp-4);
  z-index: 41;
  background: var(--c-panel);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  box-shadow: 0 8px 24px rgba(29, 37, 48, 0.12);
  padding: var(--sp-1);
  max-height: 320px;
  overflow-y: auto;
}

.core__mhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
  padding: var(--sp-1) var(--sp-2);
}

.core__mclose {
  color: var(--c-ink-3);
  padding: 0 4px;
}

.core__mclose:hover {
  color: var(--c-ink);
}

.core__input {
  flex: 1;
  font: inherit;
  font-size: var(--fs-13);
  padding: 7px 14px;
  border: 1px solid var(--c-border-strong);
  border-radius: 10px;
  background: var(--c-panel);
  color: var(--c-ink-3);
}

.core__input:disabled {
  cursor: not-allowed;
}
</style>
