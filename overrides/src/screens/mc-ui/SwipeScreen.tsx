/**
 * 刷歌页 —— 十一期：整屏沉浸式重排 + 2 行同步歌词 + 手势加速 + 1 天内不重复
 *
 * ★ 十一期改动（按拍板「全部按默认」）：
 *   ① 封面收到 h×0.28，封面下方固定 48px 放 2 行歌词（LyricLines，纯只读）；
 *      底部「上下滑换歌 · 不自动无限续播」文字删除；控件贴底、间距收紧。
 *   ② 上滑/下滑加快：夺取阈值 8→4px、触发 0.18→0.10、滑出 190→130ms、
 *      入场 spring 调硬、锁 900→450ms、回弹调硬。
 *   ③ 喜欢 / 缓存 改 toggle（配合 upstream 的 id 口径修复 + localCache 写锁）。
 *   ④ 档位浮层删「播放页 / 歌词」按钮；「换一批」走 fill(force) 真换。
 *   ⑤ 订阅 picUpdated 把播放拿到的真实封面写回刷歌队列（十期漏网点）。
 *   ⑥ 当日不重复 mc.swipe.day.v1 + 队列见底自动补货（autoRestock，含自动清旧）。
 *
 * 历史修复全部保留：五期卸载守卫、七期回调 ref 固定 / live 同步、九期整屏滑与背景、
 * 十期滑动锁兜底、八期并发不串歌（请求序号在 upstream.playTrack）。
 * 所有换歌只调 onPlay（原装取链播放）；队列只做 UI 展示，不自建播放状态机、不自判续播。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, StyleSheet, Animated, PanResponder, TouchableOpacity,
  useWindowDimensions, Easing,
} from 'react-native'
import { type Tokens } from '@/theme/mc'
import { SeekBar } from '@/components/mc/FullPlayer'
import playerState from '@/store/player/state'
import { getData, saveData } from '@/plugins/storage'
import {
  Chip, Cover, Sheet, SheetButton, LyricLines, type SheetTrack,
} from '@/components/mc/UI'
import {
  MODES, bootstrap, pickFresh, autoRestock, normKey, backfillCover, type Track, type Mode,
} from '@/components/mc/catalog'
import { type PlayerView } from '@/components/mc/usePlayer'
import { isFavorite, toggleFavorite } from '@/components/mc/upstream'
import { cacheLocal, isCached, removeCached, listCached } from '@/components/mc/localCache'
import { prefetchTrack } from '@/components/mc/prefetch'

/**
 * ★ 自查修正（沿用）：SwipeScreen 是条件渲染，切页回来会卸载重挂载。
 *   队列 / 位置 / 档位提升到模块级，重挂载原样恢复；切档保留当前歌在队首。
 */
let autoPlayedOnce = false
let sessionQueue: SheetTrack[] = []
let sessionIdx = 0
let sessionMode: Mode = 'balanced'
let sessionRev = 0
/** 「换一批」一次性标记：由档位浮层置起，下一次 fill 消费；切页换池(swap)时也会清掉，不跨挂载残留。 */
let forceFill = false
/**
 * ★ 十一期深度自查：所有 fill 串行化。
 *   旧版「队尾 append」与「refreshTick / rev 触发的 refresh」是两个独立 async，
 *   都会写 sessionQueue；一旦交错，后 commit 的会把先追加的队列截断或回滚。
 *   用模块级 Promise 链保证任意时刻只有一个 fill 改队列，且每次都执行（非丢弃式序号）。
 */
let fillChain: Promise<void> = Promise.resolve()

/* ── ★ 十一期「1 天内不重复」：按设备本地日期，跨天自动清空，记录持久化 ── */
type DaySeen = { dateKey: string, ids: string[], keys: string[] }
const DAY_KEY = 'mc.swipe.day.v1'
let dayCache: DaySeen | null = null
const todayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const loadDay = async(): Promise<DaySeen> => {
  if (dayCache) return dayCache
  let d: DaySeen | null = null
  try { d = await getData<DaySeen>(DAY_KEY) } catch (_) { d = null }
  if (!d || d.dateKey !== todayKey() || !Array.isArray(d.ids) || !Array.isArray(d.keys)) {
    d = { dateKey: todayKey(), ids: [], keys: [] }   // 跨天清空
  }
  dayCache = d
  return d
}
/** 入队即记录（用户要求「不重复出现」而非「不重复播放」）；写盘异步、不阻塞。 */
const record = (tracks: SheetTrack[]): void => {
  const d = dayCache
  if (!d) return
  for (const tr of tracks) {
    if (!d.ids.includes(tr.id)) d.ids.push(tr.id)
    const k = normKey({ title: tr.title, artist: tr.artist })
    if (k.replace('|', '') && !d.keys.includes(k)) d.keys.push(k)
  }
  if (d.ids.length > 1200) { d.ids = d.ids.slice(-800); d.keys = d.keys.slice(-800) }
  void saveData(DAY_KEY, d).catch(() => {})
}

const toSheet = (t: Track): SheetTrack => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album,
  duration: t.duration, cover: t.cover, raw: t.raw,
})

