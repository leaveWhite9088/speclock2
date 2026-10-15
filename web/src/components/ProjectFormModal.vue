<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApiClient, CreateProjectBody, FsDirEntry, ModelEntry, Project } from '../api/client'
import { ApiError } from '../api/client'
import { normalizeFsPath, parentFsPath } from '../api/mock'
import ModalShell from './ModalShell.vue'

/**
 * 新建 / 编辑项目（契约 v0.4）：slug、名称、项目目录（粘贴或经 /api/fs/dirs
 * 浏览）、核心代理 LLM（选项 = 模型登记 + 默认跟随全局）。新建走 POST
 * /api/projects，编辑走 PATCH /api/p/{slug}（只提交改动过的字段）。
 */
const props = defineProps<{
  client: ApiClient | null
  mode: 'create' | 'edit'
  project?: Project | null
  modelEntries: ModelEntry[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'created', slug: string): void
  (e: 'saved'): void
}>()

const SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/

const slug = ref(props.mode === 'edit' ? (props.project?.slug ?? '') : '')
const name = ref(props.mode === 'edit' ? (props.project?.name ?? '') : '')
const workDir = ref(props.project?.working_dir ?? '')
/** '' = 默认（跟随全局配置）；'__current' = 编辑时保持登记里没有的原值不动 */
const llmPick = ref('')
const saving = ref(false)
const slugError = ref('')
const nameError = ref('')
const dirError = ref('')
const submitError = ref('')
/** 后端没有 /api/fs/dirs（契约 v0.4 未上线）时降级：只粘贴，不拦截提交 */
const fsUnavailable = ref(false)

if (props.mode === 'edit' && props.project?.chief_provider && props.project.chief_model) {
  const hit = props.modelEntries.find((e) => e.harness === props.project?.chief_provider && e.model === props.project?.chief_model)
  if (!hit) llmPick.value = '__current'
}

/** LLM 下拉：默认 + 登记条目（编辑时原值不在登记里则补一项「当前」） */
const llmOptions = computed(() => {
  const list = props.modelEntries.map((e) => ({ value: e.id, label: `${e.harness} · ${e.model}` }))
  if (llmPick.value === '__current') {
    list.unshift({ value: '__current', label: `当前（${props.project?.chief_provider}/${props.project?.chief_model}）` })
  }
  return list
})

function entryById(id: string): ModelEntry | undefined {
  return props.modelEntries.find((e) => e.id === id)
}

/* ---------- 目录浏览（GET /api/fs/dirs） ---------- */

const browsing = ref(false)
const browseLoading = ref(false)
const browsePath = ref('')
const browseEntries = ref<FsDirEntry[]>([])
const browseError = ref('')

async function browse(path: string): Promise<void> {
  if (!props.client) return
  browseLoading.value = true
  browseError.value = ''
  try {
    const res = await props.client.listFsDirs(path)
    browseEntries.value = res.items
    browsePath.value = normalizeFsPath(path)
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      browseError.value = '目录不存在或不可浏览'
    } else {
      fsUnavailable.value = true
      browseError.value = '后端暂未提供目录浏览（契约 v0.4 未上线），直接粘贴路径即可'
    }
  } finally {
    browseLoading.value = false
  }
}

function openBrowser(): void {
  browsing.value = true
  browseError.value = ''
  if (!browsePath.value) {
    const seed = workDir.value.trim() || 'D:/'
    browse(seed)
  }
}

function pickCurrent(): void {
  workDir.value = browsePath.value
  dirError.value = ''
  browsing.value = false
}

/** 失焦校验：非空时探一下目录（422 行内报错；端点未上线则放行） */
async function validateDir(): Promise<void> {
  const dir = workDir.value.trim()
  dirError.value = ''
  if (!dir || !props.client) return
  try {
    await props.client.listFsDirs(dir)
    fsUnavailable.value = false
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      dirError.value = '目录不存在或不是目录'
    } else {
      fsUnavailable.value = true // 端点未上线：不拦提交，交后端最终校验
    }
  }
}

/* ---------- 提交 ---------- */

function validateSlug(): boolean {
  if (!slug.value.trim()) {
    slugError.value = 'slug 必填'
    return false
  }
  if (!SLUG_RE.test(slug.value.trim())) {
    slugError.value = 'slug 只允许字母、数字、-、_，长度 1~64'
    return false
  }
  slugError.value = ''
  return true
}

