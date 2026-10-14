<script setup lang="ts">
import type { ApiClient, FeedVersion } from '../api/client'
import ModuleTree from './ModuleTree.vue'

/** 文档抽屉：模块全景树 + 草稿查看 + 版本切换（模块级/域级）。 */
defineProps<{
  client: ApiClient | null
  slug: string
  versionsByBlock: Record<string, FeedVersion[]>
}>()
</script>

<template>
  <ModuleTree :client="client" :slug="slug" :versions-by-block="versionsByBlock" />
</template>