/* ★ 本轮：进度时间已随 SeekBar 一起抽走，本地 fmt 不再使用，清掉死代码。 */
export default ({ t, player, onPlay, onToggle, onSeek, onCoverChange, enterSeq, refreshTick }: {
  t: Tokens; player: PlayerView; onPlay: (t: SheetTrack) => void; onToggle: () => void
  /** ★ 本轮：刷歌页进度条也要能拖（原来只读）。复用原装 seekToRatio。 */
  onSeek: (r: number) => void
  /** ★ 深度自查：把「当前展示曲目」封面报给主壳，背景不滞后一首。 */
  onCoverChange: (cover: string) => void
  /** ★ D-2 A：主壳每次「切进刷歌」递增；变化即整批换池 + 自动开播。 */
  enterSeq: number
  refreshTick: number
}) => {
  const s = useMemo(() => makeStyles(t), [t])
  /** ★ F-08：封面缓慢呼吸缩放（纯 JS 驱动、页面卸载即停），近似「动态封面」。
   *  ★ 真机热修：原 useNativeDriver: true 与同 View 上 coverFade（JS 驱动，切歌
   *    封面淡入）混用 → RN 抛「JS driven animation on animated node moved to native」
   *    → 整壳错误页。全工程统一 false，彻底消除混用。
   *  不引 react-native-blur / GIF / 原生视频库，0 破封、不碰主链路。 */
  const breath = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(breath, { toValue: 1.028, duration: 4600,
        easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      Animated.timing(breath, { toValue: 1, duration: 4600,
        easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [])
  const { width, height } = useWindowDimensions()
  /** ★ 十一期：档位也从会话态恢复，否则切 Tab 重挂载回到 balanced → 队列被换档。 */
  const [mode, setMode] = useState<Mode>(sessionMode)
  const [queue, setQueue] = useState<SheetTrack[]>([])
  const [idx, setIdx] = useState(0)
  const [msg, setMsg] = useState('')
  /** ★ v30 / M：档位浮层专用反馈。Sheet 是原生 Modal（底层 msg 完全盖不住），
   *  而共享 msg 被 fill 链 / 切歌 / 缓存等 8 处写入竞争 → v29 直接绑上去会「一闪而过」。
   *  照推荐页 sheetToast 的写法独立成一条状态，与业务提示彻底隔离。 */
  const [modeToast, setModeToast] = useState('')
  const [modeOpen, setModeOpen] = useState(false)
  const [fav, setFav] = useState(false)
  /** ★ 十一期：缓存状态持久化到按钮（不再只是 2.6 秒一次性反馈） */
  const [cached, setCached] = useState(false)
  const [rev, setRev] = useState(sessionRev)
  const [cacheOk, setCacheOk] = useState(false)
  const [cacheFrom, setCacheFrom] = useState(0)
  const [cacheTo, setCacheTo] = useState(0)
  const [cacheNote, setCacheNote] = useState('已缓存本地')
  const toastFade = useRef(new Animated.Value(0)).current
  const cacheTimer = useRef<any>(null)
  const msgTimer = useRef<any>(null)
  /** ★ M：档位浮层专用定时器，与 msgTimer 各自独立、互不 clear。 */
  const modeToastTimer = useRef<any>(null)
  /** ★ 十一期深度自查：队尾自动补货 / 缓存按钮的「进行中」一次性标志。 */
  const appendingRef = useRef(false)
  const cachingRef = useRef(false)
  /** ★ 本轮：背景已提到主壳 root 层（状态栏/Tab/内容同色），本页不再自铺底，
       也省掉一层随切歌淡入的 Animated → 拖动少一个并发动画。 */
  const pan = useRef(new Animated.ValueXY()).current
  const opacity = useRef(new Animated.Value(1)).current
  const locked = useRef(false)
  const aliveRef = useRef(true)
  /** ★ 十期 P0-10：动画回调若被系统打断，locked 会永久 true → 再也滑不动 */
  const lockTimer = useRef<any>(null)
  useEffect(() => () => {
    aliveRef.current = false
    pan.stopAnimation()
    if (cacheTimer.current) clearTimeout(cacheTimer.current)
    if (msgTimer.current) clearTimeout(msgTimer.current)
    if (modeToastTimer.current) clearTimeout(modeToastTimer.current)
    if (lockTimer.current) clearTimeout(lockTimer.current)
    toastFade.stopAnimation()
  }, [pan, toastFade])
  /** ★ 七期①：回调收进 ref，1 秒进度刷新不重建 panResponder 手势链。 */
  const onPlayRef = useRef(onPlay)
  onPlayRef.current = onPlay
  const playerRef = useRef(player)
  playerRef.current = player

  const showMsg = (text: string) => {
    setMsg(text)
    if (msgTimer.current) clearTimeout(msgTimer.current)
    msgTimer.current = setTimeout(() => setMsg(''), 2600)
  }
  /** ★ v30 / M：独立通道，只服务档位浮层 toast。
   *  fill 链的补货提示、[cur?.id] 的切歌清 msg、缓存按钮的 setMsg('') 都碰不到它，
   *  因此「已切换到 · DJ」能稳定留满 2.6 秒，不会一闪而过。 */
  const showModeToast = (text: string) => {
    setModeToast(text)
    if (modeToastTimer.current) clearTimeout(modeToastTimer.current)
    modeToastTimer.current = setTimeout(() => setModeToast(''), 2600)
  }
  /** ★ M：关闭浮层时把专用提示与定时器一起收干净，重开不会看到上一条残留。 */
  const closeModeSheet = () => {
    setModeOpen(false)
    setModeToast('')
    if (modeToastTimer.current) { clearTimeout(modeToastTimer.current); modeToastTimer.current = null }
  }

  /** 队列写入统一走这里，保证 React state 与模块级会话状态同步。 */
  /** ★ D-2 A：当前曲目确定后，提前把「下一首」的直链取回来落进原装缓存。
   *  把 320k 换源重试那段（3~5 秒）挪到用户还没滑到时跑完；单飞去重、
   *  失败静默，正式播会自行重跑完整取链。只调 UI 层预取，不碰主链六步。 */
  const prefetchAhead = (q: SheetTrack[], i: number) => {
    const nx = q[i + 1]
    if (nx) prefetchTrack(nx)
  }
  const commit = (q: SheetTrack[], i: number) => {
    sessionQueue = q; sessionIdx = i
    setQueue(q); setIdx(i)
    prefetchAhead(q, i)
  }

  /**
   * ★ 十一期深度自查 P0-1（直接破坏「1 天内不重复」的真 bug）：
   *   旧版 `void autoRestock()` 不等待，pickFresh 紧接着用**旧池子**选题，
   *   而 day.ids 已含队列里全部歌 → 严格段全排除 → 走「按最旧复用」→
   *   队尾自动追加的其实是最早刷过的老歌，与需求正相反。
   *   修：append 时 **await autoRestock()**，等新歌灌进池子再 pickFresh；
   *   force（换一批）用户要立刻见效，仍只后台补、不阻塞。
   *   autoRestock 内部每段跑 gc()（14天淘汰/3天保护/pins/600截断），不是定时器。
   */
  const doFillRef = useRef<(m: Mode, append: boolean, force: boolean, swap: boolean) => Promise<void>>(async() => {})
  doFillRef.current = async(m: Mode, append = false, force = false, swap = false) => {
    try {
      const day = await loadDay()
      const seenIds = new Set(day.ids)
      const seenKeys = new Set(day.keys)
      if (append) await autoRestock()
      else if (force) void autoRestock()
      if (!aliveRef.current) return

      let ts = await pickFresh(m, 8, seenIds, seenKeys, day.ids)
      if (!ts.length) { await bootstrap(); if (!aliveRef.current) return; ts = await pickFresh(m, 8, seenIds, seenKeys, day.ids) }
      if (!aliveRef.current) return
      const list = ts.map(toSheet)
      /** ★ v35：空列表统一保护。切档 / 换一批 / 首次进入若继续往下走，
       *  会把队列截断成 1 首甚至 0 首 → next() 找不到下一首 → 用户直接滑不动。
       *  swap / append 两个分支各自已有保护，这里只挡其余三条路径。
       *  ★ v35 重审：这条路径也可能由 refreshTick / 后台补货刷新触发（浮层未开），
       *  而 Sheet 是 <Modal visible={modeOpen}>，未开时浮层内 toast 根本不渲染。
       *  两条通道都写：浮层开着 → modeToast 可见（底层 msg 被 Modal 盖住）；
       *  浮层未开 → 底层 msg 可见（toast 不渲染）。各渲染各的，不会同时可见。 */
      if (!list.length && !swap && !append) {
        showModeToast('曲库正在自动补货，稍等一下')
        showMsg('曲库正在自动补货，稍等一下')
        return
      }

      /**
       * ★ D-2 A「切回刷歌直接更换新的歌曲池」：整批换掉、连当前歌也不留。
       *   D-3 A：不清 mc.swipe.day.v1，record 只追加新出现的 id/key，
       *   「1 天内不重复」口径不被回退；重复治理效果如实以 v3 文档第九节为准
       *   （★ v37 起池子改为每 8 分钟滚动换血 120 首、前后台一视同仁，不再是「锁死 400 首」；
       *    此处保留 D-2 原说明，仅更正已过时的池子描述）。
       *   D-1 A：commit 后立即 onPlay 新池首曲，自动开播。
       *   ★ 放在所有分支最前，彻底绕开「已播过」分支用 live 顶队首的旧逻辑。
       *   不碰 catalog.ts（D-5 A），pickFresh 仍是既有选题口径。
       */
      if (swap) {
        if (!list.length) { showMsg('曲库正在自动补货，稍等一下'); return }
        record(list)
        commit(list, 0)
        sessionMode = m
        autoPlayedOnce = true
        if (aliveRef.current) onPlayRef.current(list[0])
        return
      }

      if (append) {
        if (!list.length) return
        record(list)
        commit([...sessionQueue, ...list], sessionIdx)
        return
      }

      /**
       * 已经播过 = 切档 / 后台补货刷新：保留当前歌与位置，绝不重播。
       * ★ 本轮删除七期的 live 覆盖逻辑：那段用 playMusicInfo 读「当前播放曲目」
       *   顶队首，是为「原样恢复刷歌队列、但声音已在别处换歌」的场景加的。
       *   D-2 A 之后切回刷歌一律 swap 整批换池并自动开播，画面与声音天然一致；
       *   若保留，refreshTick 在 swap 已提交、新歌取链未落地时到达，会把
       *   推荐页旧歌重新灌回新队首 —— 正是本次「覆盖当前歌」的根因。
       */
      if (autoPlayedOnce && sessionQueue.length && !force) {
        const cur = sessionQueue[sessionIdx] || sessionQueue[0]
        if (m === sessionMode) {
          commit(sessionQueue, sessionIdx)
        } else {
          const rest = list.filter(x => x.id !== cur.id)
          record(rest)
          commit([cur, ...rest], 0)
          sessionMode = m
        }
        return
      }

      // ★ 十一期真换一批：保留当前正在播的歌在队首，只替换后续，不打断、不重播。
      if (autoPlayedOnce && sessionQueue.length && force) {
        const cur = sessionQueue[sessionIdx] || sessionQueue[0]
        const rest = list.filter(x => x.id !== cur.id)
        record(rest)
        commit([cur, ...rest], 0)
        sessionMode = m
        showModeToast('已换一批 · 当前歌不打断')
        return
      }

      // 首次进入
      sessionMode = m
      if (list.length && !autoPlayedOnce) {
        autoPlayedOnce = true
        const p = playerRef.current
        if (p.playing || p.track) {
          const cur: SheetTrack | null = p.track
            ? { id: p.track.id, title: p.track.title, artist: p.track.artist,
                album: p.track.album, duration: p.track.duration, cover: p.track.cover,
                raw: p.track.raw }
            : null
          const q = cur ? [cur, ...list.filter(x => x.id !== cur.id)] : list
          record(list)
          commit(q, 0)
        } else {
          record(list)
          commit(list, 0)
          onPlayRef.current(list[0])                 // ★ 打开刷歌直接开播，不用先滑
        }
      } else {
        record(list)
        commit(list, 0)
      }
    } catch (e: any) {
      /** ★ v35.2：fillChain 是模块级，切页卸载后仍可能有排队的 fill 跑完；
       *  此时 doFillRef.current 仍指向旧实例，直接 showMsg 会对已卸载组件 setState。
       *  只在还活着时写提示，正常运行零变化。 */
      if (aliveRef.current) showMsg(String(e?.message || e))
    }
  }
  /** 所有调用点统一走这里：排队执行，避免并发写 sessionQueue。 */
  const fill = useCallback((m: Mode, append = false, force = false, swap = false): Promise<void> => {
    const run = fillChain
      .then(() => doFillRef.current(m, append, force, swap))
      .catch((e: any) => { if (aliveRef.current) showMsg(String(e?.message || e)) })
    fillChain = run
    return run
  }, [])

  /**
   * ★ 本轮：单一 effect 同时管「切页换池 / 切档 / 换一批 / 后台补货刷新」。
   *   两个 effect 拆开时，挂载瞬间普通 fill 会紧跟 swap 入链并把新队首
   *   用 playMusicInfo 里的旧歌换掉（第 1 条 bug 的根），合并后不复存在。
   *   enterRef 初值 -1 → 首次挂载必触发一次 swap（D-1 A 首次进刷歌也自动开播）。
   */
  const enterRef = useRef(-1)
  useEffect(() => {
    if (enterRef.current !== enterSeq) {
      enterRef.current = enterSeq
      /** ★ v35.2 重审：切页换池时顺手清掉在途的「换一批」标记。
       *  旧版只在非 swap 分支消费 forceFill，若用户点了换一批后立刻切走、
       *  切回又走 swap，标记会残留到下一次 refreshTick → 误触发一次 force。
       *  切页本身已是整批换池，这个在途意图由 swap 覆盖，清掉才符合「一次性」。 */
      forceFill = false
      void fill(mode, false, false, true)          // 整批换池 + 自动开播
      return
    }
    const f = forceFill; forceFill = false
    void fill(mode, false, f)
  }, [mode, rev, refreshTick, enterSeq, fill])

  const cur = queue[idx] || null
  /** ★ 深度自查 P1-③：刷歌视觉是 sessionQueue 的 cur，而主壳背景原先读
   *   player.track.cover（播放态，切歌时滞后）→ 背景慢一首。这里上报 cur.cover，
   *   onCoverChange 由主壳 useCallback 稳定化，依赖不变不会循环 setState。 */
  useEffect(() => { onCoverChange(String(cur?.cover || '')) },
    [cur?.id, cur?.cover, onCoverChange])

  /**
   * ★ v6 闪屏修复（核查结论：切歌空窗期把「无封面」立刻画成几何兜底块）。
   *   heldCover = 上一帧真实封面：切到新歌、封面还没到时继续显示它，不落兜底；
   *   真图（picUpdated 写回队列）到了 → 240ms 淡入；3 秒仍无图才落几何兜底
   *   （音源根本不给图时的诚实终态）。不碰播放器、不碰取链、不预取封面。
   */
  const [heldCover, setHeldCover] = useState('')
  const heldCoverRef = useRef('')
  const heldKeyRef = useRef('')
  const coverFade = useRef(new Animated.Value(1)).current
  const noCoverTimer = useRef<any>(null)
  useEffect(() => {
    const key = String(cur?.id || '')
    const uri = String(cur?.cover || '')
    if (uri) {
      if (noCoverTimer.current) { clearTimeout(noCoverTimer.current); noCoverTimer.current = null }
      heldKeyRef.current = key
      if (heldCoverRef.current !== uri) {
        heldCoverRef.current = uri
        setHeldCover(uri)
        /** ★ 深度自查 P1-③：快速连滑两下时两个 timing 会同时驱动 coverFade →
         *  opacity 抖动。先停掉进行中的那一个再重设、重启动画。 */
        coverFade.stopAnimation()
        coverFade.setValue(0.35)
        Animated.timing(coverFade, { toValue: 1, duration: 240,
          useNativeDriver: false }).start()
      }
    } else if (key && heldKeyRef.current !== key) {
      if (noCoverTimer.current) clearTimeout(noCoverTimer.current)
      noCoverTimer.current = setTimeout(() => {
        heldCoverRef.current = ''; setHeldCover(''); noCoverTimer.current = null
      }, 3000)
    }
  }, [cur?.id, cur?.cover])
  useEffect(() => () => { if (noCoverTimer.current) clearTimeout(noCoverTimer.current) }, [])
  /**
   * ★ 十一期深度自查 P0-2：isCached() 是异步读盘，快速切歌时上一首的结果会
   *   在切到下一首之后 resolve → 直接 setCached 覆盖当前首的按钮状态
   *   （已缓存显示 ↓ / 未缓存显示 ✓），导致「再点取消」删错或无效。
   *   加 alive 标志 + 校验 sessionQueue[sessionIdx] 仍是这首才写入。
   */
  useEffect(() => {
    const id = cur?.id ?? ''
    setFav(cur ? isFavorite(cur as any) : false)
    if (!id) { setCached(false); return }
    let alive = true
    void isCached(id).then(v => {
      if (alive && String(sessionQueue[sessionIdx]?.id ?? '') === id) setCached(v)
    }).catch(() => { if (alive) setCached(false) })
    return () => { alive = false }
  }, [cur?.id])
  /** ★ 十期：切歌清掉上一首 msg / 缓存成功态；背景换色由主壳按当前曲目封面处理。 */
  useEffect(() => {
    setCacheOk(false)
    setMsg('')
    if (cacheTimer.current) clearTimeout(cacheTimer.current)
  }, [cur?.id])

  /**
   * ★ 十一期封面回填（十期漏网点）：backfillCover 只写曲库池，sessionQueue 是
   *   toSheet() 拷出来的独立快照，池子更新回流不到它 → 刷歌大封面/背景永远几何块。
   *   订阅原装 picUpdated，校验多口径 id 后只改队列中那一条，不动 idx、不动播放器。
   */
  useEffect(() => {
    const ev: any = (global as any).app_event
    if (!ev || typeof ev.on !== 'function') return
    const onPic = () => {
      const mi: any = (playerState as any).playMusicInfo?.musicInfo
      const id = String(mi?.id ?? '')
      const pic = String((playerState as any).musicInfo?.pic ?? '')
      if (!id || !pic || !/^https?:\/\//i.test(pic)) return
      const keys = [id, String(mi?.meta?.songId ?? ''), String(mi?.songmid ?? '')].filter(Boolean)
      const stripped = keys.flatMap(k => { const m = /^[a-z]+_(.+)$/i.exec(k); return m ? [m[1]] : [] })
      const all = [...keys, ...stripped]
      const i = sessionQueue.findIndex(x => all.includes(x.id) ||
        (x.raw?.songmid && all.includes(String(x.raw.songmid))))
      if (i < 0 || String(sessionQueue[i].cover || '') === pic) return
      const q = sessionQueue.slice()
      q[i] = { ...q[i], cover: pic, raw: { ...(q[i].raw || {}), img: pic } }
      sessionQueue = q
      setQueue(q)
      /** ★ v6：真图同时写回曲库池，重复刷到这首歌不再重走一遍空窗。 */
      void backfillCover(id, pic, keys)
    }
    ev.on('picUpdated', onPic)
    return () => { if (typeof ev.off === 'function') ev.off('picUpdated', onPic) }
  }, [])

  /** ★ 七期①：固定引用；★ 十一期回弹调硬，跟手感更好。 */
  const reset = useCallback(() => {
    Animated.parallel([
      Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false, friction: 11 }),
      Animated.timing(opacity, { toValue: 1, duration: 90, useNativeDriver: false }),
    ]).start()
  }, [pan, opacity])

  /**
   * ★ 本轮：滑速微降 130→150ms / tension 110→100（只降一点点，不动结构）。
   * ★ 连滑关键：播放触发从「滑出动画回调」移到松手即时。
   *   旧版第二次手势被 locked 吞掉；若只放开手势、让 grant 打断动画，
   *   Animated 的回调会被一并取消 → 画面切了歌、声音没切。
   *   现在动画纯视觉，随时可被打断；播放只调既有 onPlay，取链六步一字未动。
   */
  const flip = useCallback((dir: 1 | -1, target: SheetTrack | null) => {
    const outY = dir === 1 ? -height : height
    const inY = dir === 1 ? height : -height
    if (lockTimer.current) clearTimeout(lockTimer.current)
    if (target) onPlayRef.current(target)
    /** 兜底解锁：动画回调被系统吞掉时仍能恢复（十期 P0-10） */
    lockTimer.current = setTimeout(() => {
      if (!aliveRef.current) return
      locked.current = false
      pan.setValue({ x: 0, y: 0 })
      opacity.setValue(1)
    }, 420)
    Animated.timing(pan, { toValue: { x: 0, y: outY }, duration: 150, useNativeDriver: false }).start(() => {
      if (!aliveRef.current) return               // ★ 已切页：不复位、不解锁
      pan.setValue({ x: 0, y: inY })
      opacity.setValue(0.85)
      Animated.parallel([
        Animated.spring(pan, { toValue: { x: 0, y: 0 }, friction: 12, tension: 100, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: false }),
      ]).start(() => {
        if (aliveRef.current) locked.current = false
        if (lockTimer.current) { clearTimeout(lockTimer.current); lockTimer.current = null }
      })
    })
  }, [height, pan, opacity])

  const next = useCallback((play = true) => {
    const nx = queue[idx + 1]
    if (!nx) { reset(); return }
    locked.current = true
    /** ★ 五期②：先同步写模块级 sessionIdx，再发起补货与动画，避免画面跳回上一首。 */
    const ni = idx + 1
    sessionIdx = ni
    setIdx(ni)
    prefetchAhead(queue, ni)                    // ★ D-2 A：切到新首曲即预取再下一首
    /**
     * ★ 十一期深度自查：队列剩 2 首时提前触发 append（内部 await autoRestock + gc）。
     *   append 要等补货完成才选题，期间用户继续滑会连续命中这个条件 →
     *   旧版每滑一首就排一次补货+搜索。加一次性标志，队列真正补长前只触发一次。
     */
    if (idx + 2 >= queue.length && !appendingRef.current) {
      appendingRef.current = true
      void fill(mode, true).then(
        () => { appendingRef.current = false },
        () => { appendingRef.current = false },
      )
    }
    flip(1, play ? nx : null)
  }, [queue, idx, mode, fill, flip, reset])

  /** 下滑前一首：只回退队列内已有的歌，不重建前序、不取新源、不算「重复出现」。 */
  const prev = useCallback((play = true) => {
    if (idx <= 0) { reset(); return }
    locked.current = true
    const pv = queue[idx - 1]
    const ni = idx - 1
    sessionIdx = ni
    setIdx(ni)
    flip(-1, play ? pv : null)
  }, [queue, idx, flip, reset])

  /** ★ 十一期：id 口径已在 upstream 修好，这里 toggle 返回布尔即可真的取消。 */
  const like = async() => {
    if (!cur) return
    setFav(await toggleFavorite(cur as any))
  }

  /**
   * ★ 十一期：缓存按钮改 toggle。
   *   已缓存 → removeCached() + 提示「已取消缓存本地」+ 按钮回 ↓；
   *   未缓存 → cacheLocal() + 绿 ✓ + 顶部横幅 + 计数。removeCached 已收进写锁。
   */
  const doCache = async() => {
    if (!cur || cachingRef.current) return
    /**
     * ★ 十一期深度自查 P0-3：连点两下时 cached 还是 false（state 未落地），
     *   两次 cacheLocal 并发下载同一路径、重复写文件。用一次性标志锁住整段操作，
     *   并固定本次操作的曲目 id，异步返回后校验仍是当前歌才改按钮状态。
     */
    const id = cur.id
    const title = cur.title
    cachingRef.current = true
    setMsg('')
    try {
      const wasCached = await isCached(id).catch(() => cached)
      if (wasCached) {
        await removeCached(id)
        if (String(sessionQueue[sessionIdx]?.id ?? '') === id) { setCached(false); setCacheOk(false) }
        showMsg('已取消缓存本地 · ' + (title || ''))
        return
      }
      const before = (await listCached().catch(() => [] as any[])).length
      await cacheLocal(cur as any)
      const after = (await listCached().catch(() => [] as any[])).length
      if (String(sessionQueue[sessionIdx]?.id ?? '') !== id) return   // 已切歌，不改当前首状态
      setCached(true)
      setCacheFrom(before); setCacheTo(after); setCacheNote('已缓存本地')
      setCacheOk(true)
      toastFade.setValue(0)
      Animated.timing(toastFade, { toValue: 1, duration: 180, useNativeDriver: false }).start()
      if (cacheTimer.current) clearTimeout(cacheTimer.current)
      cacheTimer.current = setTimeout(() => {
        Animated.timing(toastFade, { toValue: 0, duration: 220, useNativeDriver: false }).start(() => {
          if (aliveRef.current) setCacheOk(false)
        })
      }, 2600)
    } catch (e: any) { showMsg('缓存本地失败：' + String(e?.message || e)) }
    finally { cachingRef.current = false }
  }

  /**
   * ★ 本轮：连滑跟不上的真因是 onMoveShouldSetPanResponder 里 `!locked.current` ——
   *   入场动画没结束前第二次手势根本不夺取，手指在动、界面完全不跟。
   *   现在手势永远可夺取；grant 时打断进行中的滑出/入场动画并解锁，
   *   从当前位移直接接管（播放已在松手时触发，不会被打断）。
   *   夺取 4→5px、触发 0.10→0.11：席卷速度只微降一点点。
   */
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    /** ★ 全项目重审 E：旧版 |dx|>5 也夺取手势，而 release 里要 |dx|>0.22*width
     *  才切歌 —— 于是「横抖一下」既夺走按钮的 onPress、又不切歌，按钮偶发失灵。
     *  改为只认纵向主导（|dy|>|5| 且 |dy|>=|dx|），横向完全归还给控件。 */
    onMoveShouldSetPanResponder: (_, g) =>
      Math.abs(g.dy) > 5 && Math.abs(g.dy) >= Math.abs(g.dx),
    onPanResponderGrant: (_, g) => {
      pan.stopAnimation(); opacity.stopAnimation()
      if (lockTimer.current) { clearTimeout(lockTimer.current); lockTimer.current = null }
      locked.current = false
      pan.setValue({ x: 0, y: g.dy })
      opacity.setValue(Math.max(0.55, 1 - Math.abs(g.dy) / (height * 1.6)))
    },
    onPanResponderMove: (_, g) => {
      pan.setValue({ x: 0, y: g.dy })
      opacity.setValue(Math.max(0.55, 1 - Math.abs(g.dy) / (height * 1.6)))
    },
    onPanResponderRelease: (_, g) => {
      const TH = height * 0.11
      if (g.dy < -TH) next(true)
      else if (g.dy > TH) prev(true)
      else if (g.dx < -width * 0.22 || g.dx > width * 0.22) next(true)
      else reset()
    },
  }), [next, prev, width, height, pan, opacity, reset])

  /** ★ F-15①：竖版大封面 ≈88% 屏宽（受屏高约束），给底部控件留位。 */
  const coverW = Math.min(width * 0.86, height * 0.34)
  const coverH = coverW * 1.22
  return (
    <View style={s.root}>
      {/* ★ 本轮：背景由主壳 root 层铺「当前曲目封面」，状态栏/Tab/内容全屏同色，
          本页彻底透明，不再自铺一层 → 两段式色带消失，颜色也必然来自封面。 */}
      {/* 整屏滑入滑出：封面 + 歌名 + 歌词 + 三圆钮 + 进度 + 大播放钮 同一块 */}
      <Animated.View {...panResponder.panHandlers}
        style={[s.screen, { transform: pan.getTranslateTransform(), opacity }]}>
        <View style={s.stage}>
          <Animated.View style={{ transform: [{ scale: breath }], opacity: coverFade }}>
            <Cover uri={heldCover || cur?.cover} title={cur?.title || '暂无曲目'} artist={cur?.artist}
              size={coverW} radius={20} t={t}
              style={[s.cover, { width: coverW, height: coverH }]} />
          </Animated.View>
          {/* ★ F-15②：无容器大字 2 行同步歌词，当前行高亮，整页主视觉 */}
          <View style={s.lyricWrap}>
            <LyricLines position={player.position} trackId={cur?.id}
              playing={player.playing} variant="plain" />
          </View>
        </View>

        {/* ★ F-15③：歌名 / 歌手沉到底部，层级与歌词对调 */}
        <View style={s.meta}>
          <Text style={s.title} numberOfLines={1}>{cur?.title || '暂无曲目'}</Text>
          <Text style={s.artist} numberOfLines={1}>{cur ? (cur.artist || '未知歌手') : '曲库正在自动补货'}</Text>
        </View>

        {/* 三圆钮：喜欢 / 缓存（toggle）/ 档位 */}
        <View style={s.actions}>
          <TouchableOpacity style={s.circleBtn} onPress={() => void like()}>
            <Text style={[s.circleIco, { color: fav ? t.red : '#E6E9F5' }]}>{fav ? '♥' : '♡'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.circleBtn, cached && s.circleBtnOk]} onPress={() => void doCache()}>
            <Text style={[s.circleIco, cached && s.circleIcoOk]}>{cached ? '✓' : '↓'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.circleBtn} onPress={() => { setModeToast(''); setModeOpen(true) }}><Text style={s.circleIco}>☰</Text></TouchableOpacity>
        </View>
        <View style={s.labels}>
          {['喜欢', cached ? '已缓存' : '缓存', '档位'].map(x => <Text key={x} style={s.label}>{x}</Text>)}
        </View>

        {/* 进度（★ 本轮：改成独立 memo 可拖组件，原来只是只读百分比条） + 大暂停 */}
        <View style={s.progressRow}>
          <SeekBar compact position={player.position}
            duration={player.duration || cur?.duration || 0} onSeek={onSeek}
            trackKey={cur?.id || ''} playing={player.playing} />
          <TouchableOpacity style={s.bigPlay} onPress={() => {
            if (player.track) onToggle()
            else if (cur) onPlay(cur)
          }}>
            <Text style={s.bigPlayTxt}>{player.playing ? '❚❚' : '▶'}</Text>
          </TouchableOpacity>
        </View>
        {/* ★ 十一期：底部「上下滑换歌 · 不自动无限续播」文字已删除，仅留安全区 */}
      </Animated.View>

      {cacheOk ? (
        <Animated.View style={[s.toast, { opacity: toastFade }]} pointerEvents="none">
          <View style={s.toastTick}><Text style={s.toastTickTxt}>✓</Text></View>
          <Text style={s.toastTxt} numberOfLines={1}>{cacheNote} · {cur?.title || ''}</Text>
          <Text style={s.toastCount}>{cacheFrom} → {cacheTo} 首</Text>
        </Animated.View>
      ) : null}
      {msg ? (
        <View style={s.msg} pointerEvents="none"><Text style={s.msgTxt}>{msg}</Text></View>
      ) : null}

      {/* 档位浮层：★ 十一期删掉「播放页 / 歌词」按钮，只留 4 档 + 真换一批 */}
      <Sheet visible={modeOpen} title="选择档位" badge="4 档 · 同一曲库"
        subtitle="只调权重，不重载音源、不打断播放" onClose={closeModeSheet} t={t}
        toast={modeToast || undefined}>
        <View style={s.chips}>
          {MODES.map(m => (
            <Chip key={m.key} label={m.label} on={mode === m.key} t={t}
              onPress={() => {
                /** v29：选档位有时零反馈 —— Sheet 是原生 Modal，点完立刻关浮层
                 *  却把反馈写到底层页 msg，退场期间整窗盖住，时有时无。
                 *  v29 改为「不立刻关 + 反馈走 <Sheet toast>」，选中态也看得见。
                 *  ★ v30 / M：v29 直接把 <Sheet toast> 绑到共享 msg，而 msg 被
                 *  fill 链补货提示、[cur?.id] 切歌清 msg、缓存按钮等 8 处写入竞争，
                 *  2.6 秒定时器到期前就被清空/覆盖 → 提示「一闪而过」。
                 *  现改走独立 modeToast（自带定时器 + 关闭/卸载清理），彻底隔离。
                 *  底层 msg 悬浮条仍负责缓存 / 错误 / 后台补货等业务提示，互不影响。 */
                /** ★ v36：再点同一档位原来只弹「当前档位」—— 同值 setMode 触发
                 *  React bail out，effect 不跑、队列一首不动，用户以为 DJ 档坏了。
                 *  同档点击改成「再换一批」：必须同时置 forceFill + rev，
                 *  只置 rev 会撞上 doFillRef 的 m === sessionMode 短路，仍一首不换。 */
                if (mode === m.key) {
                  forceFill = true
                  sessionRev += 1; setRev(sessionRev)
                  showModeToast('再换一批 · ' + m.label)
                } else {
                  setMode(m.key)                 // 异档仍走原有切档分支，行为不变
                  showModeToast('已切换到 · ' + m.label)
                }
              }} />
          ))}
        </View>
        {/* ★ v35：纯展示预览，让「换了」看得见；读 queue 派生值，
             无新 state / 新组件 / 新定时器。 */}
        <Text style={s.preview} numberOfLines={1}>
          接下来：{!queue.length ? '曲库补货中'
            : (queue.slice(idx + 1, idx + 4).map(x => x.title).filter(Boolean).join(' / ')
              || (idx + 1 >= queue.length ? '已到队尾 · 继续下滑加载' : '暂无歌名'))}
        </Text>
        <SheetButton t={t} label="换一批" onPress={() => {
          forceFill = true
          sessionRev += 1; setRev(sessionRev)
          /** ★ v35：点击瞬间就在浮层内给反馈，且不再立刻关浮层 —— 旧版
           *  closeModeSheet() 会清掉 toast，真反馈要等 fill 排队完才写底层 msg，
           *  中间全空白 + Modal 退场遮盖 = 点了不知道有没有换成功。 */
          showModeToast('正在换一批…')
        }} />
        <View style={{ height: 18 }} />
      </Sheet>
    </View>
  )
}

