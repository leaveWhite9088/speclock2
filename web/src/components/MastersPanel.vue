<script setup lang="ts">
/**
 * 代理面板（M1 占位）：主代理注册表端点不在契约 v0.2，先静态展示两席；
 * 「直达会话」为占位按钮（无逻辑，R-M2 接入，DESIGN.md §6.4 三护栏）。
 */
interface MasterRow {
  name: string
  master: string
  harness: string
  dir: string
}

const masters: MasterRow[] = [
  { name: '后端主代理', master: 'master:backend', harness: 'claude-code', dir: 'backend/' },
  { name: '前端主代理', master: 'master:frontend', harness: 'claude-code', dir: 'web/' },
]
</script>

<template>
  <div class="masters">
    <ul class="masters__list">
      <li v-for="m in masters" :key="m.master" class="masters__row">
        <div class="masters__info">
          <span class="masters__name">{{ m.name }}</span>
          <span class="masters__meta">{{ m.master }} · {{ m.harness }} · {{ m.dir }}</span>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          title="占位：R-M2 接入。开启直达会话自动生成技术任务单（intent=直达微调，scope 必填）"
        >直达会话</button>
      </li>
    </ul>
    <p class="masters__hint">
      直达会话三护栏（§6.4）：会话即任务单（自动建单）；业务红线（功能/规则/契约变更拒绝并指回主主代理）；对话流中默认可见。
    </p>
    <p class="masters__hint">主代理注册表管理（masters 端点）待后续轮次接入。</p>
  </div>
</template>

<style scoped>
.masters {
  display: grid;
  gap: var(--sp-3);
}

.masters__list {
  display: grid;
  gap: var(--sp-2);
}

.masters__row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2) var(--sp-3);
}

.masters__info {
  display: grid;
  gap: 1px;
}

.masters__name {
  font-weight: 600;
  font-size: var(--fs-13);
}

.masters__meta {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
  font-family: var(--font-mono);
}

.masters__row .btn {
  margin-left: auto;
  flex: none;
}

.masters__hint {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}
</style>
