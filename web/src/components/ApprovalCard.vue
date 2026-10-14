<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApiOp, Card, RuleOp } from '../api/client'

const props = defineProps<{
  card: Card
}>()

const MASTER_LABELS: Record<string, string> = { frontend: '前端', backend: '后端' }

function masterLabel(master: string): string {
  return MASTER_LABELS[master] ?? master
}

const STATUS_META: Record<Card['status'], { text: string; cls: string }> = {
  pending: { text: '待批准', cls: 'badge--pending' },
  approved: { text: '已批准', cls: 'badge--approved' },
  rejected: { text: '已打回', cls: 'badge--rejected' },
}

interface OpCounts {
  modified: number
  added: number
  removed: number
}

function opCounts(ops: Array<{ op: string; existed?: boolean }>): OpCounts {
  const c: OpCounts = { modified: 0, added: 0, removed: 0 }
  for (const op of ops) {
    if (op.op === 'add' || (op.op === 'upsert' && op.existed === false)) c.added++
    else if (op.op === 'remove') c.removed++
    else c.modified++
  }
  return c
}

function countText(c: OpCounts): string {
  const parts: string[] = []
  if (c.modified > 0) parts.push(`${c.modified}改`)
  if (c.added > 0) parts.push(`${c.added}增`)
  if (c.removed > 0) parts.push(`${c.removed}删`)
  return parts.length > 0 ? parts.join(' ') : '无变更'
}

const ruleCountText = computed(() => countText(opCounts(props.card.rule_ops)))
const apiCountText = computed(() => countText(opCounts(props.card.api_ops)))

function ruleOpLine(op: RuleOp): string {
  if (op.op === 'add') return `+ ${op.id} ${op.after?.name ?? ''}：${op.after?.detail ?? ''}`
  if (op.op === 'remove') return `- ${op.id} ${op.before?.name ?? ''}`
  const name = op.after?.name ?? op.before?.name ?? ''
  return `M ${op.id} ${name}：${op.before?.detail ?? ''} → ${op.after?.detail ?? ''}`
}

function apiOpLine(op: ApiOp): string {
  const prefix = op.op === 'remove' ? '-' : op.existed === false ? '+' : 'M'
  const detail =
    op.changes && op.changes.length > 0 ? op.changes.join('；') : (op.entry?.desc ?? '')
  return `${prefix} ${op.key}　${detail}`
}

function apiOpClass(op: ApiOp): string {
  const kind = op.op === 'remove' ? 'remove' : op.existed === false ? 'add' : 'modify'
  return `op op--${kind}`
}

const impactText = computed(() => props.card.impact.map(masterLabel).join('+') || '—')

const dispatchPreviewText = computed(() => {
  const preview = props.card.task_preview ?? []
  if (preview.length === 0) return '—'
  const counts = new Map<string, number>()
  for (const item of preview) counts.set(item.master, (counts.get(item.master) ?? 0) + 1)
  const text = [...counts.entries()].map(([master, n]) => `${masterLabel(master)}${n}`).join('+')
  return `${text} 并行`
})

// DESIGN.md §8.3：L2 区默认折叠，破坏性变更强制展开
const breaking = computed(() => props.card.breaking_count > 0)
const l2ManuallyOpen = ref(false)
const l2Open = computed(() => breaking.value || l2ManuallyOpen.value)

function toggleL2(): void {
  if (!breaking.value) l2ManuallyOpen.value = !l2ManuallyOpen.value
}
</script>

