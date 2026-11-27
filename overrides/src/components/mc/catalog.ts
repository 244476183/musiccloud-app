/**
 * 曲库池 + 4 档推荐 —— 纯数据层，零播放编排、零画像。
 *
 * 拍板口径：
 *   目标 400 / 上限 600 / 冷启 120；14 天淘汰 + 3 天保护 + pins 保留
 *   4 档 = 均衡 / 熟悉 / 尝鲜 / DJ；★ v35 起 DJ 为「段优先」：DJ 段先跑完回退，
 *     不足才用普通段补（段内仍是软加权，不做硬过滤；池非空时恒返回 n 首）
 *   画像全删（Profile / noteListen / noteDwell / tasteInfo / scenes / 置信度）
 *   ★ 保留 uses 计数与 pins：熟悉靠 uses*4、尝鲜靠 uses*2 惩罚，砍掉则两档退化成均衡
 *   persist() 只在补货 / 切歌 touch / pin 时触发（无停留结算、无全量画像写盘）
 *   数据源是原装 searchMusic 的种子词灌池，不是真榜单 API；不缓存直链、不预取
 */
import { getData, saveData } from '@/plugins/storage'
import { searchTracks, getHistory, type MCTrack } from './upstream'

export const TARGET = 400
export const MAX = 600
export const COLD_START = 120
const GC_DAYS = 14
const PROTECT_DAYS = 3
const DAY = 86400000
const STORE_KEY = 'mc_catalog_v1'

export type Mode = 'balanced' | 'familiar' | 'fresh' | 'dj'
export const MODES: Array<{ key: Mode, label: string }> = [
  { key: 'balanced', label: '均衡' },
  { key: 'familiar', label: '熟悉' },
  { key: 'fresh', label: '尝鲜' },
  { key: 'dj', label: 'DJ' },
]

export type Track = MCTrack & { uses: number, addedAt: number, pinned?: boolean }

/** 22 个种子词，与原废弃版一致；只灌元数据，不存直链。 */
const SEEDS = [
  '华语流行', '经典老歌', '民谣', '摇滚', '粤语', '古风', '国风',
  '电子舞曲', '轻音乐', '纯音乐', '钢琴', '吉他', '爵士', '说唱',
  'R&B', '治愈系', '励志', '夜晚', '通勤', '运动', 'DJ 混音', '影视原声',
]

let pool: Track[] = []
let loaded = false
let restocking = false

export const load = async(): Promise<void> => {
  if (loaded) return
  try {
    const d = await getData<Track[]>(STORE_KEY)
    pool = Array.isArray(d) ? d.filter(x => x && x.id && x.title) : []
  } catch (_) {
    pool = []
  }
  loaded = true
}

export const persist = async(): Promise<void> => {
  try { await saveData(STORE_KEY, pool) } catch (e) { console.log('[mc-catalog] 写盘失败', String(e)) }
}

export const stats = () => ({ count: pool.length, target: TARGET, max: MAX, cold: COLD_START })
export const snapshot = (): Track[] => [...pool]

/**
 * ★ 十一期：归一化曲目键 —— 同一首歌由不同音源返回时 id 不同（kw_123 / tx_123），
 *   只按 id 去重会并存于池子，视觉上就是「反复刷到同一首」。
 *   用「歌名|歌手」去空白/连接符/括号后小写，跨音源同曲归为一条。
 */
export const normKey = (t: { title?: string, artist?: string }): string =>
  `${String(t.title || '')}|${String(t.artist || '')}`.toLowerCase()
    .replace(/[\s·\-—_()（）\[\]【】]/g, '')

/**
 * ★ 九期（封面修复⑤）：音源脚本的搜索结果大多不带封面，
 *   封面要播放时由原装 getPicPath 另取。旧版取到后只写进播放状态，
 *   **从不回填曲库** → 池子永远缺图，推荐页大卡/榜单/单曲全是几何块。
 *
 * ★ 十期全面核查 P0-4（九期修复落空的真因）：
 *   曲库 id = searchTracks 的 `x.id ?? x.songmid`（音源返回 oldMusicInfo，如 `123456`）；
 *   播放态 id = 原装 toNewMusicInfo 生成的 **`${source}_${songmid}`**（如 `kw_123456`），
 *   kg 源甚至是 `songmid_hash`。旧版 `findIndex(x.id === playingId)` 恒返回 -1，
 *   「播一首补一首」从未真正命中。现在按多口径反查。
 *   纯数据层、异步落盘、不阻塞播放；重复值直接跳过，不写盘。
 */
