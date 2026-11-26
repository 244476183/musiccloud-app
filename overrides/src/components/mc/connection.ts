/**
 * 连接点模块 —— 零破封方案的唯一入口。
 *
 * 职责边界（务必保持）：
 *   ✅ 读/写本机已配置的 deviceId + token
 *   ✅ 把这两项写回 config.json 的模块对象（与 src/mc-center/index.ts 同一实例）
 *   ✅ 进程内调用一次原装导出的 initCenterSource()
 *   ✅ 首次激活前发一次只读 ping 做凭证校验
 *   ✅ 音源落库后补一次原装 setApiSource（一次性、幂等，修冷启总闸）
 *   ❌ 不新建心跳、不新建台账、不调 loadScript
 *   ❌ 不碰播放器、不清空音源、不做运行期管控
 *
 * 原装 init 主链那次 void initCenterSource() 因 config.json 里 deviceId/token 永远为空，
 * 必然纯 return（不注册 setInterval / AppState）。本模块这次调用是进程内唯一一次启用。
 */
import cfg from '@/mc-center/config.json'
import initCenterSource from '@/mc-center'
import { getData, saveData } from '@/plugins/storage'
import { ensureSourceSelected } from './autoSource'

const STORE_KEY = 'mc_gate_v1'

export type Gate = { deviceId: string, token: string }

/** ★ 进程内一次性开关：initCenterSource 自身没有防重入，重复调用会注册第二套定时器与监听。 */
let started = false

export const readGate = async(): Promise<Gate | null> => {
  try {
    const g = await getData<Gate>(STORE_KEY)
    if (!g || !g.deviceId || !g.token) return null
    return { deviceId: String(g.deviceId), token: String(g.token) }
  } catch (_) {
    return null
  }
}

export const saveGate = async(g: Gate): Promise<void> => {
  await saveData(STORE_KEY, g)
}

/** 只写两项。base（centerBaseUrl 的模块常量）/ intervalSec / requestTimeoutMs 一律不动。 */
export const applyGate = (g: Gate): void => {
  const c = cfg as { deviceId: string, token: string }
  c.deviceId = g.deviceId
  c.token = g.token
}

/**
 * 幂等启用。
 * ★ 十期全面核查 P1-21：旧版 `started = true` 写在 try 之前 —— 若 initCenterSource()
 *   抛错，配置已存盘、下次冷启直接进主页，但取源**永远不会再启用**（低概率、后果重）。
 *   改为：只有 initCenterSource 真正成功后才置位；失败复位，允许页内/下次冷启重试。
 *   ensureSourceSelected 内部自带 catch，单独 try 不影响 started 状态。
 */
export const enableOnce = (): void => {
  if (started) return
  try {
    initCenterSource()
  } catch (e) {
    started = false
    console.log('[mc-gate] 启用取源失败', String(e))
    return
  }
  started = true
  try { ensureSourceSelected() } catch (_) { /* 自带兜底，不影响已启用的心跳 */ }
}

export const centerBaseUrl = (): string => String((cfg as { centerBaseUrl: string }).centerBaseUrl || '')

export type PingResult = { ok: boolean, code: number, message: string }

/**
 * 只读 ping。独立于取源心跳，使用短超时；不发 If-None-Match、不写任何状态。
 * 401 / 403 一律视为「输入不正确」（首次锁页严格版，不放行）。
 * 网络错误也留在页内重试，但已配置过的老用户冷启动根本不会调这里。
 */
export const ping = async(g: Gate, timeoutMs = 7000): Promise<PingResult> => {
  const base = centerBaseUrl().replace(/\/+$/, '')
  if (!base) return { ok: false, code: 0, message: '安装包未配置中心地址' }
  const url = base + '/mc/app/ping?deviceId=' + encodeURIComponent(g.deviceId) + '&token=' + encodeURIComponent(g.token)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Cache-Control': 'no-store' } })
    if (res.status === 200) return { ok: true, code: 200, message: '连接成功' }
    if (res.status === 401) return { ok: false, code: 401, message: '设备 ID 或令牌不对，请核对后重填' }
    if (res.status === 403) return { ok: false, code: 403, message: '设备已停用，请联系管理员' }
    return { ok: false, code: res.status, message: '中心返回 HTTP ' + res.status }
  } catch (e: any) {
    return { ok: false, code: 0, message: '连不上中心：' + String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}
