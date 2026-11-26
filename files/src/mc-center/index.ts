/**
 * 中心取音源 · 本工程唯一新增功能
 *
 * ════════════ 职责边界（刻意收窄）════════════
 *   ✅ 从中心「被动货架」GET 清单 + js 原文
 *   ✅ 交给洛雪原装 importUserApi() 落库（原装的 addUserApi / 存储 / 列表 / 设置页全不动）
 *   ❌ 不选源：setApiSource / setUserApi / loadScript 一律不碰
 *   ❌ 不取链、不播放、不碰 TrackPlayer / musicSdk / 播放器状态
 *   ❌ 不加任何 UI、不改任何界面、不弹框、不改应用名/图标/权限
 *   ❌ 不阻塞启动：init() 里 void 调用，全部 try/catch 静默
 *
 * 用户选源与播放在洛雪原装「设置 → 自定义音源」里完成，之后一切走原装链路：
 *   setApiSource → setUserApi → loadScript → QuickJS → getMusicUrl → TrackPlayer
 * 本模块退出后，APP 与官方原版行为完全一致。
 *
 * 未配置（centerBaseUrl / deviceId / token 任一为空）时本模块直接不运行，
 * 此时工程等价于 100% 未修改的洛雪 v1.9.2。
 */
import cfg from './config.json'
import { getData, saveData } from '@/plugins/storage'
import { getUserApiList } from '@/utils/data'
import { importUserApi, removeUserApi } from '@/core/userApi'
import { AppState } from 'react-native'

const STORE_KEY = 'mc_center_imported_v1'

type Imported = Record<string, { sha256: string, id: string }>

const tag = (...a: any[]) => console.log('[center-source]', ...a)

/** 整个请求（含 body 读取）共用一个超时，避免 headers 一返回就清 timer 导致 body 挂死。 */
const fetchText = async(url: string, timeoutMs: number): Promise<string> => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Cache-Control': 'no-store' } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const text = await res.text()
    return text
  } finally {
    clearTimeout(t)
  }
}

const q = (s: string) => encodeURIComponent(String(s))

const base = String(cfg.centerBaseUrl || '').replace(/\/+$/, '')

const urlOf = (path: string, extra: Record<string, string> = {}) => {
  const params = [
    'deviceId=' + q(cfg.deviceId || ''),
    'token=' + q(cfg.token || ''),
    ...Object.entries(extra).map(([k, v]) => k + '=' + q(v)),
  ].join('&')
  return base + path + '?' + params
}

/** 单条导入：先删旧版本，再交给原装 importUserApi，最后靠差集拿到原装生成的 id。 */
const installOne = async(file: string, sha256: string, oldId: string | undefined, timeoutMs: number) => {
  // 文件名可能是中文 / 括号 / 空格，必须逐个 encodeURIComponent，服务端实测不编码会 400
  const script = await fetchText(urlOf('/mc/app/source', { file }), timeoutMs)
  // 原装 addUserApi 要求脚本以 /* ... @name ... */ 注释块开头，缺了会抛错
  if (!/^\s*\/\*/.test(script) || !/@name\s/.test(script.slice(0, 400))) {
    throw new Error('脚本缺少 /* @name */ 头，原装无法导入')
  }
  if (oldId) await removeUserApi([oldId])
  const before = await getUserApiList()
  await importUserApi(script)          // ★ 唯一写入点：洛雪原装函数
  const after = await getUserApiList()
  // 原装 addUserApi 是 push 到列表末尾并生成随机 id，差集正常能命中；
  // 万一存储读回有延迟，兜底取末项，保证下次内容变更时能删掉旧条目。
  const added = after.find(x => !before.some(b => b.id === x.id)) || after[after.length - 1]
  return added?.id || ''
}

let syncing = false
const sync = async() => {
  if (syncing) return                  // 不并发，避免重复导入
  syncing = true
  try {
    const timeoutMs = Math.max(3000, Number(cfg.requestTimeoutMs) || 8000)
    const raw = await fetchText(urlOf('/mc/app/manifest'), timeoutMs)
    const manifest = JSON.parse(raw)
    const sources: any[] = Array.isArray(manifest.sources) ? manifest.sources : []
    if (manifest.frozen) { tag('设备已停用，跳过取源'); return }
    if (!sources.length) {
      tag('中心返回 0 个移动版音源 · 请到后台把音源标为「移动版 QuickJS」', manifest.hint || '')
      return
    }

    const imported: Imported = (await getData<Imported>(STORE_KEY)) || {}
    for (const s of sources) {
      const file = String(s.file || '')
      if (!file.endsWith('.js')) continue
      const sha = String(s.sha256 || s.md5 || '')
      const prev = imported[file]
      if (prev && prev.sha256 === sha) continue        // 内容没变，绝不下发/不重复导入
      try {
        const id = await installOne(file, sha, prev?.id, timeoutMs)
        imported[file] = { sha256: sha, id }
        tag('已导入', file, '→ 原装音源列表 id=' + (id || '(未取到，下次会重判)'))
      } catch (e: any) {
        // 单条失败不影响其它源，也不写记录，下次心跳自然重试
        tag('跳过', file, String(e?.message || e))
      }
    }
    await saveData(STORE_KEY, imported)
  } catch (e: any) {
    // 中心不通 / 返回非 JSON：静默，绝不阻塞 APP、绝不弹框
    tag('本轮取源未完成', String(e?.message || e))
  } finally {
    syncing = false
  }
}

/** 由 src/core/init/index.ts 以 void 方式调用，不 await、不阻塞启动。 */
export default () => {
  try {
    if (!base || !cfg.deviceId || !cfg.token) {
      tag('未配置中心地址/设备/令牌 · 本功能不启用，APP 保持 100% 原装')
      return
    }
    void sync()
    const every = Math.max(30, Number(cfg.intervalSec) || 60) * 1000
    setInterval(() => { void sync() }, every)
    AppState.addEventListener('change', st => { if (st === 'active') void sync() })
    tag('已启用 · 中心', base, '· 每', every / 1000, '秒复检一次')
  } catch (e: any) {
    tag('初始化失败（已忽略）', String(e?.message || e))
  }
}
