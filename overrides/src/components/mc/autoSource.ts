/**
 * 音源就绪兜底 —— 目标：打开 APP、填完凭证进主界面，直接点歌就能播，
 * 绝不再需要「先去原装随便听一首再回来」。
 *
 * ★ 重新核实后修正的两处硬伤（上一版）：
 *   ① sourceReady() 里 `await apiInitPromise[0]` 在总闸未打通时是 **pending Promise**，
 *      await 会永久挂起 → 点歌直接卡死，不是「提示失败」而是没反应。
 *      现改为只读 `apiInitPromise[1]`（是否已 resolve）+ 校验 global.lx.apis 真的填充，
 *      完全不 await，永不挂起。
 *   ② ensureSourceSelected() 12 秒后 `return` 就永不重试；若中心取源比 12 秒慢
 *      （CF 隧道 / 移动网完全可能），这一轮错过后再没人补选。
 *      现改为：真正的兜底放在**每次点歌**的 waitSourceReady() 里，与冷启时序彻底解耦。
 *
 * ★ 原装判据（逐行核实 v1.9.2）：
 *   init/userApi/index.ts 的 handleStateChange 在 inited 回调里，
 *   ② `info.id !== setting['common.apiSource']` 通过后才做
 *   ③ `global.lx.apis = apis`（取链代理表）与 ④ `apiInitPromise[2](true)`（总闸）。
 *   ③ 和 ④ 在同一个分支里、必然同时发生 → **apis 已填充 且 [1]===true 即代表总闸已开**。
 *   setApiSource(id) 每次都会 loadScript → 触发一次新的 inited 回调；
 *   冷启时序（init 主链的 setApiSource('') / 脚本导入早晚 / info.id 合并结果）
 *   无论哪一种，点歌时的补选都会把这条链重新跑一遍直到打通。
 *
 * ★ 边界：只在「未就绪」时补选，最多 7 秒、成功即停；不是心跳、不 clearAll、
 *   不重装、不停播、不碰 loadScript / TrackPlayer / 播放器、不改 mc-center（冻结）。
 */
import { setApiSource } from '@/core/apiSource'
import { getUserApiList } from '@/utils/data'
import settingState from '@/store/setting/state'
import { getData, saveData } from '@/plugins/storage'

const KEY = 'mc.auto_source.v1'

/** 取链代理表是否真的落地 —— 比 await Promise 更准，且不会挂起。 */
const apisReady = (): boolean => {
  try {
    const apis: any = (global as any).lx?.apis
    if (!apis || typeof apis !== 'object') return false
    return Object.values(apis).some((x: any) => x && typeof x.getMusicUrl === 'function')
  } catch (_) { return false }
}

/** [1]===true 表示上一次 setApiSource 的 inited 回调已完整走完（含 [2] resolve）。 */
const resolved = (): boolean => {
  try { return (global as any).lx?.apiInitPromise?.[1] === true } catch (_) { return false }
}

/** 只读判据：不 await 任何 Promise，绝不挂起点歌。 */
export const sourceReady = async(): Promise<boolean> => {
  try { return resolved() && apisReady() } catch (_) { return false }
}

/**
 * ★ 十期全面核查 P0-9：旧版 waitSourceReady 判据 `resolved() || now-lastKick>1500`，
 *   在「apiInitPromise[1]===true 但 global.lx.apis 为空」这个矛盾态下 resolved() 恒 true
 *   → 每 200ms 补选一次（2 秒 10 次），每次都 loadScript，正是废弃版「反复重装」的形状。
 *   且启动轮 ensureSourceSelected 与点歌轮会并发跑两套补选。
 *   现在改为**全局单次锁 + 1500ms 最小间隔**，无论谁调用都共享节流。
 */
let kicking = false
let lastKickAt = 0
const MIN_KICK_GAP = 1500
const kick = async(): Promise<void> => {
  const now = Date.now()
  if (kicking || now - lastKickAt < MIN_KICK_GAP) return
  kicking = true
  lastKickAt = now
  try {
    const list: any[] = await getUserApiList()
    const ids = list.map(x => String(x.id)).filter(Boolean)
    if (!ids.length) return                       // 脚本还没导入，下一轮再来
    const cur = String(settingState.setting['common.apiSource'] || '')
    const id = ids.includes(cur) ? cur : ids[0]
    const prev = await getData<string>(KEY).catch(() => null)
    if (id !== cur && (!prev || prev !== id)) await saveData(KEY, id).catch(() => {})
    setApiSource(id)
  } catch (e) { console.log('[mc] 补选源失败', String(e)) }
  finally { kicking = false }
}

/**
 * 点歌前必走：总闸没开就自动补选并等待，最多 7 秒。
 * ★ 这是「打开就能播」的确定性保障，不依赖冷启那轮是否赶上了脚本导入。
 * ★ 不打断进行中的 init：只有上一轮已 resolve、或距上次补选 >1.5s 才再 kick。
 */
export const waitSourceReady = async(timeoutMs = 7000): Promise<boolean> => {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await sourceReady()) return true
    await kick()                    // 节流由 kick 内部统一保证，不再由调用方判据
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

/** 启动轮：尽力早一点打通，但打通与否都不影响可用性（点歌兜底会接住）。 */
export const ensureSourceSelected = (): void => {
  void (async() => {
    for (let i = 0; i < 24; i++) {
      if (await sourceReady()) return
      if (i % 2 === 0) await kick()
      await new Promise(r => setTimeout(r, 500))
    }
  })()
}
