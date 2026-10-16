<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ApiClient, ModelEntry, ProviderProbe } from '../api/client'

/**
 * Harness×模型登记：工作台只登记、不替 Harness 配置模型。
 * 服务商区保管 API key（决定哪些模型可用，探测后可一键登记成 pi 条目）；
 * 登记区记录「这个 Harness 有哪些模型」（Harness + 模型两项），添加主代理时从中选。
 * 模型输入带自动发现（GET /api/harness-models）：datalist 给可选建议，仍可手填；
 * 清单为空、请求失败/超时、端点未上线（404）都静默退回手填。
 * 服务商区端点未上线（404）时整区降级为一行说明，登记区照常可用。
 */
const props = defineProps<{
  client: ApiClient | null
  entries: ModelEntry[]
}>()

const emit = defineEmits<{
  (e: 'changed'): void
}>()

const HARNESS_OPTIONS = ['pi', 'mcode', 'opencode']

const formHarness = ref(HARNESS_OPTIONS[0])
const formModel = ref('')
const error = ref('')
const registering = ref(false)
const removingId = ref('')

/* ---------- 模型自动发现（读，不是配） ---------- */

/** datalist 建议：非空时输入框出现可选列表；任何失败保持空 = 纯手填 */
const suggestions = ref<string[]>([])
const discoBusy = ref(false)
/** 按 harness 缓存，切回来不再发请求 */
const discoCache = new Map<string, string[]>()

async function discover(harness: string): Promise<void> {
  if (!props.client) return
  const hit = discoCache.get(harness)
  if (hit) {
    suggestions.value = hit
    return
  }
  discoBusy.value = true
  try {
    const res = await props.client.listHarnessModels(harness)
    const models = Array.isArray(res.models) ? res.models.filter((m) => typeof m === 'string' && m.trim()) : []
    discoCache.set(harness, models)
    if (formHarness.value === harness) suggestions.value = models
  } catch {
    // 404 / 失败 / 超时：不缓存、不报错，datalist 保持空即手填
    if (formHarness.value === harness) suggestions.value = []
  } finally {
    discoBusy.value = false
  }
}

watch(formHarness, (h) => void discover(h), { immediate: true })

/** 服务商变化后 pi 的可用模型会变：清缓存，当前选的是 pi 就立刻重拉 */
function refreshPiDiscovery(): void {
  discoCache.delete('pi')
  if (formHarness.value === 'pi') void discover('pi')
}

/* ---------- 服务商管理（fx22） ---------- */

interface ProvRow {
  name: string
  has_key: boolean
  probe: ProviderProbe | null
  probing: boolean
}

const providers = ref<ProvRow[]>([])
/** 后端未上线（GET /api/providers 404）：整区降级为一行说明 */
const provUnsupported = ref(false)
const provBusy = ref(false)
const provName = ref('')
const provKey = ref('')
const provError = ref('')
/** 两段式删除确认：先点变「确认删除」，再点才删 */
const pendingDelProv = ref('')

const PROV_RE = /^[a-z0-9-]+$/

async function loadProviders(): Promise<void> {
  if (!props.client) return
  try {
    const res = await props.client.listProviders()
    providers.value = res.items.map((p) => {
      const old = providers.value.find((x) => x.name === p.name)
      return { name: p.name, has_key: p.has_key, probe: old?.probe ?? null, probing: false }
    })
    provUnsupported.value = false
  } catch {
    // 404 = 后端未上线；其他错误同样按不可用降级，不阻塞登记区
    provUnsupported.value = true
  }
}

async function saveProvider(): Promise<void> {
  if (!props.client || provBusy.value) return
  const name = provName.value.trim()
  const key = provKey.value.trim()
  if (!PROV_RE.test(name)) {
    provError.value = '服务商名只允许小写字母、数字、连字符'
    return
  }
  if (!key) {
    provError.value = 'API key 必填'
    return
  }
  provBusy.value = true
  provError.value = ''
  try {
    await props.client.putProvider(name, key)
    provName.value = ''
    provKey.value = ''
    await loadProviders()
    refreshPiDiscovery()
  } catch (err) {
    provError.value = err instanceof Error ? err.message : String(err)
  } finally {
    provBusy.value = false
  }
}

async function removeProvider(name: string): Promise<void> {
  if (!props.client || provBusy.value) return
  if (pendingDelProv.value !== name) {
    pendingDelProv.value = name
    return
  }
  pendingDelProv.value = ''
  provError.value = ''
  try {
    await props.client.deleteProvider(name)
    await loadProviders()
    refreshPiDiscovery()
  } catch (err) {
    provError.value = err instanceof Error ? err.message : String(err)
  }
}