<template>
  <article class="approval-card" :aria-label="`变更卡片 ${card.card_id}`">
    <header class="approval-card__head">
      <span class="approval-card__title">变更卡片 #{{ card.round }} · 系统生成</span>
      <span class="approval-card__id">{{ card.card_id }}</span>
      <span class="badge" :class="STATUS_META[card.status].cls">{{ STATUS_META[card.status].text }}</span>
    </header>

    <dl class="approval-card__statement">
      <div class="stmt-row">
        <dt>说明</dt>
        <dd>{{ card.statement.说明 }}</dd>
      </div>
      <div class="stmt-row">
        <dt>动机</dt>
        <dd>{{ card.statement.动机 }}</dd>
      </div>
    </dl>

    <section class="approval-card__section">
      <h4 class="section-title">业务规则(L1)<span class="counts">{{ ruleCountText }}</span></h4>
      <ul class="ops">
        <li
          v-for="(op, i) in card.rule_ops"
          :key="`r-${i}`"
          :class="`op op--${op.op}`"
        >{{ ruleOpLine(op) }}</li>
      </ul>
    </section>

    <section class="approval-card__section">
      <h4 class="section-title" :class="{ 'section-title--toggle': !breaking }" @click="toggleL2">
        契约(L2)
        <span class="counts">{{ apiCountText }}</span>
        <span v-if="breaking" class="counts counts--breaking">⚠{{ card.breaking_count }} 破坏性</span>
        <span v-if="breaking" class="fold-hint fold-hint--locked" title="含破坏性变更，强制展开">强制展开</span>
        <span v-else class="fold-hint">{{ l2Open ? '收起' : '展开' }}</span>
      </h4>
      <ul v-if="l2Open" class="ops">
        <template v-for="(op, i) in card.api_ops" :key="`a-${i}`">
          <li :class="apiOpClass(op)">{{ apiOpLine(op) }}</li>
          <li
            v-for="(line, j) in op.breaking_changes ?? []"
            :key="`a-${i}-b-${j}`"
            class="op op--breaking"
          >⚠ {{ line }}</li>
        </template>
      </ul>
    </section>

    <p class="approval-card__meta">
      <span>影响面：{{ impactText }}</span>
      <span class="meta-sep" aria-hidden="true"></span>
      <span>派发预览：{{ dispatchPreviewText }}</span>
    </p>

    <p
      class="approval-card__risk"
      :class="{ 'approval-card__risk--verified': card.risk.verified_by === 'audit' }"
    >
      风险：{{ card.risk.text }}
      <span class="risk-suffix">—— {{ card.risk.verified_by === 'audit' ? '复查已核实' : '未复核' }}</span>
    </p>

    <footer class="approval-card__actions">
      <button type="button" class="btn btn--primary" title="S0 占位：S3 切片接入实际行为">批准并派发</button>
      <button type="button" class="btn" title="S0 占位：S3 切片接入实际行为">打回</button>
      <button type="button" class="btn btn--ghost" title="S0 占位：S2 切片接入字段级 diff">展开完整diff</button>
    </footer>
  </article>
</template>

<style scoped>
.approval-card {
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  box-shadow: var(--shadow-card);
  padding: var(--sp-4);
  display: grid;
  gap: var(--sp-3);
}

.approval-card__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.approval-card__title {
  font-weight: 700;
}

.approval-card__id {
  color: var(--c-ink-3);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.approval-card__statement {
  display: grid;
  gap: 2px;
  font-size: var(--fs-13);
}

.stmt-row {
  display: grid;
  grid-template-columns: 40px 1fr;
}

.stmt-row dt {
  color: var(--c-ink-3);
}

.approval-card__section {
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
}

.section-title {
  font-size: var(--fs-13);
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.section-title--toggle {
  cursor: pointer;
}

.section-title--toggle:hover {
  color: var(--c-accent);
}

.counts {
  font-weight: 400;
  color: var(--c-ink-2);
  font-family: var(--font-mono);
  font-size: var(--fs-12);
}

.counts--breaking {
  color: var(--c-danger);
  font-weight: 600;
}

.fold-hint {
  margin-left: auto;
  font-weight: 400;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
}

.fold-hint--locked {
  color: var(--c-danger);
}

.approval-card__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-13);
  color: var(--c-ink-2);
  flex-wrap: wrap;
}

.meta-sep {
  width: 1px;
  align-self: stretch;
  background: var(--c-border);
}

.approval-card__risk {
  border: 1px solid var(--c-warn-border);
  background: var(--c-warn-bg);
  color: var(--c-warn);
  border-radius: var(--radius-s);
  padding: var(--sp-2) var(--sp-3);
  font-size: var(--fs-13);
}

.approval-card__risk--verified {
  border-color: var(--c-ok-border);
  background: var(--c-ok-bg);
  color: var(--c-ok);
}

.risk-suffix {
  font-weight: 600;
}

.approval-card__actions {
  display: flex;
  gap: var(--sp-2);
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-3);
}
</style>
