/**
 * 池子换血日志 —— 只读旁路，零播放编排、零换血逻辑。
 * 只记录 McShell 真实触发过的轮次；写盘失败静默，不影响 rotateBatch 返回值。
 * 落盘 → 杀进程重开仍可读到冷启那轮；卸载重装才清空。
 */
import { getData, saveData } from '@/plugins/storage'

const KEY = 'mc_rotate_log_v1'
const MAX = 50

export type RotateKind = 'cold' | 'retry' | 'cycle'
export type RotateEntry = {
  at: number
  kind: RotateKind
  retry?: number
  n: number
  pool: number
  ms: number
}

let cache: RotateEntry[] | null = null
let chain: Promise<void> = Promise.resolve()

export const readRotateLog = async(): Promise<RotateEntry[]> => {
  if (cache) return [...cache]
  const l = await getData<RotateEntry[]>(KEY).catch(() => [] as RotateEntry[])
  cache = Array.isArray(l) ? l : []
  return [...cache]
}

/** 串行追加，避免多个轮次几乎同时落盘时互相覆盖；不 await、不抛错。 */
export const pushRotateLog = (e: RotateEntry): void => {
  chain = chain.then(async() => {
    const l = cache ?? await getData<RotateEntry[]>(KEY).catch(() => [] as RotateEntry[])
    const base = Array.isArray(l) ? l : []
    cache = [...base, e].slice(-MAX)
    await saveData(KEY, cache).catch(() => {})
  }).catch(() => {})
}

export const clearRotateLog = (): Promise<void> => {
  chain = chain.then(async() => {
    cache = []
    await saveData(KEY, []).catch(() => {})
  }).catch(() => {})
  return chain
}
