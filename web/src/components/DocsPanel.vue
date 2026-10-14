<script setup lang="ts">
import type { ApiClient } from '../api/client'
import ModuleTree from './ModuleTree.vue'

/** 文档抽屉：模块全景树 + 草稿查看（S1 能力收纳入右侧抽屉）。 */
defineProps<{
  client: ApiClient | null
  slug: string
}>()
</script>

<template>
  <ModuleTree :client="client" :slug="slug" />
</template>