const makeStyles = (t: Tokens) => StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent', overflow: 'hidden' },
  screen: { flex: 1, paddingHorizontal: 20, paddingBottom: 24 },
  /* ★ 十一期：msg 改悬浮条（原来是一行小字 + 可点 Touchable，会吃手势） */
  msg: { position: 'absolute', top: 8, left: 20, right: 20, zIndex: 30,
    backgroundColor: 'rgba(109,94,252,0.94)', borderRadius: 12,
    paddingVertical: 9, paddingHorizontal: 14 },
  msgTxt: { color: '#FFF', fontSize: 12, textAlign: 'center' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cover: { shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, elevation: 10 },
  meta: { alignItems: 'center', marginBottom: 8 },
  title: { color: '#FFF', fontSize: 19, fontWeight: '700', textAlign: 'center' },
  artist: { color: 'rgba(255,255,255,.70)', fontSize: 12.5, marginTop: 5, textAlign: 'center' },
  /* ★ F-15②：歌词不再包灰底盒，直接落在单色背景上 */
  lyricWrap: { marginTop: 22, alignSelf: 'stretch', marginHorizontal: 6 },
  actions: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 14 },
  circleBtn: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)' },
  circleIco: { color: '#E6E9F5', fontSize: 23 },
  circleBtnOk: { backgroundColor: '#2FB37A', borderColor: '#2FB37A',
    shadowColor: '#2FB37A', shadowOpacity: 0.36, shadowRadius: 12, elevation: 5 },
  circleIcoOk: { color: '#FFF', fontSize: 23, fontWeight: '800' },
  toast: { position: 'absolute', top: 8, left: 20, right: 20, zIndex: 31,
    flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 11, paddingHorizontal: 14,
    borderRadius: 999, backgroundColor: '#1E8F63',
    shadowColor: '#125E42', shadowOpacity: 0.38, shadowRadius: 16, elevation: 8 },
  toastTick: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.24)',
    alignItems: 'center', justifyContent: 'center' },
  toastTickTxt: { color: '#FFF', fontSize: 12, fontWeight: '800' },
  toastTxt: { flex: 1, color: '#FFF', fontSize: 13, fontWeight: '700' },
  toastCount: { color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: '700' },
  labels: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 9 },
  label: { color: 'rgba(255,255,255,.72)', fontSize: 11, width: 78, textAlign: 'center' },
  /* ★ 十一期：进度行下移贴底 */
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20 },
  bigPlay: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#FFF',
    alignItems: 'center', justifyContent: 'center', marginLeft: 4 },
  bigPlayTxt: { color: '#15182C', fontSize: 21, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 },
  preview: { color: t.sub, fontSize: 12, textAlign: 'center', marginBottom: 12 },
})
