<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { MasterInfo, Package } from '../api/client'
import type { ActivityItem } from '../types'
import { TASK_STATUS_LABELS } from '../types'

/**
 * 主代理工作流：盯进程时才看——工具调用、文件编辑、思考耗时等技术过程；
 * 核心代理 ↔ 主代理的通信细节默认收在这里，不打扰主对话。
 */
const props = defineProps<{
  master: MasterInfo
  activity: ActivityItem[]
  packages: Package[]
}>()

const el = ref<HTMLElement | null>(null)

const myTasks = computed(() =>
  props.packages
    .flatMap((pkg) => pkg.tasks.map((t) => ({ pkg, task: t })))
    .filter(({ task }) => task.master === props.master.id || (task.master === null && props.master.id === 'frontend'))
    .slice(0, 8),
)

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
</script>

<template>
  <div class="msession">
    <header class="msession__head">
      <span class="msession__avatar" aria-hidden="true">{{ master.name.slice(0, 1) }}</span>
      <div class="msession__t">
        <span class="msession__name">{{ master.name }}</span>
        <span class="msession__duty">{{ master.duty }} · {{ master.dir }} · {{ master.harness }}</span>
      </div>
      <span class="msession__count">{{ activityCount }} 条过程记录</span>
    </header>

    <div class="msession__body">
      <section class="msession__sec">
        <h6 class="msession__sec-title">任务</h6>
        <p v-if="myTasks.length === 0" class="msession__empty">暂无分配到的任务。</p>
        <ul v-else class="msession__tasks">
          <li v-for="{ pkg, task } in myTasks" :key="task.task_id" class="msession__task">
            <code>{{ task.task_id }}</code>
            <span class="msession__pkg">{{ pkg.package_id }}{{ pkg.origin === 'tech' ? ' · 技术单' : '' }}</span>
            <span class="badge" :class="`badge--${task.status}`">{{ TASK_STATUS_LABELS[task.status] }}</span>
          </li>
        </ul>
      </section>

      <section class="msession__sec">
        <h6 class="msession__sec-title">过程流</h6>
        <p v-if="activity.length === 0" class="msession__empty">
          暂无过程记录（真实遥测 R-M2 接入；mock 模式下从「队列」一键开始即可看到模拟过程）。
        </p>
        <ul ref="el" class="msession__feed">
          <li v-for="item in activity" :key="item.id" class="act" :class="`act--${item.kind}`">
            <span class="act__ts">{{ item.ts.slice(11, 19) }}</span>
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
  padding: var(--sp-4);
  display: grid;
  gap: var(--sp-4);
  max-width: 780px;
  width: 100%;
  margin: 0 auto;
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
