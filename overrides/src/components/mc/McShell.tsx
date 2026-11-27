/**
 * 主壳 —— 刷歌/推荐/我的 三页 Tab + 月亮 + 白色 mini 条（顶栏全删）。
 *
 * ★ P2「彻底去除洛雪原版 UI」：运行时不再渲染原装首页内容、不再提供原装入口。
 *   RNN 只注册 Home（已被本壳接管）/ PlayDetail / SonglistDetail / Comment / 三个 Modal，
 *   用户全程看不到原版界面。替代入口全部在本壳内：
 *     · 自定义音源勾选 →「我的」页最底部极淡小字连点 5 次（最后退路）
 *     · 歌词 → F-14 全屏单曲页常驻（自绘，不再用原装 Lyric / Secondary FullModal）
 *   物理删除文件 / 改导航注册要动 src/app.ts（uiDeny）与 init 主链，风险最高、收益为零，
 *   本轮不做 —— 因此**零破封**。`original` 只保留参数签名兼容 GateHost，绝不渲染。
 *
 * 主链路边界：播放只调原装公开 API；展示只读原装 playerState / TrackPlayer。
 * 不起第二套播放器、不自建播放状态机、不拦 RNN 路由、不建第二套取源心跳。
 */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, StatusBar, Platform, Image, AppState } from 'react-native'
import { DARK, initThemeMode, useTheme, type Tokens } from '@/theme/mc'
import playerState from '@/store/player/state'
import { playNext } from '@/core/player/player'
import TrackPlayer, { RepeatMode } from 'react-native-track-player'
import { MiniBar, TabBar, coverUriOf, type SheetTrack, type TabKey } from './UI'
import FullPlayer from './FullPlayer'
import ErrorBoundary from './ErrorBoundary'
import { cacheLocal, isCached, removeCached } from './localCache'
import { usePlayer } from './usePlayer'
import { sourceReady } from './autoSource'
import * as playQueue from './playQueue'
import { bootstrap, autoRestock, touch, backfillCover, ROTATE_MS, rotateBatch } from './catalog'
import {
  doPause, doResume, isFavorite, playTrack, playBatch as playBatchUpstream,
  clearBatch, seekToRatio, toggleFavorite, type MCTrack,
} from './upstream'
import RecoScreen from '@/screens/mc-ui/RecoScreen'
import SwipeScreen from '@/screens/mc-ui/SwipeScreen'
import MineScreen from '@/screens/mc-ui/MineScreen'
/* ★ v32 / P：模块顶层副作用 —— bundle 求值期就订阅 list_changed，早于 core/init 的
   setUserApiList / setApiSource，永久压制音源「发现新版本」弹窗（服务端重导也不复活）。
   ESM 只求值一次，幂等；upstream / mc-center / 取链六步一字不动。 */
import './sourceUpdateGuard'
import { resetVolumeIfNeeded } from './volumeGuard'

const toMCTrack = (tr: SheetTrack): MCTrack => ({
  id: tr.id,
  title: tr.title,
  artist: tr.artist || '',
  album: tr.album || '',
  duration: Number(tr.duration || 0),
  source: String(tr.raw?.source ?? ''),
  songmid: String(tr.raw?.songmid ?? tr.id),
  cover: tr.cover || '',
  localPath: tr.localPath,                     // ★ 缓存本地条目跳过在线取链
  raw: tr.raw,
})

