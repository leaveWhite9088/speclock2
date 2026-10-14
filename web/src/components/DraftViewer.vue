<script setup lang="ts">
import type { Block } from '../api/client'
import ApiFieldList from './ApiFieldList.vue'

defineProps<{
  block: Block
}>()
</script>

<template>
  <div class="draft">
    <section class="draft__sec">
      <h5 class="draft__sec-title">业务背景（content_md）</h5>
      <pre class="draft__pre">{{ block.draft.content_md || '（未填写）' }}</pre>
    </section>

    <section class="draft__sec">
      <h5 class="draft__sec-title">业务规则（rules · L1）</h5>
      <ul v-if="block.draft.rules.length > 0" class="draft__rules">
        <li v-for="rule in block.draft.rules" :key="rule.id" class="draft__rule">
          <span class="draft__rule-id">{{ rule.id }}</span>
          <span class="draft__rule-name">{{ rule.name }}</span>
          <span class="draft__rule-detail">{{ rule.detail }}</span>
        </li>
      </ul>
      <p v-else class="draft__empty">（暂无规则）</p>
    </section>

    <section class="draft__sec">
      <h5 class="draft__sec-title">API 契约（apis · L2）</h5>
      <p v-if="block.draft.apis.length === 0" class="draft__empty">（暂无契约）</p>
      <article v-for="api in block.draft.apis" :key="api.api" class="api-card">
        <header class="api-card__head">
          <span class="api-card__name">{{ api.name }}</span>
          <code class="api-card__path">{{ api.api }}</code>
        </header>
        <p class="api-card__desc">{{ api.desc }}</p>
        <div class="api-card__group">
          <h6 class="api-card__group-title">request</h6>
          <ApiFieldList v-if="api.request.length > 0" :fields="api.request" />
          <p v-else class="draft__empty">（无参数）</p>
        </div>
        <div class="api-card__group">
          <h6 class="api-card__group-title">response</h6>
          <ApiFieldList v-if="api.response.length > 0" :fields="api.response" />
          <p v-else class="draft__empty">（无响应字段）</p>
        </div>
      </article>
    </section>

    <section class="draft__sec">
      <h5 class="draft__sec-title">非功能（nfr_md）</h5>
      <pre class="draft__pre">{{ block.draft.nfr_md || '（未填写）' }}</pre>
    </section>
  </div>
</template>

<style scoped>
.draft {
  display: grid;
  gap: var(--sp-3);
}

.draft__sec {
  display: grid;
  gap: var(--sp-1);
}

.draft__sec-title {
  font-size: var(--fs-12);
  font-weight: 600;
  color: var(--c-ink-3);
}

.draft__pre {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  background: var(--c-mono-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--c-ink);
}

.draft__rules {
  display: grid;
  gap: 2px;
}

.draft__rule {
  font-size: var(--fs-12);
  display: flex;
  gap: var(--sp-2);
  align-items: baseline;
  padding: 2px 0;
}

.draft__rule-id {
  font-family: var(--font-mono);
  color: var(--c-accent);
  flex: none;
}

.draft__rule-name {
  font-weight: 600;
  flex: none;
}

.draft__rule-detail {
  color: var(--c-ink-2);
}

.draft__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.api-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-s);
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-2);
  background: var(--c-panel-2);
}

.api-card__head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
}

.api-card__name {
  font-weight: 600;
  font-size: var(--fs-13);
}

.api-card__path {
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  color: var(--c-accent);
  background: var(--c-accent-bg);
  border-radius: var(--radius-s);
  padding: 0 6px;
}

.api-card__desc {
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.api-card__group {
  display: grid;
  gap: 2px;
}

.api-card__group-title {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
}
</style>