export const coverKeys = (id: string): string[] => {
  const s = String(id || '').trim()
  if (!s) return []
  const keys = [s]
  // 剥掉 `source_` 前缀 → songmid；kg 的 `songmid_hash` 再剥一段
  const m = /^[a-z]+_(.+)$/i.exec(s)
  if (m) {
    keys.push(m[1])
    const h = /^(.+)_[0-9A-Za-z_-]{8,}$/i.exec(m[1])
    if (h) keys.push(h[1])
  }
  return [...new Set(keys.filter(Boolean))]
}

export const backfillCover = async(id: string, cover: string, altIds: string[] = []): Promise<void> => {
  const v = String(cover || '').trim()
  if (!v || !/^https?:\/\//i.test(v)) return
  const keys = [...new Set([...coverKeys(id), ...altIds.flatMap(coverKeys)])]
  if (!keys.length) return
  const i = pool.findIndex(x => {
    const cand = [
      String(x.id ?? ''), String(x.songmid ?? ''),
      String(x.raw?.id ?? ''), String(x.raw?.songmid ?? ''),
      String(x.source ? `${x.source}_${x.songmid ?? x.id}` : ''),
    ]
    return cand.some(c => c && keys.includes(c))
  })
  if (i < 0 || String(pool[i].cover || '') === v) return
  pool[i] = { ...pool[i], cover: v, raw: { ...(pool[i].raw || {}), img: v } }
  void persist()
}

const isDJ = (t: Track): boolean => /dj|remix|混音|电音|舞曲|夜店|串烧/i.test(t.title + ' ' + t.artist)

/** 确定性伪随机：同一 seed 产出同一序列，用于「每日推荐」当天稳定。 */
const hashSeed = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
const rng = (seed: number): (() => number) => {
  let s = seed
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 单一 score()，4 档只调权重；不再有硬特征过滤、不再有 30 秒挑歌。 */
const score = (t: Track, mode: Mode, r: () => number = Math.random): number => {
  const freshness = Math.max(0, 1 - (Date.now() - t.addedAt) / (GC_DAYS * DAY))
  const rand = r() * 6
  let v = rand + freshness * 2
  if (mode === 'familiar') v += t.uses * 4
  else if (mode === 'fresh') v -= t.uses * 2
  if (mode === 'dj' && isDJ(t)) v += 40
  if (t.pinned) v += 8
  return v
}

/**
 * 自查修正：score() 内含随机，直接放进 Array.sort 比较器会导致
 * 同一元素在不同比较中得分不同（比较器非确定），排序结果偏斜。
 * 改为「先给每首算一次分 → 按分数排序」，随机只抽一次。
 */
const ranked = (m: Mode, r: () => number = Math.random): Track[] => pool
  .map(t => ({ t, v: score(t, m, r) }))
  .sort((a, b) => b.v - a.v)
  .map(x => x.t)

/**
 * ★ P3「每日推荐」：日期字符串做确定性种子。
 *   当天 30 首固定不抖（不因每次打开浮层就换一批），跨天自动换。
 *   服务端纯货架不发行为数据、画像已删，所以这是本地可解释算法，不是个性化画像。
 */
export const pickDaily = async(dateKey: string, n = 30): Promise<Track[]> => {
  await load()
  if (!pool.length) return []
  return ranked('balanced', rng(hashSeed('daily:' + dateKey))).slice(0, n)
}

/**
 * ★ P3「猜你喜欢」：以最近播放的歌手 / 标题关键词做轻量共现加权。
 *   不记标签、不记场景、不记置信度、不落画像盘 —— 只是对本地最近播放做即时统计。
 *   空历史时退化为带固定种子的均衡排序，仍是有效的一批歌。
 */
export const pickGuess = async(n = 30): Promise<Track[]> => {
  await load()
  if (!pool.length) return []
  const recent = await getHistory().catch(() => [] as MCTrack[])
  const artists = new Set(recent.map(x => String(x.artist || '').trim()).filter(Boolean))
  const words = new Set<string>()
  for (const x of recent) {
    for (const w of String(x.title || '').replace(/[()（）\[\]【】]/g, ' ').split(/[\s·\-—_]+/)) {
      if (w.length >= 2) words.add(w)
    }
  }
  const r = rng(hashSeed('guess:' + recent.map(x => x.id).join('|').slice(0, 240)))
  return pool
    .map(t => {
      let v = score(t, 'balanced', r)
      if (artists.has(String(t.artist || '').trim())) v += 6
      for (const w of words) { if (t.title.includes(w)) { v += 2; break } }
      return { t, v }
    })
    .sort((a, b) => b.v - a.v)
    .slice(0, n)
    .map(x => x.t)
}

/**
 * 选题（推荐页用）。DJ 档软门槛：先按加权取，命中不足时用均衡歌补满，
 * 池非空时恒返回 n 首（400 池里 DJ 命中通常只有几十首，硬过滤会点进去全空）。
 */
export const pick = async(mode: Mode, n = 8): Promise<Track[]> => {
  await load()
  if (!pool.length) return []
  if (mode === 'dj') {
    const hits = ranked('dj').filter(isDJ).slice(0, n)
    if (hits.length >= n) return hits
    const fill = ranked('balanced').filter(t => !hits.some(h => h.id === t.id))
    return [...hits, ...fill].slice(0, n)
  }
  return ranked(mode).slice(0, n)
}

/**
 * ★ 十一期「1 天内不重复」：供刷歌页专用。
 *   - ★ v35：候选按「档位优先段」切开逐段挑选；dj 档先跑完 DJ 段的所有回退，
 *     普通段只在 DJ 段不足 n 时才补 —— 旧版 ① 段跨到普通歌就填满 n，DJ 档长期失效；
 *   - 每段先挑「当日没出现过」（id 或归一化键都没命中）的；
 *   - 同批内也按归一化键去重，避免跨音源同曲一次刷出两遍；
 *   - 每段内部：候选不足时**按本段档位排序**优先复用今天出现过的
 *     （v28：不再按最早出现顺序；v35：段间不越界，DJ 段先吃满回退再进普通段），
 *     再不够按排序补齐 —— 池非空时恒返回 n 首；池空时由调用方 bootstrap 兜底。
 *   - 不读历史文件、不建定时器、不改通用 pick()（推荐页/浮层/搜索不受影响）。
 */
export const pickFresh = async(
  mode: Mode, n: number,
  seenIds: Set<string>, seenKeys: Set<string>,
  oldestFirst: string[] = [],
): Promise<Track[]> => {
  await load()
  if (!pool.length) return []
  /** ★ v35：档位优先段。dj 档 = [DJ段, 普通段]，逐段各跑完整的 ①严格→②复用→③补齐；
   *  前一段填满 n 就不进下一段。非 dj 档只有一段且只调一次 ranked(mode)，
   *  与旧版随机序列、返回顺序完全一致（推荐页共用 score/ranked 一字未动）。 */
  const segments: Track[][] = mode === 'dj'
    ? [ranked('dj').filter(isDJ), ranked('balanced').filter(t => !isDJ(t))]
    : [ranked(mode)]
  const out: Track[] = []
  const used = new Set<string>()
  const push = (t: Track): boolean => {
    const k = normKey(t)
    if (used.has(k)) return false
    used.add(k); out.push(t); return true
  }
  for (const candidates of segments) {
    if (out.length >= n) break
    // ① 严格未出现（仅本段内）
    for (const t of candidates) {
      if (out.length >= n) break
      if (seenIds.has(t.id) || seenKeys.has(normKey(t))) continue
      push(t)
    }
    // ② 容量回退：只复用「今天出现过」的，按本段档位排序取
    //    （1 天内不重复口径不退化；v28 修的是本段内的排序，v35 修的是段间越界）
    if (out.length < n) {
      const today = new Set(oldestFirst)
      for (const t of candidates) {
        if (out.length >= n) break
        if (!seenIds.has(t.id) && !seenKeys.has(normKey(t)) && !today.has(t.id)) continue
        push(t)
      }
    }
    // ③ 仍不足：本段内按排序补齐（同批内仍不重复）
    if (out.length < n) {
      for (const t of candidates) {
        if (out.length >= n) break
        push(t)
      }
    }
  }
  return out
}

/**
 * 播放成功 / 切歌时调用：只累加 uses，不记口味、不记场景、不记置信度。
 * 自查修正：persist() 是全量重写 JSON（400 首≈0.2MB），每次切歌都写会卡低端机，
 * 也与「砍掉画像后 persist 只在补货/主动操作时触发」的定稿口径矛盾。
 * 改为只改内存，uses 随下一次 restock / pin 顺带落盘；
 * 杀进程丢失最近几次计数对「熟悉/尝鲜」的弱权重无感。
 * ★ 不引入任何节流定时器（红线：不建并行心跳/台账）。
 */
export const touch = async(id: string): Promise<void> => {
  await load()
  const t = pool.find(x => x.id === id)
  if (t) t.uses += 1
}

export const pin = async(id: string, value: boolean): Promise<void> => {
  await load()
  const t = pool.find(x => x.id === id)
  if (!t) return
  t.pinned = value
  await persist()
}

const gc = (): void => {
  const now = Date.now()
  pool = pool.filter(t => {
    if (t.pinned) return true
    if (now - t.addedAt < PROTECT_DAYS * DAY) return true
    return now - t.addedAt < GC_DAYS * DAY
  })
  if (pool.length > MAX) pool = pool.slice(-MAX)
}

/**
 * 补货：种子词并发 3 个，去重灌池。只在池子不足目标时跑，不建定时器。
 *
 * ★ 自查修正（冷启等待）：旧版固定灌到 TARGET=400 才返回，而刷歌页
 *   `await bootstrap()` 会一直等 8 轮种子词搜索跑完 → 全新安装第一次打开
 *   可能十几秒没声音（注释写「灌到 120 即可用、不等 400」与实现不符）。
 *   现加 `stopAt`：冷启只灌到 COLD_START=120（约 2~3 轮）即返回开刷；
 *   ★ 十一期：手动「补货一批」按钮已隐藏，改由 autoRestock() 在冷启后 / 队列见底时
 *     自动渐进补到 TARGET=400（用户零操作），每段都跑 gc() 自动清旧。
 */
export const restock = async(concurrency = 3, stopAt = TARGET): Promise<number> => {
  await load()
  if (restocking) return 0
  restocking = true
  let added = 0
  try {
    gc()
    // ★ 十一期：按归一化键去重，跨音源同曲不同 id 不再并存（刷歌重复的源头之一）
    const seen = new Set(pool.map(normKey))
    const seeds = [...SEEDS].sort(() => Math.random() - 0.5)
    for (let i = 0; i < seeds.length && pool.length < stopAt; i += concurrency) {
      const batch = seeds.slice(i, i + concurrency)
      const results = await Promise.all(batch.map(k => searchTracks(k, 30).catch(() => [] as MCTrack[])))
      for (const list of results) {
        for (const t of list) {
          if (pool.length >= stopAt) break
          const k = normKey(t)
          if (!t.id || !k.replace('|', '') || seen.has(k)) continue
          seen.add(k)
          pool.push({ ...t, uses: 0, addedAt: Date.now() })
          added++
        }
      }
    }
    gc()
    // 补货是低频主动动作，这里统一落盘一次：连带保存 gc 结果与期间累计的 uses。
    await persist()
  } finally {
    restocking = false
  }
  return added
}

/**
 * ★ 十一期「自动补货 + 自动清旧」：用户无需点任何按钮。
 *   - 由 McShell 冷启后、以及刷歌页队列快见底时异步触发，**不阻塞当前播放**；
 *   - 每次最多 3 段、每段约 100 首，渐进补到 TARGET=400，避免冷启干等十几秒；
 *   - 每段的 restock() 内部跑 gc()：14 天淘汰 / 3 天保护 / pins 保留 / 600 截断；
 *   - 音源给不出更多（某段 added==0）就停，不空转、不反复请求；
 *   - restocking 锁保证与 bootstrap / 其它触发点不并发；不建定时器（不是心跳）。
 */
export const autoRestock = async(): Promise<number> => {
  await load()
  if (pool.length >= TARGET) { gc(); return 0 }
  let total = 0
  for (let i = 0; i < 3 && pool.length < TARGET; i++) {
    const n = await restock(3, Math.min(pool.length + 100, TARGET))
    total += n
    if (n === 0) break
  }
  return total
}

/**
 * 组件 useEffect 里调用；冷启灌到 120 首即可用，不等 400。
 *
 * ★ 自查修正（并发陷阱）：旧版用 `let booted` 布尔，McShell 先 `void bootstrap()`
 *   启动异步灌池（restock 还没跑完），刷歌页随后 `await bootstrap()` 会**立即 return**，
 *   于是 pick 仍拿到空池 → 全新安装第一次打开不会自动播。
 *   现改为缓存「进行中的 Promise」：任何重复调用都 await 同一轮灌池，真正等它完成。
 *   失败时清空，允许下次重试。
 */
let bootPromise: Promise<void> | null = null
export const bootstrap = (): Promise<void> => {
  if (bootPromise) return bootPromise
  bootPromise = (async() => {
    await load()
    gc()
    // ★ 冷启只灌到 120 首就返回开刷，不等 400（见 restock 的 stopAt 说明）
    if (pool.length < COLD_START) await restock(3, COLD_START)
  })().catch(e => {
    bootPromise = null        // 失败允许下次挂载重试，绝不静默留一个空曲库
    console.log('[mc] 曲库冷启失败', String(e))
  })
  return bootPromise
}