function Shell({ original }: { original: ReactNode }) {
  // `original` 保留仅为兼容 GateHost 签名；本版运行时彻底不渲染原装 UI。
  void original
  const { t, toggle, mode } = useTheme()
  const player = usePlayer()
  const s = useMemo(() => styles(t), [t])
  const [tab, setTab] = useState<TabKey>('reco')
  const [fullOpen, setFullOpen] = useState(false)
  const [cached, setCached] = useState(false)
  const [ready, setReady] = useState<boolean | null>(null)
  const [err, setErr] = useState('')
  const [fav, setFav] = useState(false)
  const [tick, setTick] = useState(0)
  /** ★ D-2 A：每次「从别的页切进刷歌」递增一次，驱动 SwipeScreen 整批换池 + 开播。
   *  模块级队列不丢，但切回来会重新取一批新的歌（不再原样恢复）。 */
  const [swipeEnter, setSwipeEnter] = useState(0)
  /** ★ K：顺序播放 / 单曲循环两态。用原装 TrackPlayer 的原生 RepeatMode，
   *  v19 复核定稿：不订阅 app_event.playerEnded（那是取链空窗信号，不是播完），
   *  不建定时器、不双订阅、不碰主链六步。setLoop(true) 语义是反的，直调 setRepeatMode。 */
  const [playMode, setPlayMode] = useState<'order' | 'loop'>('order')
  /** ★ v24 深度自查 D：并发切歌时，旧请求被 playTrack 的 playSeq 判 stale 返回 false。
   *  playSwipe 原来只判 !ok 就 doResume() → 把【上一首旧歌】恢复播放，
   *  而画面已经切到最新那首，正是 D-1 想消灭的音画错配。
   *  这里用模块内序号让只有「最新一笔」能执行兜底与队列写入。 */
  const playSeqRef = useRef(0)
  const playModeRef = useRef<'order' | 'loop'>('order')
  playModeRef.current = playMode
  /**
   * ★ v25 全量审查（实证缺陷②）：RepeatMode 串行链。
   *   旧版 applyMode / forceRepeatOff 都是 `void setRepeatMode().catch()`，
   *   两次原生调用并发时 JS 层无法保证生效顺序。场景「全屏页点单曲循环(Track)
   *   → 立刻切进刷歌(Off)」若 Track 晚生效，刷歌页会单曲循环、滑歌串音。
   *   串行链保证【后发的一定后生效】，终态 = 最后一次用户意图；每个入口仍排队，
   *   失败被吞后下一笔仍会重设。不建定时器、不订阅事件、不碰主链六步。
   *   不做去重：去重会让「原生被别处改了」无法被下一笔纠正。
   */
  const modeChainRef = useRef<Promise<void>>(Promise.resolve())
  const setRepeat = (m: 'Track' | 'Off'): void => {
    modeChainRef.current = modeChainRef.current
      .then(() => TrackPlayer.setRepeatMode(m === 'Track' ? RepeatMode.Track : RepeatMode.Off))
      .catch(() => {})
  }
  const applyMode = () => setRepeat(playModeRef.current === 'loop' ? 'Track' : 'Off')
  const forceRepeatOff = () => setRepeat('Off')
  const onToggleMode = () => {
    const next: 'order' | 'loop' = playModeRef.current === 'order' ? 'loop' : 'order'
    playModeRef.current = next
    setPlayMode(next)
    applyMode()
  }
  /** ★ 深度自查 P0-①：渲染期同步当前 Tab，供 playSwipe 在异步取链落地后判定。 */
  const tabRef = useRef<TabKey>('reco')
  tabRef.current = tab
  /**
   * ★ v27 · 错误条三修（真机截图：推荐页常驻一条「换源失败」）
   *   ① 切页清：changeTab 调 clearErr()，切回推荐不再冒出刷歌页的旧错误。
   *   ② 自动消失：2.6s（与刷歌页 showMsg 同口径），不再只能靠手点或下次播放清。
   *   ③ 文案我方口径：原装 toggle_source_failed 让「去搜索页指定其他来源」，
   *      而我方定制 UI 没有原装音源切换器，照这句话做不到 —— 换成讲人话、
   *      且我方真能做到的提示；未知错误保留原文，不抹掉排障信息。
   *   另加「跨页迟到隔离」：errOwner 记录这笔播放属于哪个 Tab，异步取链失败
   *   落地时若当前 Tab 已不是它，就不写红条。这是 ① 能真正生效的关键，
   *   否则「刷歌失败 → 请求迟到 → 用户已在推荐页」仍会闪一条。
   */
  const errTimer = useRef<any>(null)
  const clearErr = () => {
    if (errTimer.current) { clearTimeout(errTimer.current); errTimer.current = null }
    setErr('')
  }
  useEffect(() => () => { if (errTimer.current) clearTimeout(errTimer.current) }, [])
  /** ★ v32 / R：设置页收成只剩自定义源后，原装音量滑块已无 UI 入口；
   *  若早期被拖小并持久化，用户调不回来。挂载时（init 已读完设置）复位一次，
   *  默认 1 时零写入、零事件、零播放器调用。 */
  useEffect(() => { resetVolumeIfNeeded() }, [])
  /**
   * ★ v36：单池 10 分钟换血。首个 10 分钟后才跑，冷启
   *   bootstrap → autoRestock → setTick 链路完全不变。
   *   后台不跑、回前台不补跑（省内网请求）；换血完成不弹提示、不 setTick，
   *   下一次用户切档 / 换一批 / 滑到队尾时 pickFresh 自然读到新池。
   *   catalog 内部自带串行排队，不会并发。
   */
  useEffect(() => {
    const id = setInterval(() => {
      /** RN 启动期 AppState.currentState 可能为 null（首个事件到达前）；
       *  null 视作可跑，别把首个 10 分钟轮白跳过。 */
      if (AppState.currentState && AppState.currentState !== 'active') return
      void rotateBatch()
    }, ROTATE_MS)
    return () => clearInterval(id)
  }, [])
  const FRIENDLY_SOURCE_ERR = '这首暂时没找到可播音源，换一首试试'
  const friendlyErr = (e: any): string => {
    const m = String(e?.message || e || '')
    return /换源失败|指定其他来源|變更來源失敗|变更来源失败|Failed to change the source|音源未返回可播直链/.test(m)
      ? FRIENDLY_SOURCE_ERR
      : m
  }
  const showErr = (e: any, errOwner: TabKey) => {
    if (tabRef.current !== errOwner) return
    if (errTimer.current) clearTimeout(errTimer.current)
    setErr(friendlyErr(e))
    errTimer.current = setTimeout(() => { errTimer.current = null; setErr('') }, 2600)
  }
  /**
   * ★ 深度自查 P0-A：「刷歌已接管、但 swap 新歌尚未落地」的窗口。
   *   置起 = changeTab 切进刷歌；清除 = playSwipe 落地 / 切走刷歌。
   *   用于让 reco/mine 的在途播放落地后补一次暂停，避免两首叠着响。
   *   用 ref 而非 tabRef：落地可能发生在 React 重渲染之前，tabRef 会滞后。
   */
  const swipeTakeoverRef = useRef(false)
  /** 原装 setPause 在 Stopped 态可能 reject；统一吞掉，不产生未捕获 Promise。 */
  const safePause = () => { void Promise.resolve().then(() => doPause()).catch(() => {}) }
  /** ★ 深度自查 P1-③：刷歌页上报「当前展示曲目」的封面，背景不滞后一首。 */
  const [swipeCoverOverride, setSwipeCoverOverride] = useState('')
  const onSwipeCover = React.useCallback((c: string) => setSwipeCoverOverride(c), [])
  /** ★ 十期 P0-3：刷歌页底色固定深色，点月亮需给可见反馈，否则用户以为没生效。 */
  const [themeHint, setThemeHint] = useState('')
  const themeHintTimer = useRef<any>(null)
  useEffect(() => () => { if (themeHintTimer.current) clearTimeout(themeHintTimer.current) }, [])
  const onToggleTheme = () => {
    void toggle()
    if (tab !== 'swipe') return
    setThemeHint('已切换主题 · 刷歌页保持深色，推荐 / 我的已更新')
    if (themeHintTimer.current) clearTimeout(themeHintTimer.current)
    themeHintTimer.current = setTimeout(() => setThemeHint(''), 2200)
  }

  useEffect(() => {
    void initThemeMode()
    /**
     * ★ 五期自查③（冷启空白）：推荐页默认先挂载，那时 bootstrap 还在异步灌池，
     *   pick() 拿到空数组 → 曲库列表空、卡片全是几何封面，且 refreshTick 不变就再也不重算。
     *   刷歌页此前已有 await bootstrap 兜底，推荐页/我的页没有。灌池完成后 tick 一次，
     *   让三页统一重取（内容未变时只是本地选题，零网络、零副作用）。
     */
    void bootstrap().then(() => {
      setTick(v => v + 1)
      // ★ 十一期「自动补货 + 自动清旧」：冷启灌到 120 能立刻开刷后，
      //   在后台渐进补到 400（每段 restock 内部跑 gc），完成后再 tick 一次刷新三页。
      //   不阻塞启动、不建定时器；与刷歌页队列见底的触发点共用 restocking 锁。
      void autoRestock().then(() => setTick(v => v + 1))
    })
  }, [])

  useEffect(() => {
    let alive = true
    const check = async() => { const r = await sourceReady(); if (alive) setReady(r) }
    void check()
    const ev: any = (global as any).state_event
    const onSrc = () => { void check() }
    if (ev && typeof ev.on === 'function') ev.on('apiSourceUpdated', onSrc)
    return () => { alive = false; if (ev && typeof ev.off === 'function') ev.off('apiSourceUpdated', onSrc) }
  }, [tick])

  useEffect(() => { setFav(player.track ? isFavorite(player.track as any) : false) }, [player.track?.id])

  /**
   * ★ 九期（封面修复⑤）：原装 getPicPath 异步拿到真实封面后，fillMeta 会 emit
   *   picUpdated。这里读 playerState 回填曲库 —— McShell 本来就 import catalog，
   *   不新增循环依赖、不碰 fillMeta、不碰播放链路。播一首补一首。
   */
  useEffect(() => {
    const ev: any = (global as any).app_event
    if (!ev || typeof ev.on !== 'function') return
    const onPic = () => {
      const mi: any = (playerState as any).playMusicInfo?.musicInfo
      const id = String(mi?.id ?? '')
      const pic = String((playerState as any).musicInfo?.pic ?? '')
      // ★ 十期 P0-4：补传 meta.songId / songmid，让回填按多口径反查曲库
      const alt = [String(mi?.meta?.songId ?? ''), String(mi?.songmid ?? '')].filter(Boolean)
      if (id && pic) void backfillCover(id, pic, alt)
    }
    ev.on('picUpdated', onPic)
    return () => { if (typeof ev.off === 'function') ev.off('picUpdated', onPic) }
  }, [])

  type PlayResult = { ok: boolean, latest: boolean }
  const play = async(tr: SheetTrack, modeOff = false, errOwner: TabKey = 'reco'): Promise<PlayResult> => {
    const seq = ++playSeqRef.current
    clearErr()
    /** ★ K / v19 硬坑②：RepeatMode 是全局状态，切页不复位会污染刷歌。
     *  ★ v24 修复 E：刷歌路径必须跳过 applyMode —— changeTab 刚 forceRepeatOff()，
     *    若这里再按 playMode='loop' 设回 Track，刷歌页就会单曲循环、滑歌串音。 */
    if (modeOff) forceRepeatOff()
    else applyMode()
    // ★ 十一期硬约束④：所有单曲播放入口先清批次队列，
    //   否则装过一批后去刷歌切歌，播完那首会被原装 playNext 接管去播残留队列 → 串台。
    clearBatch()
    try {
      // ★ 八期②：playTrack 返回「这次请求是否真正落地」。快滑时被更新的切歌抢先，
      //   旧请求会安静返回 false —— 那首歌不该算「听过」，否则「熟悉 / 尝鲜」
      //   两档的 uses 会记到根本没播的歌上。
      const ok = await playTrack(toMCTrack(tr))
      const latest = seq === playSeqRef.current
      // ★ P0 修 4 档死档：以前 touch() 全项目零调用 → uses 恒 0 →
      //   「熟悉 / 尝鲜」两档权重恒为 0，退化成均衡。现在播放成功即计数。
      if (ok && !tr.localPath) void touch(tr.id)
      /** ★ H + v24：只有最新一笔才能写队列状态。
       *  stale 的旧请求既不 record 也不 restore，避免把 cursor 改到别处。 */
      if (latest) {
        if (ok) playQueue.record(tr)
        else playQueue.restore()
      }
      return { ok, latest }
    } catch (e: any) {
      const latest = seq === playSeqRef.current
      /** ★ v24：被抢占的旧请求连错误条都不该写，否则刷出一笔过期错误。
       *  ★ v27：再叠一层来源 Tab 隔离 + 我方文案 + 自动消失。 */
      if (latest) { showErr(e, errOwner); playQueue.restore() }
      return { ok: false, latest }
    }
  }

  /**
   * ★ 深度自查 P0-①：刷歌专用播放入口。
   *   播放已从「滑出动画回调」移到松手即时（连滑跟手需要），于是九期那条
   *   `if (!aliveRef.current) return` 守卫失效：用户滑一下立刻切 Tab，
   *   playTrack 仍在进行、changeTab 的 doPause 只看 player.playing（此时旧值），
   *   取链落地后 setPlay → 在推荐页突然播下一首，违背「切走就停」。
   *   这里在播放落地后读 tabRef：已离开刷歌页就补一次 doPause。
   *   只调原装公开 API，不动 playTrack / 取链六步。
   */
  const playSwipe = async(tr: SheetTrack) => {
    /** ★ D-1 A：松手先停旧歌，消灭「画面已经是 B、声音还是 A」的错配。
     *  只调既有 safePause（吞 reject），不碰 playTrack / 取链六步；
     *  新歌落地 setPlay() 自然恢复。取链失败则恢复旧歌，不留静音（D-4 A）。 */
    safePause()
    /** ★ v27：来源标成 swipe，取链失败迟到也不在推荐页写红条。 */
    const { ok, latest } = await play(tr, true, 'swipe')   // ★ E：刷歌路径强制 RepeatMode.Off
    /** ★ v24 修复 D：被更新的切歌抢占的旧请求，不做任何兜底 —— 它若 doResume()
     *  会把上一首旧歌恢复，而画面已是最新那首。最新那笔自己会管出声/恢复。 */
    if (!latest) return
    /** 新歌已落地 → 接管窗口结束，旧歌再落地不再补暂停（且已被 playSeq 拦住）。 */
    swipeTakeoverRef.current = false
    if (tabRef.current !== 'swipe') safePause()
    else if (!ok) void doResume().catch(() => {})
  }

  /**
   * ★ 深度自查 P0-A：推荐 / 我的页专用播放入口。
   *   只比原 play 多一层「落地时若已切进刷歌且新歌还没落地 → 补暂停」。
   *   不碰 playTrack / 取链六步；在推荐页点歌后切到「我的」不受影响（标记已清）。
   */
  const playOther = async(tr: SheetTrack) => {
    await play(tr, false, tabRef.current)
    if (swipeTakeoverRef.current) safePause()
  }

  /** ★ 十一期：卡片 ▶ / 浮层「播放全部」→ 原装 tempPlayList 逐首续播。
   *   同样补一层接管守卫：批次首曲在途时切进刷歌，落地后不串音。 */
  const playBatchOther = (tracks: SheetTrack[], shuffle: boolean) => {
    clearErr()
    const errOwner = tabRef.current          // ★ v27：捕获发起时的 Tab，异步失败不串页
    applyMode()                              // ★ K：批次入口同样按模式复位
    void playBatchUpstream(tracks.map(toMCTrack), shuffle)
      .then(() => { if (swipeTakeoverRef.current) safePause() })
      .catch(e => showErr(e, errOwner))
  }
  const onToggle = () => { if (player.playing) safePause(); else void doResume() }
  const onSeek = (r: number) => { void seekToRatio(r).catch(() => {}) }
  /** ★ H：mini 条 / 全屏页共用切歌分流。批次态下一首走原装 playNext 消费
   *   tempPlayList；单曲态走 playQueue 会话历史。 */
  const psMini: any = playerState as any
  /** ★ H / v20 坑1：批次态走原装队列（绝不能调 play() → 里面 clearBatch() 会
   *   清掉整批「稍后播放」）；单曲态走 playQueue 的一份会话历史。
   *  ★ 收尾修正（真 bug）：playBatch 里 setPlayListId(null)，而原装 playPrev 首句
   *    `if (!currentListId) return handleToggleStop()` —— 批次态调 playPrev 会【停播】。
   *    所以批次态上一首一律置灰、直接 return；只有单曲态才由 playQueue 提供上一首。 */
  const inBatchMini = !!(psMini.tempPlayList?.length) || !!psMini.playInfo?.playerListId
  const canNextMini = inBatchMini ? true : playQueue.canNext()
  const canPrevMini = inBatchMini ? false : playQueue.canPrev()
  const onNext = () => {
    if (inBatchMini) { void playNext(); return }
    const nx = playQueue.stepNext()
    if (nx) void playOther(nx)
  }
  const onPrev = () => {
    if (inBatchMini) return                    // 批次态无上一首能力，置灰不冒险
    const pv = playQueue.stepPrev()
    if (pv) void playOther(pv)
  }
  /** K：队列抽屉点某首跳播（单曲态）。批次态由原装队列管理，抽屉只读。 */
  const onPick = (i: number) => {
    if (inBatchMini) return
    const tr = playQueue.jumpTo(i)
    if (tr) void playOther(tr)
  }
  const onFavorite = async() => { if (player.track) setFav(await toggleFavorite(player.track as any)) }
  /**
   * ★ F-14：删掉 NowPlayingSheet → 120ms → FullModal(歌词) 两级跳转。
   *   那个 120ms 定时器是 F-13 偶发闪退的头号嫌疑，单容器全屏页后整段竞态消失。
   *   全屏页的「缓存本地」做成真 toggle，与刷歌页共用私有目录实现。
   */
  useEffect(() => {
    let alive = true
    const tr = player.track
    if (!tr) { setCached(false); return }
    void isCached(tr.id).then(v => { if (alive) setCached(!!v) }).catch(() => {})
    return () => { alive = false }
  }, [player.track?.id])
  const onCache = async() => {
    const tr = player.track
    if (!tr) return
    try {
      if (await isCached(tr.id).catch(() => false)) {
        await removeCached(tr.id); setCached(false)
      } else {
        await cacheLocal(tr); setCached(true)
      }
    } catch (_) { /* 失败不改状态，下次点击可重试 */ }
  }

  const swipeT = DARK   // 刷歌页文字/图标仍用深色主题令牌（白字）
  /** ★ 九期：整屏一个底色，状态栏/Tab/内容连续。 */
  const screenT = tab === 'swipe' ? swipeT : t
  /**
   * ★ 本轮 F-15④：背景色改由「当前曲目封面」决定，且铺在主壳 root 层。
   *   旧实现 coverHue(歌名) 是字符串 hash 取预设调色板，一个像素都没读封面 →
   *   用户实测「橙封面配蓝底」。现在直接把封面图放大铺满 + 压暗罩，
   *   颜色必然来自封面；无封面才退回按标题取色。blurRadius 仅作增强，
   *   Android 个别版本不生效时也有压暗罩兜底，不会变成清晰大图糊背景。
   */
  const swipeCoverRaw = tab === 'swipe'
    ? (coverUriOf(swipeCoverOverride) || coverUriOf(player.track?.cover || ''))
    : ''
  /**
   * ★ v6 闪屏修复：切歌时 playTrack 会同步清空 musicInfo.pic，
   *   swipeCoverRaw 短暂变空 → 底图 + 压暗罩整块消失，只剩 root 深色，
   *   就是用户看到的「背景色闪一下」。hold 住上一帧有效封面，底图永不消失，
   *   真图到了自然换色（连续，不硬切）。root 底色也改固定 DARK.bg，
   *   不再按歌名 hash 取色，消掉另一路切歌变色。
   */
  const [lastSwipeCover, setLastSwipeCover] = useState('')
  useEffect(() => { if (swipeCoverRaw) setLastSwipeCover(swipeCoverRaw) }, [swipeCoverRaw])
  const swipeCover = swipeCoverRaw || lastSwipeCover

  /**
   * ★ 切页入口（本轮 D-1 A / D-2 A，双方向都管）：
   *   · 刷歌 → 推荐/我的：切走就停（三期拍板，原样保留）。
   *   · 推荐/我的 → 刷歌：先暂停那边正在播的歌（避免两首叠着响），
   *     再递增 swipeEnter → SwipeScreen 整批换池并自动开播自己的首曲。
   *   ★ 这是对你早年「切回不自动续播」拍板的**明确回退**，v3 文档 D-1 A 已标出。
   *   只调原装 setPause / 既有 playSwipe，不碰取源链路、不清空播放器状态。
   *   ★ 时序边界（真机验）：doPause 是同步发起的 setPause，换池开播要经历
   *     waitSourceReady → 取链（通常 >100ms），正常不会把新歌误暂停；
   *     playSwipe 另有一层「落地后已离开刷歌页就补暂停」的守卫，两者不冲突。
   */
  const changeTab = (k: TabKey) => {
    /** ★ v27①：切页即清红条（连同自动消失定时器），旧失败不带到新页面。 */
    if (k !== tab) clearErr()
    if (tab === 'swipe' && k !== 'swipe') {
      if (player.playing) safePause()
      swipeTakeoverRef.current = false          // 切走刷歌：接管窗口结束
      applyMode()                              // ★ K：切回常规页恢复用户选的模式
    } else if (k === 'swipe' && tab !== 'swipe') {
      swipeTakeoverRef.current = true           // 标记先于 setTab，覆盖整段在途窗口
      safePause()
      forceRepeatOff()                         // ★ K：刷歌页不循环，强制 Off
      setSwipeEnter(v => v + 1)
    }
    setTab(k)
  }

  // ★ 三期拍板「顶栏全删」：字标条 / 刷新 / 菜单全部不渲染。
  //   原菜单功能已迁移：深浅色 → TabBar 月亮；歌词 → 全屏单曲页常驻；
  //   选源退路 → 我的页最底部极淡小字（连点 5 次），不再提供诊断入口。
  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0

  return (
    <View style={[s.root, { backgroundColor: tab === 'swipe' ? DARK.bg : screenT.bg }]}>
      {/* ★ 本轮：封面铺底在主壳层 → 状态栏 / TabBar / 内容区同一块底色，
          彻底消掉「顶部近黑 + 下面蓝紫」的两段式硬分界。 */}
      {tab === 'swipe' && swipeCover ? (
        <>
          <Image source={{ uri: swipeCover }} style={s.swipeBgImg}
            resizeMode="cover" blurRadius={26} pointerEvents="none" />
          <View style={s.swipeBgVeil} pointerEvents="none" />
        </>
      ) : null}
      {/* ★ 九期：状态栏半透明 + 与页面同色，不再单独一条 bg2 色带 */}
      <StatusBar translucent backgroundColor="transparent"
        barStyle={screenT.isDark ? 'light-content' : 'dark-content'} />
      {/* ★ 深度自查 P0-②：刷歌页这块必须透明，否则不透明 #12151F 会把
          铺在 root 层的封面底盖住 → 状态栏仍是一条黑带（两段式没修干净）。 */}
      <View style={{ height: topInset,
        backgroundColor: tab === 'swipe' ? 'transparent' : screenT.bg }} />
      <TabBar t={screenT} tab={tab} onChange={changeTab} dark={mode === 'dark'}
        onToggleTheme={onToggleTheme} />

      {/* ★ 十期二轮③：旧版是可点 Touchable，2.2 秒内在顶部会吃掉一次滑动手势。
          改纯展示 + pointerEvents none，手势完整穿透，到点自动消失。 */}
      {themeHint ? (
        <View style={[s.themeHint, { position: 'absolute', top: topInset + 54,
          left: 0, right: 0, zIndex: 30 }]} pointerEvents="none">
          <Text style={s.themeHintTxt}>{themeHint}</Text>
        </View>
      ) : null}
      {ready === false && tab !== 'swipe' ? (
        <TouchableOpacity style={s.status} onPress={() => changeTab('mine')} activeOpacity={0.85}>
          <Text style={s.statusTxt}>音源初始化中 / 未就绪 · 请稍候或检查中心连接</Text>
        </TouchableOpacity>
      ) : null}
      {/* ★ P2-H：刷歌页自身错误不经 McShell err（v27 再用 errOwner 做来源隔离）；
          ★ v27：2.6s 自动消失、切页即清、文案走我方口径、点一下也能关。 */}
      {err && tab !== 'swipe' ? (
        <TouchableOpacity style={s.errBar} onPress={clearErr}>
          <Text style={s.errTxt} numberOfLines={2}>{err}</Text>
        </TouchableOpacity>
      ) : null}

      <View style={s.body}>
        {tab === 'reco' && <RecoScreen t={t} player={player} onPlay={playOther}
          onPlayBatch={playBatchOther} refreshTick={tick} />}
        {tab === 'swipe' && <SwipeScreen t={swipeT} player={player} onPlay={playSwipe}
          onToggle={onToggle} onSeek={onSeek} onCoverChange={onSwipeCover}
          enterSeq={swipeEnter} refreshTick={tick} />}
        {tab === 'mine' && <MineScreen t={t} player={player} onPlay={playOther}
          refreshTick={tick} />}
      </View>

      {/* 白色 mini 播放条：刷歌页自带完整播放控制，不重复渲染 */}
      {tab !== 'swipe' ? (
        <MiniBar t={t} track={player.track} onPress={() => setFullOpen(true)}
          onToggle={onToggle} onPrev={onPrev} onNext={onNext}
          canPrev={canPrevMini} canNext={canNextMini}
          playing={player.playing} />
      ) : null}

      {/* F-14：单个绝对定位全屏播放页，歌词常驻；非抽屉、无二级弹窗、无 120ms 竞态。
          ★ 深度自查 P0-②：改条件挂载。旧版常驻挂载时隐藏态所有 hooks 仍执行，
          useLyricCursor 每秒随 position 重排 + setIdx 让整页函数体空跑，还挂后台
          timeout —— 刷歌页白背这部分 JS 开销。条件挂载后 fade / BackHandler /
          SeekBar 的渲染期 ref 同步写法均安全（v5 已修闭包锁首帧问题）。 */}
      {fullOpen ? (
        <FullPlayer visible={fullOpen} onClose={() => setFullOpen(false)} t={DARK}
          track={player.track} playing={player.playing}
          position={player.position} duration={player.duration}
          onToggle={onToggle} onSeek={onSeek} onFavorite={onFavorite}
          onPrev={onPrev} onNext={onNext} canPrev={canPrevMini} canNext={canNextMini}
          playMode={playMode} onToggleMode={onToggleMode} onPick={onPick}
          fav={fav} canSkip={tab !== 'swipe'} onCache={onCache} cached={cached} />
      ) : null}

    </View>
  )
}

