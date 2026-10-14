<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { FeedRound } from '../types'
import { masterLabel } from '../types'
import RoundDivider from './RoundDivider.vue'
import ApprovalCard from './ApprovalCard.vue'

/**
 * 核心代理会话：平时只看这里——口语化的汇报与提案引入，审批卡片内联呈现。
 * 人只发自然语言（发送/停止）；卡片由核心代理自己起草（R-M2 接真实核心代理）。
 */
const props = defineProps<{
  feed: FeedRound[]
  openers: Array<{ who: 'human' | 'core'; text: string }>
  chatMessages: Array<{ who: 'human' | 'core'; text: string }>
  thinking: boolean
  emptyNote?: string
  cardBusy: Record<string, boolean>
  cardError: Record<string, string>
}>()

const emit = defineEmits<{
  (e: 'send', text: string): void
  (e: 'stop'): void
  (e: 'approve', cardId: string): void
  (e: 'reject', cardId: string): void
}>()

type Line = { who: 'human' | 'core'; text: string }

const el = ref<HTMLElement | null>(null)
const draft = ref('')

async function scrollToEnd(): Promise<void> {
  await nextTick()
  if (el.value) el.value.scrollTop = el.value.scrollHeight
}

onMounted(() => {
  void scrollToEnd()
})

watch(
  () => [props.feed, props.chatMessages.length, props.thinking],
  () => {
    void scrollToEnd()
  },
)

function send(): void {
  const text = draft.value.trim()
  if (!text || props.thinking) return
  draft.value = ''
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

function packageLines(fr: FeedRound): Line[] {
  return fr.packages.map((pkg) => {
    const masters = [...new Set(pkg.tasks.map((t) => masterLabel(t.master)))].join('、')
    return {
      who: 'core' as const,
      text:
        pkg.origin === 'tech'
          ? `技术任务单 ${pkg.package_id} 已建好，交给 ${masters}（不动业务、不进版本链）。到「队列」里可以一键开始。`
          : `任务包 ${pkg.package_id} 已排入队列，会派给 ${masters}，包内并行执行。到「队列」里可以一键开始。`,
    }
  })
}

function receiptLines(fr: FeedRound): Line[] {
  const lines: Line[] = []
  for (const pkg of fr.packages) {
    for (const task of pkg.tasks) {
      if (task.receipt && (task.status === 'done' || task.status === 'reported' || task.status === 'auditing' || task.status === 'rejected')) {
        lines.push({
          who: 'core',
          text: `${masterLabel(task.master)}完成了 ${task.task_id}：${task.receipt.summary}（改了 ${task.receipt.files_changed.length} 个文件）`,
        })
      }
    }
  }
  return lines
}

function verdictLines(fr: FeedRound): Line[] {
  return fr.verdictEvents.map((ev) => ({
    who: 'core' as const,
    text: `${ev.type.endsWith('passed') ? '✓ 验收通过' : '✗ 验收未通过'}：${String(ev.ref.task ?? '')}${typeof ev.payload.note === 'string' && ev.payload.note ? `（${ev.payload.note}）` : ''}`,
  }))
}

const openersRound = computed(() => {
  for (let i = props.feed.length - 1; i >= 0; i--) {
    if (props.feed[i].cards.length > 0) return props.feed[i].info.n
  }
  return null
})

function showOpeners(fr: FeedRound): boolean {
  return props.openers.length > 0 && fr.info.n === openersRound.value
}
</script>

<template>
  <div class="core">
    <div ref="el" class="core__feed">
      <p v-if="feed.length === 0" class="core__empty">{{ emptyNote ?? '和核心代理的对话在这里进行。' }}</p>

      <template v-for="fr in feed" :key="fr.info.n">
        <RoundDivider :info="fr.info" />

        <template v-if="showOpeners(fr)">
          <div v-for="(op, i) in openers" :key="`op-${i}`" class="core__msg" :class="`core__msg--${op.who}`">
            <span v-if="op.who === 'core'" class="core__avatar" aria-hidden="true">核</span>
            <div class="core__bubble" :class="`core__bubble--${op.who}`">{{ op.text }}</div>
          </div>
        </template>

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
        >✓ 已生成版本 {{ v.version }}（{{ v.delta_summary ?? '—' }}），文档库已定格，可在右上「查看版本」回看当时全貌</p>

        <div v-for="(line, i) in [...packageLines(fr), ...receiptLines(fr), ...verdictLines(fr)]" :key="`l-${fr.info.n}-${i}`" class="core__msg core__msg--core">
          <span class="core__avatar" aria-hidden="true">核</span>
          <div class="core__bubble core__bubble--core">{{ line.text }}</div>
        </div>
      </template>

      <!-- 本次会话的即时对话（M1 mock；R-M2 接真实核心代理） -->
      <div v-for="(msg, i) in chatMessages" :key="`x-${i}`" class="core__msg" :class="`core__msg--${msg.who}`">
        <span v-if="msg.who === 'core'" class="core__avatar" aria-hidden="true">核</span>
        <div class="core__bubble" :class="`core__bubble--${msg.who}`">{{ msg.text }}</div>
      </div>
      <div v-if="thinking" class="core__msg core__msg--core">
        <span class="core__avatar" aria-hidden="true">核</span>
        <div class="core__bubble core__bubble--core core__bubble--typing">正在思考…</div>
      </div>
    </div>

    <footer class="core__composer">
      <input
        v-model="draft"
        class="core__input"
        type="text"
        placeholder="给核心代理发消息…（Enter 发送）"
        aria-label="核心代理输入框"
        :disabled="thinking"
        @keydown.enter.prevent="send"
      />
      <button v-if="thinking" type="button" class="btn" @click="emit('stop')">停止</button>
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
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
}

.core__empty {
  color: var(--c-ink-3);
  padding: var(--sp-5);
  text-align: center;
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

.core__card {
  margin-left: 32px;
}

.core__version {
  color: var(--c-ok);
  font-size: var(--fs-12);
  padding-left: 32px;
}

.core__composer {
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