async function probe(row: ProvRow): Promise<void> {
  if (!props.client || row.probing) return
  row.probing = true
  provError.value = ''
  try {
    row.probe = await props.client.probeProvider(row.name)
  } catch (err) {
    row.probe = { name: row.name, ok: false, models: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    row.probing = false
  }
}

/** 探测结果一键登记：harness=pi + 该服务商 + 模型 id（复用 POST /api/models） */
const regProvModel = ref('')

function isProvRegistered(providerName: string, modelId: string): boolean {
  return props.entries.some((e) => e.harness === 'pi' && e.provider === providerName && e.model === modelId)
}

async function registerProbed(providerName: string, modelId: string): Promise<void> {
  if (!props.client || regProvModel.value) return
  regProvModel.value = `${providerName}/${modelId}`
  error.value = ''
  try {
    await props.client.registerModel({ harness: 'pi', provider: providerName, model: modelId })
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    regProvModel.value = ''
  }
}

void loadProviders()

/** 登记表按 Harness 分组（保持登记顺序） */
const grouped = computed<Array<{ harness: string; models: ModelEntry[] }>>(() => {
  const order: string[] = []
  const map = new Map<string, ModelEntry[]>()
  for (const e of props.entries) {
    if (!map.has(e.harness)) {
      map.set(e.harness, [])
      order.push(e.harness)
    }
    map.get(e.harness)!.push(e)
  }
  return order.map((harness) => ({ harness, models: map.get(harness)! }))
})

async function register(): Promise<void> {
  if (!props.client || registering.value) return
  const model = formModel.value.trim()
  if (!model) {
    error.value = '模型名必填（Harness 有什么模型就填什么）'
    return
  }
  registering.value = true
  error.value = ''
  try {
    await props.client.registerModel({ harness: formHarness.value, model })
    formModel.value = ''
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    registering.value = false
  }
}

async function remove(id: string): Promise<void> {
  if (!props.client || removingId.value) return
  removingId.value = id
  error.value = ''
  try {
    await props.client.removeModel(id)
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    removingId.value = ''
  }
}
</script>

<template>
  <div class="models">
    <p class="models__hint">
      工作台只登记、不替 Harness 配置模型。<b>服务商区</b>保管 API key（存钥匙不是选模型，钥匙决定哪些模型可用）；
      <b>登记区</b>记录「这个 Harness 有哪些模型」。添加主代理时从登记里选。
    </p>

    <!-- 服务商管理（fx22）：钥匙只存不显；探测结果可一键登记成 pi 条目 -->
    <section class="models__prov">
      <h6 class="models__group-title">服务商</h6>
      <template v-if="provUnsupported">
        <p class="models__prov-note">后端未提供服务商管理（/api/providers 未上线），这里暂不可用；下面的登记区不受影响。</p>
      </template>
      <template v-else>
        <p v-if="providers.length === 0" class="models__empty">
          还没有服务商。填一个名字和 API key（key 只保存，不显示）。
        </p>
        <ul v-else class="models__prov-list">
          <li v-for="p in providers" :key="p.name" class="models__prov-row">
            <div class="models__prov-line">
              <code class="models__prov-name">{{ p.name }}</code>
              <span class="models__keyflag" :class="p.has_key ? 'is-ok' : 'is-none'">
                {{ p.has_key ? '钥匙 有' : '钥匙 无' }}
              </span>
              <span class="models__prov-gap"></span>
              <button type="button" class="models__del" :disabled="p.probing || removingId !== ''" @click="probe(p)">
                {{ p.probing ? '探测中…' : '探测' }}
              </button>
              <button
                type="button"
                class="models__del"
                :class="{ 'models__del--arm': pendingDelProv === p.name }"
                :disabled="provBusy || removingId !== ''"
                @click="removeProvider(p.name)"
              >{{ pendingDelProv === p.name ? '确认删除' : '删除' }}</button>
            </div>
            <div v-if="p.probe" class="models__probe">
              <template v-if="p.probe.ok">
                <p v-if="p.probe.models.length === 0" class="models__empty">探测成功，但没有返回模型。</p>
                <div v-for="m in p.probe.models" :key="m.id" class="models__probe-row">
                  <code class="models__probe-id">{{ m.id }}</code>
                  <span v-if="m.thinking" class="models__think">思考</span>
                  <span class="models__prov-gap"></span>
                  <button
                    type="button"
                    class="models__del"
                    :disabled="isProvRegistered(p.name, m.id) || regProvModel !== ''"
                    :title="isProvRegistered(p.name, m.id) ? '已登记过' : '登记为 pi 条目（provider=该服务商）'"
                    @click="registerProbed(p.name, m.id)"
                  >{{ isProvRegistered(p.name, m.id) ? '已登记' : '登记进模型' }}</button>
                </div>
              </template>
              <p v-else class="models__probe-err">探测失败：{{ p.probe.error || '未知原因' }}</p>
            </div>
          </li>
        </ul>
        <form class="models__provform" @submit.prevent="saveProvider">
          <input
            v-model="provName"
            class="models__input"
            type="text"
            placeholder="服务商名（小写字母/数字/连字符）"
            :disabled="provBusy"
          />
          <input
            v-model="provKey"
            class="models__input models__keyinput"
            type="password"
            placeholder="API key"
            autocomplete="off"
            :disabled="provBusy"
          />
          <button type="submit" class="btn btn--sm btn--primary" :disabled="provBusy">
            {{ provBusy ? '保存中…' : '保存服务商' }}
          </button>
        </form>
        <p v-if="provError" class="models__error">{{ provError }}</p>
      </template>
    </section>

    <form class="models__form" @submit.prevent="register">
      <label class="models__field">
        Harness
        <select v-model="formHarness" class="models__input" :disabled="registering">
          <option v-for="h in HARNESS_OPTIONS" :key="h" :value="h">{{ h }}</option>
        </select>
      </label>
      <label class="models__field models__field--grow">
        模型<template v-if="discoBusy">（读取模型清单…）</template>
        <input
          v-model="formModel"
          class="models__input"
          type="text"
          list="models-discovered"
          :placeholder="suggestions.length ? '从清单选或直接填写' : '如 glm-4.7 / claude-sonnet-4.5'"
          :disabled="registering"
        />
        <datalist id="models-discovered">
          <option v-for="m in suggestions" :key="m" :value="m"></option>
        </datalist>
      </label>
      <button type="submit" class="btn btn--sm btn--primary models__add" :disabled="registering">
        {{ registering ? '登记中…' : '登记' }}
      </button>
    </form>

    <p v-if="error" class="models__error">{{ error }}</p>

    <div v-if="grouped.length" class="models__list">
      <section v-for="g in grouped" :key="g.harness" class="models__group">
        <h6 class="models__group-title">{{ g.harness }}</h6>
        <div v-for="e in g.models" :key="e.id" class="models__row">
          <span class="models__name">{{ e.model }}</span>
          <button
            type="button"
            class="models__del"
            :disabled="removingId !== ''"
            title="删除这条登记"
            @click="remove(e.id)"
          >删除</button>
        </div>
      </section>
    </div>
    <p v-else class="models__empty">还没有登记。先填上面两项，添加主代理时才有 Harness 与模型可选。</p>
  </div>
</template>

<style scoped>
.models {
  display: grid;
  gap: var(--sp-3);
}

.models__hint {
  color: var(--c-ink-2);
  font-size: var(--fs-12);
  background: var(--c-panel-2);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-2) var(--sp-3);
}

