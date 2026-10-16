<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ParseQuality, TaskReportEvent } from '../api/client'
import { PARSE_QUALITY_HINTS, REPORT_STATUS_BADGE, REPORT_STATUS_LABELS, formatDuration, masterLabel } from '../types'

/**
 * 任务报告卡片：由 task.report 事件的结构化数据渲染，不经核心代理转述。
 * 样式与核心代理气泡区分：灰底、左侧竖线、等宽小标题。
 */
const props = defineProps<{ report: TaskReportEvent }>()

const filesOpen = ref(false)

/** structured 与 manual 可信；其余三种要提示“没有按规定格式报告” */
const untrusted = computed(() => props.report.parse_quality !== 'structured' && props.report.parse_quality !== 'manual')

const hintText = computed(() =>
  (Object.keys(PARSE_QUALITY_HINTS) as ParseQuality[])
    .map((q) => `${q === props.report.parse_quality ? '▶ ' : ''}${q}：${PARSE_QUALITY_HINTS[q]}`)
    .join('\n'),
)

const TOKEN_SOURCE_LABELS = { exact: '精确', estimated: '估算' } as const
</script>

<template>
  <article class="rcard" :class="`rcard--${report.status}`" :data-task-id="report.task_id">
    <header class="rcard__head">
      <span class="rcard__tag">系统报告</span>
      <code class="rcard__id">{{ report.task_id }}</code>
      <span class="rcard__master">{{ masterLabel(report.master) }}</span>
      <span class="badge" :class="REPORT_STATUS_BADGE[report.status]">{{ REPORT_STATUS_LABELS[report.status] }}</span>
      <span v-if="untrusted" class="rcard__warn" :title="hintText">⚠ 主代理没有按规定格式报告</span>
    </header>

    <p class="rcard__summary">{{ report.summary }}</p>

    <div class="rcard__files">
      <button
        v-if="report.files_changed.length > 0"
        type="button"
        class="rcard__toggle"
        :aria-expanded="filesOpen"
        @click="filesOpen = !filesOpen"
      >{{ filesOpen ? '▾' : '▸' }} 改动文件 {{ report.files_changed.length }} 个</button>
      <span v-else class="rcard__muted">改动文件 0 个</span>
      <ul v-if="filesOpen" class="rcard__filelist">
        <li v-for="f in report.files_changed" :key="f"><code>{{ f }}</code></li>
      </ul>
    </div>

    <ul v-if="report.issues.length > 0" class="rcard__issues">
      <li v-for="(it, i) in report.issues" :key="i">{{ it }}</li>
    </ul>

    <footer class="rcard__foot">
      <span>耗时 {{ report.duration_ms != null ? formatDuration(report.duration_ms) : '—' }}</span>
      <span>token 来源 {{ report.token_source ? TOKEN_SOURCE_LABELS[report.token_source] : '—' }}</span>
    </footer>
  </article>
</template>

<style scoped>
.rcard {
  margin-left: 32px;
  display: grid;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--c-panel-2);
  border: 1px solid var(--c-border);
  border-left: 3px solid var(--c-border-strong);
  border-radius: var(--radius-s);
  font-size: var(--fs-13);
}

.rcard--done {
  border-left-color: var(--c-ok);
}

.rcard--blocked,
.rcard--failed {
  border-left-color: var(--c-danger);
}

.rcard__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  font-size: var(--fs-12);
}

.rcard__tag {
  font-family: var(--font-mono);
  color: var(--c-ink-3);
  letter-spacing: 0.04em;
}

.rcard__id {
  font-family: var(--font-mono);
}

.rcard__master {
  color: var(--c-ink-2);
}

.rcard__warn {
  color: var(--c-ink-2);
  border: 1px dashed var(--c-border-strong);
  border-radius: var(--radius-s);
  padding: 0 6px;
  cursor: help;
}

.rcard__summary {
  color: var(--c-ink);
  line-height: 1.6;
  word-break: break-word;
}

.rcard__toggle {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.rcard__toggle:hover {
  color: var(--c-ink);
}

.rcard__muted {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
}

.rcard__filelist {
  margin-top: var(--sp-1);
  display: grid;
  gap: 2px;
}

.rcard__filelist code {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  white-space: pre-wrap;
  word-break: break-all;
}

.rcard__issues {
  display: grid;
  gap: 2px;
  padding-left: var(--sp-4);
  list-style: disc;
  color: var(--c-danger);
  font-size: var(--fs-12);
}

.rcard__foot {
  display: flex;
  gap: var(--sp-3);
  font-size: var(--fs-12);
  color: var(--c-ink-3);
}
</style>