async function submit(): Promise<void> {
  if (!props.client || saving.value) return
  if (props.mode === 'create' && !validateSlug()) return
  if (!name.value.trim()) {
    nameError.value = '项目名称必填'
    return
  }
  nameError.value = ''
  submitError.value = ''
  if (dirError.value) return
  saving.value = true
  try {
    if (props.mode === 'create') {
      const body: CreateProjectBody = {
        slug: slug.value.trim(),
        name: name.value.trim(),
        ...(workDir.value.trim() ? { working_dir: workDir.value.trim() } : {}),
      }
      const picked = entryById(llmPick.value)
      if (picked) {
        body.chief_provider = picked.harness
        body.chief_model = picked.model
      }
      await props.client.createProject(body)
      emit('created', body.slug)
    } else {
      const body: Record<string, string | null> = {}
      const origDir = props.project?.working_dir ?? null
      const newDir = workDir.value.trim() || null
      if (newDir !== origDir) body.working_dir = newDir
      if (llmPick.value !== '__current') {
        const picked = entryById(llmPick.value)
        const newProvider = picked?.harness ?? null
        const newModel = picked?.model ?? null
        if (newProvider !== (props.project?.chief_provider ?? null)) body.chief_provider = newProvider
        if (newModel !== (props.project?.chief_model ?? null)) body.chief_model = newModel
      }
      if (Object.keys(body).length > 0) await props.client.patchProject(props.project!.slug, body)
      emit('saved')
    }
  } catch (err) {
    submitError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalShell :title="mode === 'create' ? '新建项目' : '项目设置'" @close="emit('close')">
    <form class="pform" @submit.prevent="submit">
      <label class="pform__field">
        slug（唯一标识，账本文件名；创建后不可改）
        <input
          v-model="slug"
          class="pform__input"
          type="text"
          placeholder="如 daily-report"
          :disabled="mode === 'edit' || saving"
          @blur="mode === 'create' && slug.trim() && validateSlug()"
        />
      </label>
      <p v-if="slugError" class="pform__error">{{ slugError }}</p>

      <label class="pform__field">
        名称
        <input v-model="name" class="pform__input" type="text" placeholder="如 日报系统" :disabled="saving" />
      </label>
      <p v-if="nameError" class="pform__error">{{ nameError }}</p>

      <label class="pform__field">
        项目目录（该项目主代理的工作领地）
        <span class="pform__row">
          <input
            v-model="workDir"
            class="pform__input"
            type="text"
            placeholder="粘贴绝对路径，如 D:\work\daily-report"
            :disabled="saving"
            @blur="validateDir"
          />
          <button type="button" class="btn btn--sm" :disabled="saving" @click="openBrowser">浏览</button>
        </span>
      </label>
      <p v-if="dirError" class="pform__error">{{ dirError }}</p>

      <div v-if="browsing" class="pform__browser">
        <div class="pform__crumb">
          <button
            v-if="parentFsPath(browsePath)"
            type="button"
            class="pform__up"
            :disabled="browseLoading"
            title="上一级"
            @click="browse(parentFsPath(browsePath)!)"
          >↑ 上一级</button>
          <code class="pform__path" :title="browsePath">{{ browsePath || '—' }}</code>
          <button type="button" class="btn btn--sm btn--primary" :disabled="browseLoading || !browsePath" @click="pickCurrent">
            选这个目录
          </button>
        </div>
        <p v-if="browseError" class="pform__error">{{ browseError }}</p>
        <p v-else-if="browseLoading" class="pform__hint">读取中…</p>
        <ul v-else-if="browseEntries.length" class="pform__list">
          <li v-for="d in browseEntries" :key="d.path">
            <button type="button" class="pform__dir" :title="d.path" @click="browse(d.path)">📁 {{ d.name }}</button>
          </li>
        </ul>
        <p v-else class="pform__hint">（没有子目录了）</p>
      </div>

      <label class="pform__field">
        核心代理 LLM
        <select v-model="llmPick" class="pform__input" :disabled="saving">
          <option value="">默认（跟随全局配置）</option>
          <option v-for="o in llmOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>

      <p v-if="submitError" class="pform__error">{{ submitError }}</p>

      <footer class="pform__actions">
        <button type="button" class="btn" :disabled="saving" @click="emit('close')">取消</button>
        <button type="submit" class="btn btn--primary" :disabled="saving">
          {{ saving ? '保存中…' : mode === 'create' ? '创建项目' : '保存' }}
        </button>
      </footer>
    </form>
  </ModalShell>
</template>

<style scoped>
.pform {
  display: grid;
  gap: var(--sp-2);
}

.pform__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.pform__row {
  display: flex;
  gap: var(--sp-2);
}

.pform__row .pform__input {
  flex: 1;
  min-width: 0;
}

.pform__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 5px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  color: var(--c-ink);
}

.pform__input:focus {
  outline: none;
  border-color: var(--c-ink-3);
}

.pform__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.pform__hint {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

/* 目录浏览器：展开在输入框下方，子目录列表限高滚动 */
.pform__browser {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  background: var(--c-panel-2);
  padding: var(--sp-2);
  display: grid;
  gap: var(--sp-1);
}

.pform__crumb {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.pform__up {
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: 1px 7px;
}

.pform__up:hover:not(:disabled) {
  color: var(--c-ink);
}

.pform__path {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-12);
  color: var(--c-ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pform__list {
  max-height: 180px;
  overflow-y: auto;
  display: grid;
  gap: 1px;
}

.pform__dir {
  width: 100%;
  text-align: left;
  font-size: var(--fs-13);
  padding: 4px 8px;
  border-radius: var(--radius-m);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pform__dir:hover {
  background: var(--c-panel);
}

.pform__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}
</style>