const styles = (t: Tokens) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  /** ★ 全项目重审 G：与 FullPlayer.bgImg 统一，去掉 width/height。
   *  当前 root 无 padding 所以等价全屏，但保留该写法一旦将来加 padding 就复发图37 竖带。 */
  swipeBgImg: { ...StyleSheet.absoluteFillObject, opacity: 0.92 },
  swipeBgVeil: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,12,26,0.60)' },
  body: { flex: 1 },
  status: { backgroundColor: t.pill, paddingVertical: 7, paddingHorizontal: 14 },
  statusTxt: { color: t.warn, fontSize: 12 },
  errBar: { backgroundColor: 'rgba(255,90,122,0.14)', paddingVertical: 8, paddingHorizontal: 14 },
  errTxt: { color: t.red, fontSize: 13 },
  themeHint: { backgroundColor: 'rgba(109,94,252,0.94)', paddingVertical: 9, paddingHorizontal: 14 },
  themeHintTxt: { color: '#FFF', fontSize: 12, textAlign: 'center' },
})

/* F-13：错误边界包在主壳外层，渲染期异常不再直接闪退；全局兜底在 componentDidMount 安装。 */
export default (props: { original: ReactNode }) => (
  <ErrorBoundary><Shell {...props} /></ErrorBoundary>
)
