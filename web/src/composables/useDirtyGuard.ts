import { ref } from 'vue'

/**
 * 未保存修改守卫：编辑器把自己的“有未保存修改”状态登记在这里，
 * 切换视图（会话/项目/文档）前调用 confirmLeave() 确认。
 */
const dirtyKeys = ref<Set<string>>(new Set())

export function setDirty(key: string, dirty: boolean): void {
  const next = new Set(dirtyKeys.value)
  if (dirty) next.add(key)
  else next.delete(key)
  dirtyKeys.value = next
}

/** 无未保存修改，或用户确认放弃，返回 true；确认放弃后清除登记 */
export function confirmLeave(): boolean {
  if (dirtyKeys.value.size === 0) return true
  if (!window.confirm('角色文档有未保存的修改，离开会丢失它们。确定离开吗？')) return false
  dirtyKeys.value = new Set()
  return true
}

/** 关闭或刷新页面时的浏览器原生提示 */
window.addEventListener('beforeunload', (e) => {
  if (dirtyKeys.value.size > 0) e.preventDefault()
})