.models__form {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
}

.models__field {
  display: grid;
  gap: 2px;
  font-size: var(--fs-12);
  color: var(--c-ink-2);
}

.models__field--grow {
  flex: 1;
  min-width: 0;
}

.models__input {
  font: inherit;
  font-size: var(--fs-13);
  padding: 5px 8px;
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  background: var(--c-panel);
  color: var(--c-ink);
}

.models__input:focus {
  outline: none;
  border-color: var(--c-ink-3);
}

.models__add {
  flex: none;
}

.models__error {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.models__list {
  display: grid;
  gap: var(--sp-3);
}

.models__group {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-2) var(--sp-3);
  display: grid;
  gap: 2px;
}

.models__group-title {
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  font-weight: 600;
  font-family: var(--font-mono);
  padding-bottom: 2px;
}

.models__row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 2px 0;
}

.models__name {
  font-size: var(--fs-13);
  font-family: var(--font-mono);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models__del {
  margin-left: auto;
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid transparent;
  border-radius: var(--radius-m);
  padding: 1px 7px;
}

.models__del:hover:not(:disabled) {
  color: var(--c-danger);
  border-color: var(--c-danger-border);
}

.models__empty {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

/* ---------- 服务商区（fx22） ---------- */

.models__prov {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-2) var(--sp-3);
  display: grid;
  gap: var(--sp-2);
}

.models__prov-note {
  color: var(--c-ink-3);
  font-size: var(--fs-12);
}

.models__prov-list {
  display: grid;
  gap: var(--sp-2);
}

.models__prov-row {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-m);
  padding: var(--sp-1) var(--sp-2);
  display: grid;
  gap: var(--sp-1);
}

.models__prov-line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.models__prov-name {
  font-family: var(--font-mono);
  font-size: var(--fs-13);
  color: var(--c-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models__keyflag {
  flex: none;
  font-size: var(--fs-12);
  padding: 0 6px;
  border-radius: var(--radius-m);
  border: 1px solid var(--c-border);
}

.models__keyflag.is-ok {
  color: var(--c-ok);
  border-color: var(--c-ok);
}

.models__keyflag.is-none {
  color: var(--c-ink-3);
}

.models__prov-gap {
  flex: 1;
}

.models__del--arm {
  color: var(--c-danger);
  border-color: var(--c-danger);
}

.models__probe {
  border-top: 1px dashed var(--c-border);
  padding-top: var(--sp-1);
  display: grid;
  gap: 2px;
}

.models__probe-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-12);
  padding: 1px 0;
}

.models__probe-id {
  font-family: var(--font-mono);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.models__think {
  flex: none;
  font-size: var(--fs-12);
  color: var(--c-ink-3);
  border: 1px solid var(--c-border-strong);
  border-radius: var(--radius-m);
  padding: 0 5px;
}

.models__probe-err {
  color: var(--c-danger);
  font-size: var(--fs-12);
  word-break: break-all;
}

.models__provform {
  display: flex;
  gap: var(--sp-2);
}

.models__provform .models__input {
  min-width: 0;
}

.models__provform input:first-child {
  flex: 1;
}

.models__keyinput {
  flex: 1.2;
}
</style>
