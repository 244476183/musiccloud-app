/**
 * F-14 全屏单曲播放页 —— 点 mini 条「一次」直达，非抽屉、非常驻二级弹窗。
 *
 * 结构：主壳根视图内的一层绝对定位全屏（**不用原生 Modal**），
 *   少一个 Modal 实例 → 彻底消灭「NowPlayingSheet → 120ms → FullModal(歌词)」双弹窗竞态
 *   （F-13 头号嫌疑）。歌词常驻，不用再点「♪ 歌词」。
 *
 * F-01：进度条真可拖。按住只改本地 dragR、不读播放器、不重绘整页；松手才 onSeek 一次。
 * F-02：⏮ / ⏭ 只放本页（刷歌页按 F-07 永不加）。直连原装 playPrev/playNext；
 *   ★ 三个坑全部防住：
 *     ① 批次末首手动 playNext 会被原装强制成 listLoop 回卷 → 无队列/无 listId 时置灰；
 *     ② 刷歌在播时 McShell 传 canSkip=false → 置灰，不绕过刷歌 sessionQueue；
 *     ③ 第一首且无 playedList 时 playPrev 会直接停播 → 置灰而非让它关掉音乐。
 * 歌词：D-1 A 自绘，只读 playerState.musicInfo.lrc（fillMeta 的 stillCurrent 已校验属于当前曲目），
 *   不渲染原装 Lyric → 深色沉浸底不与「原装主题黑字」打架，也避开 RNN 上下文依赖。
 *
 * 0 破封：只在 components/mc 内，核心六步 / 取链参数 / init 主链一行不动。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity, Animated, PanResponder, Image,
  StatusBar, Platform, BackHandler, Easing, useWindowDimensions, ScrollView,
} from 'react-native'
import { type Tokens } from '@/theme/mc'
import playerState from '@/store/player/state'
import { coverUriOf, parseLrcRows, useLyricCursor, type SheetTrack } from './UI'
import MCIcon, { QueueGlyph } from './MCIcon'
import * as playQueue from './playQueue'

const PAD = 26
const fmt = (n: number) => {
  const v = Math.max(0, Math.floor(Number(n) || 0))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * ★ 本轮修复：独立的可拖进度条（React.memo 子组件）。
 *   旧实现把 dragR 放在 FullPlayer 主体里，手指每动一帧就 setDragR →
 *   大封面 / 歌词 / 呼吸动画 / ⏮⏭ 整页 reconcile → 卡、闪、迟滞。
 *   现在拖动每帧只重渲染这个几十行的小组件；父级每秒 1 次 tick 不影响手感。
 *   拖动期间 ratio 取本地 dragR，忽略外部 position；松手才 onSeek 一次、不回弹。
 *   PanResponder 只创建一次，所有回调读 latest-ref（避免锁死首帧 duration=0）。
 *   0 破封、不动播放器：只调传进来的 onSeek。
 */
const seekStyles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  time: { fontSize: 11, width: 38 },
  track: { flex: 1, height: 32, justifyContent: 'center' },
  trackBase: { height: 4, borderRadius: 2 },
  trackFill: { position: 'absolute', height: 4, borderRadius: 2 },
  thumb: { position: 'absolute', width: 12, height: 12, borderRadius: 6,
    marginLeft: -6, top: 10 },
})
export const SeekBar = React.memo(function SeekBar({
  position, duration, onSeek, compact = false, trackKey = '', playing = true,
  trackBase = 'rgba(255,255,255,0.22)', fill = '#FFFFFF',
  timeColor = 'rgba(255,255,255,0.78)',
}: {
  position: number; duration: number; onSeek: (r: number) => void
  compact?: boolean; trackKey?: string; playing?: boolean
  trackBase?: string; fill?: string; timeColor?: string
}) {
  const [dragR, setDragR] = useState<number | null>(null)
  const dragRef = useRef<number | null>(null)
  const trackW = useRef(1)
  const trackRef = useRef<any>(null)
  const pageXRef = useRef(0)
  /** ★ B：onLayout 只给 layout.width（相对父容器），没有 pageX。
   *  用 measure() 拿轨道在屏幕上的绝对 pageX；onGrant 再重测一次
   *  （fade / 抽屉滑入会改位置）。trackW<=2 的首帧不换算，防 clamp01(x/1)=1 跳到末尾。 */
  const measureTrack = () => {
    const node = trackRef.current
    if (!node || typeof node.measure !== 'function') return
    node.measure((_x: number, _y: number, w: number, _h: number, px: number) => {
      if (w > 2) trackW.current = w
      pageXRef.current = Number(px) || 0
    })
  }
  const ratioOf = (moveX: number): number | null => {
    if (trackW.current <= 2) return null
    return clamp01((moveX - pageXRef.current) / trackW.current)
  }
  const durRef = useRef(duration)
  const seekRef = useRef(onSeek)
  durRef.current = duration
  seekRef.current = onSeek

  /**
   * ★ D-4 A：旧版 width 是字符串百分比，由「整秒 position」驱动 → 每秒跳一格。
   *   现在两次 tick 之间由 Animated.timing 线性推进到「下一秒」的比例，
   *   width / thumb.left 用 interpolate 直接驱动（useNativeDriver 不支持宽度，
   *   走 JS 但只驱动一个数值，主壳 / FullPlayer 零重渲染）。
   *   tick 仍是 usePlayer 里唯一那一个 setInterval(1000)，红线不破。
   */
  const disp = useRef(new Animated.Value(0)).current
  const dispRef = useRef(0)
  useEffect(() => {
    const id = disp.addListener(({ value }) => { dispRef.current = value })
    return () => disp.removeListener(id)
  }, [disp])
  const widthAnim = disp.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
  const leftAnim = disp.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })

  const holdRef = useRef<number | null>(null)
  const holdTimer = useRef<any>(null)
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current) }, [])

  /**
   * ★ 深度自查 P0-C：归零与推进合并成单一 effect（依赖含 trackKey）。
   *   两个 effect 拆开时，同一次 commit 里归零 effect 先跑、推进 effect 后跑，
   *   「跳变对齐」会把刚归零的 disp 又按上一首残值 r 灌回去（切歌闪到 90%）；
   *   而只有 trackKey 变时推进 effect 不重跑 → 归零后最长静止 1 秒。
   *   合并后归零那次跳过跳变对齐，直接从 0 起插值，两种情形都连续。
   */
  const lastKeyRef = useRef(trackKey)
  useEffect(() => {
    const changed = lastKeyRef.current !== trackKey
    lastKeyRef.current = trackKey
    if (changed) {
      disp.stopAnimation()
      dragRef.current = null; holdRef.current = null; setDragR(null)
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
      disp.setValue(0); dispRef.current = 0
    }
    if (duration <= 0) { disp.stopAnimation(); disp.setValue(0); dispRef.current = 0; return }
    if (dragRef.current !== null) return                    // 正在拖，交给手势
    const r = clamp01(position / duration)
    /** ★ 全项目重审 C：暂停时不排插值。旧版 effect 依赖不含 playing，
     *  暂停那一刻已启动的 1000ms timing 仍会跑完 → 进度条自己多走 1 秒再停住，
     *  恢复播放又跳一次，是反复报的「跳动 / 顿挫」来源之一。 */
    if (!playing) {
      /** ★ 再次自查 P1：暂停时 usePlayer.position 还是旧值（每秒才 tick），
       *  无条件 setValue(r) 会把刚拖到的目标比例覆盖掉 → 宽度跳回、文字仍停在
       *  目标值，约 1 秒错位。seek 未交回时保持 disp 不动，等 holdTimer /
       *  下个 tick 用真实 position 交回，零跳变。 */
      disp.stopAnimation()
      if (holdRef.current === null && dragRef.current === null) {
        disp.setValue(r); dispRef.current = r
      }
      return
    }
    if (holdRef.current !== null) {
      const h = holdRef.current
      if (r >= h - 0.008) {                                 // 原装 position 真正追上目标
        holdRef.current = null
        if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
        setDragR(null)                                     // ★ P0-E：此时文字与 position 已相等，交回无跳变
      } else return                                        // 保持目标文字 + 松手时起的插值，绝不回弹
    }
    disp.stopAnimation()
    /** 归零那次不对齐旧比例；其余（seek 等）跳变仍直接对齐，避免长距离爬升。 */
    if (!changed && Math.abs(dispRef.current - r) > 0.02) {
      disp.setValue(r); dispRef.current = r
    }
    Animated.timing(disp, {
      toValue: clamp01((position + 1) / duration),
      duration: 1000, easing: Easing.linear, useNativeDriver: false,
    }).start()
  }, [position, duration, trackKey, disp, playing])

  const setDrag = (r: number) => {
    dragRef.current = r; setDragR(r)
    disp.stopAnimation(); disp.setValue(r); dispRef.current = r
  }
  const pr = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => durRef.current > 0,
    onMoveShouldSetPanResponder: () => durRef.current > 0,
    onPanResponderGrant: (_e, g) => {
      if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
      holdRef.current = null
      measureTrack()
      /** ★ B：gestureState.moveX 是屏幕绝对坐标，不再用相对事件目标的 locationX
       *  （手指按到 12dp 的 thumb 上时 locationX 会变成 0~12 → 比例跳到接近 0）。 */
      const r = ratioOf(g.moveX)
      if (r !== null) setDrag(r)
    },
    onPanResponderMove: (_e, g) => {
      const r = ratioOf(g.moveX)
      if (r !== null) setDrag(r)
    },
    onPanResponderRelease: () => {
      const r = dragRef.current
      dragRef.current = null
      if (r !== null && durRef.current > 0) {
        seekRef.current(r)
        holdRef.current = r
        /**
         * ★ 再次深度自查 P0-E：松手**不**清 dragR。
         *   宽度/滑块早已由 disp 独立驱动，dragR 现在只决定时间文字；
         *   让用户刚拖到的目标时间保持显示，直到原装 position 追上才交回
         *   （那时两者相等，无跳变）。v4 的「立即清」会让文字回弹到旧整秒，
         *   比停在目标值更刺眼，此处如实回退那一处判断。
         */
        /** 松手立即停在目标比例 + 自行起一段插值，不等下一秒 tick */
        disp.stopAnimation(); disp.setValue(r); dispRef.current = r
        Animated.timing(disp, {
          toValue: clamp01(r + 1 / durRef.current),
          duration: 1000, easing: Easing.linear, useNativeDriver: false,
        }).start()
        if (holdTimer.current) clearTimeout(holdTimer.current)
        holdTimer.current = setTimeout(() => {
          holdRef.current = null; holdTimer.current = null
          setDragR(null)                                   // ★ P0-E：兜底同样交回，不留悬空目标值
        }, 1400)
      } else setDragR(null)
    },
    onPanResponderTerminationRequest: () => false,
  })).current

  /** 时间文字仍走渲染期值；宽度/滑块已完全交给 disp 的 Animated 插值。 */
  const curPos = dragR !== null ? dragR * duration : position
  return (
    <View style={[seekStyles.row, compact && { gap: 10 }]}>
      <Text style={[seekStyles.time, { color: timeColor }]}>{fmt(curPos)}</Text>
      <View ref={trackRef} collapsable={false} style={seekStyles.track}
        onLayout={e => {
          trackW.current = Math.max(1, e.nativeEvent.layout.width)
          measureTrack()
        }}
        {...pr.panHandlers}>
        {/* ★ B：三个子 View 禁用命中，手势始终落在轨道本身，坐标基准唯一 */}
        <View pointerEvents="none" style={[seekStyles.trackBase, { backgroundColor: trackBase }]} />
        <Animated.View pointerEvents="none"
          style={[seekStyles.trackFill, { width: widthAnim, backgroundColor: fill }]} />
        <Animated.View pointerEvents="none"
          style={[seekStyles.thumb, { left: leftAnim, backgroundColor: fill }]} />
      </View>
      <Text style={[seekStyles.time, { color: timeColor, textAlign: 'right' }]}>{fmt(duration)}</Text>
    </View>
  )
}, (a, b) => (
  /**
   * onSeek 是父级每次渲染新建的箭头函数 —— 忽略函数 props 是安全的
   * （内部 seekRef 已在渲染期同步最新值），否则 React.memo 会被击穿。
   */
  a.position === b.position && a.duration === b.duration &&
  a.trackKey === b.trackKey && a.compact === b.compact && a.playing === b.playing &&
  a.trackBase === b.trackBase && a.fill === b.fill && a.timeColor === b.timeColor
))

export default ({ visible, onClose, t, track, playing, position, duration,
  onToggle, onSeek, onFavorite, fav, canSkip, onCache, cached,
  onPrev, onNext, canPrev, canNext, playMode, onToggleMode, onPick }: {
  visible: boolean; onClose: () => void; t: Tokens; track: SheetTrack | null
  playing: boolean; position: number; duration: number
  onToggle: () => void; onSeek: (r: number) => void; onFavorite: () => void
  fav: boolean; canSkip: boolean; onCache: () => void; cached: boolean
  /** ★ H：切歌由 McShell 按态分流（批次态走原装队列，单曲态走 playQueue），
   *   本页不再直连原装 playPrev/playNext（listId=null 会直接停播）。 */
  onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean
  /** ★ K：顺序播放 / 单曲循环两态；图标变化即反馈，不弹字。 */
  playMode: 'order' | 'loop'; onToggleMode: () => void
  /** ★ K：队列抽屉点某首跳播（单曲态）。 */
  onPick: (i: number) => void
}) => {
  const { height } = useWindowDimensions()
  const s = useMemo(() => makeStyles(t), [t])

  /** ★ K：队列抽屉放本页内部（FullPlayer 是条件挂载，state 随卸载清空）。
   *  页内 absoluteFill View + 独立 drawerY，0 新增 Modal；
   *  v7：打开前先 stopAnimation，避免两条 timing 并发驱动同一 Value。
   *  v8：全程 useNativeDriver:false，与 fade/其它动画保持 driver 一致。 */
  const [queueOpen, setQueueOpen] = useState(false)
  const drawerY = useRef(new Animated.Value(1)).current
  const openQueue = () => {
    drawerY.stopAnimation()
    drawerY.setValue(1)
    setQueueOpen(true)
    Animated.timing(drawerY, { toValue: 0, duration: 220,
      easing: Easing.out(Easing.cubic), useNativeDriver: false }).start()
  }
  const closeQueue = () => {
    drawerY.stopAnimation()
    Animated.timing(drawerY, { toValue: 1, duration: 180,
      useNativeDriver: false }).start(() => { if (aliveRef.current) setQueueOpen(false) })
  }
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  /* 安卓返回键：优先关抽屉，其次关闭全屏页，都不暂停音乐 */
  useEffect(() => {
    if (!visible) return
    const h = BackHandler.addEventListener('hardwareBackPress', () => {
      if (queueOpen) { closeQueue(); return true }
      onClose(); return true
    })
    return () => h.remove()
  }, [visible, onClose, queueOpen])

  /* 进入时淡入；关闭即卸载，不残留动画 */
  const fade = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!visible) { fade.setValue(0); return }
    Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: false }).start()
  }, [visible])

  /* ★ 本轮：可拖进度已抽成模块级 SeekBar（见上）。拖动只重渲染那个子组件，
       不再让整页每帧 reconcile —— 用户报的「费劲 / 闪屏 / 迟滞」根因消失。 */

  /* ★ v6：仅本页去掉方形封面 → 歌词铺满主体。当前行放大高亮 + 左侧紫竖条，
       上下行按距离渐隐模拟滚动（不引渐变原生库）。行切换走 useLyricCursor 精确推进。 */
  const lrcText = String((playerState as any).musicInfo?.lrc || '')
  const rows = useMemo(() => parseLrcRows(lrcText), [lrcText, track?.id])
  const cursor = useLyricCursor(rows, position, track?.id, playing)
  /** ★ A：歌词压歌名的真因 —— 行数按 `height-430` 写死估算、最少 7 行 × 46dp，
   *  而 lyricBox 是 flex:1 且没有 minHeight:0 / overflow:'hidden'，内容一超就
   *  往上下溢出压住顶部歌名/歌手。改成按实测容器高度动态算行数、下限降到 3。 */
  const [lyricH, setLyricH] = useState(0)
  const onLyricLayout = (e: any) => {
    const h = Math.floor(e.nativeEvent.layout.height)
    if (h > 0 && Math.abs(h - lyricH) > 2) setLyricH(h)
  }
  const rawN = Math.max(3, Math.min(13, Math.floor((lyricH || Math.max(138, height - 430)) / 46)))
  const winN = rawN % 2 ? rawN : rawN + 1
  const half = Math.floor(winN / 2)
  const win = Array.from({ length: winN }, (_, i) => rows[cursor - half + i]?.text || '')
  /** 背景仍「按原有封面取色」：封面铺底 + 压暗罩，只是不再显示那张方形图。
   *  ★ 深度自查 P0-①：v6 新增 bgImg 时漏了 hold —— 切歌 playTrack 会同步清空
   *    musicInfo.pic，track.cover 短暂为空 → bgUri 变空 → 底图整块卸载 →
   *    背景从封面色跳成纯深紫再铺回，等于把刷歌页刚修好的闪屏复制进本页。
   *    与 McShell.lastSwipeCover 同款：hold 住上一帧有效封面，底图永不消失。 */
  const bgUriRaw = coverUriOf(track?.cover)
  const [lastBgUri, setLastBgUri] = useState('')
  useEffect(() => { if (bgUriRaw) setLastBgUri(bgUriRaw) }, [bgUriRaw])
  const bgUri = bgUriRaw || lastBgUri

  /* ★ H / v21①：判据由 McShell 统一传入（批次态原装队列 / 单曲态 playQueue），
     本页不再读 ps.tempPlayList / ps.playedList —— 那会让按钮永远灰。
     刷歌在播时 canSkip=false 仍一律置灰（F-02 保留）。 */
  const canPrevF = canSkip && canPrev
  const canNextF = canSkip && canNext

  if (!visible) return null

  const topInset = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0

  return (
    <Animated.View style={[s.root, { opacity: fade }]}>
      {/* ★ v8：背景层隔离到独立无 padding 的 absolute 容器。
          旧版 bgImg 带 width/height:'100%'，而 root 有 paddingHorizontal:26 →
          '100%' 按 content box 算，右侧 52dp 露 root 底色被压暗成深蓝竖带（图 37）。
          bgLayer 自身无 padding，bgImg 用纯 absoluteFillObject 才真正铺满整屏。 */}
      <View style={s.bgLayer} pointerEvents="none">
        {bgUri ? (
          <Image source={{ uri: bgUri }} style={s.bgImg}
            resizeMode="cover" blurRadius={26} pointerEvents="none" />
        ) : null}
        <View style={s.bgVeil} pointerEvents="none" />
      </View>
      <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
      <View style={{ height: topInset }} />

      {/* 顶栏：收起 / 标题 / 占位 */}
      <View style={s.bar}>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}>
          <Text style={s.barIco}>∨</Text>
        </TouchableOpacity>
        <Text style={s.barTitle} numberOfLines={1}>正在播放</Text>
        <View style={{ width: 30 }} />
      </View>

      {/* 歌曲信息收成顶部小条（原大封面位置让给歌词） */}
      <View style={s.info}>
        <Text style={s.title} numberOfLines={1}>{track?.title || '还没有播放歌曲'}</Text>
        <Text style={s.artist} numberOfLines={1}>{track?.artist || '去推荐或刷歌点一首'}</Text>
        <View style={s.divider} />
      </View>

      {/* ★ v6 歌词铺满：约 7~13 行可见，当前行居中放大高亮、上下行渐隐 */}
      <View style={s.lyricBox} onLayout={onLyricLayout} pointerEvents="none">
        {rows.length ? win.map((ln, i) => {
          const d = Math.abs(i - half)
          const isCur = i === half
          const alpha = isCur ? 1 : Math.max(0.12, 0.72 - d * 0.12)
          return (
            <View key={i} style={s.lyricRow}>
              {isCur ? <View style={s.lyricMarker} /> : null}
              <Text numberOfLines={1} allowFontScaling={false}
                style={[s.lyricTxt, {
                  fontSize: isCur ? 23 : 16,
                  fontWeight: isCur ? '700' : '500',
                  color: `rgba(255,255,255,${alpha})`,
                }]}>
                {ln || (isCur ? '♪  ·  ·  ·' : '')}
              </Text>
            </View>
          )
        }) : <Text style={s.noLrc}>♪  暂无歌词</Text>}
      </View>

      {/* 可拖进度：独立 memo 子组件，拖动期间父级零重渲染 */}
      <SeekBar position={position} duration={duration} onSeek={onSeek}
        trackKey={track?.id || ''} playing={playing} />

      {/* ★ K：[顺序播放/单曲循环] [上一首] [播放] [下一首] [队列] —— 严格照图 37 五钮排列。
          切歌图标改用原装 icomoon 的 prevMusic/nextMusic（|◀ / ▶|），
          不再用 Unicode U+23EE/23ED（那是快退/快进，就是用户说的「加速」）。
          MCIcon 显式传 color + rawSize，不给原装 theme 兜底机会。 */}
      <View style={s.ctrl}>
        <TouchableOpacity style={s.sideBtn} onPress={onToggleMode} activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <MCIcon name={playMode === 'loop' ? 'single-loop' : 'list-order'}
            size={21} color="rgba(255,255,255,0.86)" />
        </TouchableOpacity>
        <TouchableOpacity style={[s.skipBtn, !canPrevF && s.skipOff]}
          onPress={onPrev} disabled={!canPrevF} activeOpacity={0.8}>
          <MCIcon name="prevMusic" size={23} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity style={s.bigPlay} onPress={onToggle} activeOpacity={0.88}>
          <Text style={s.bigPlayTxt}>{playing ? '❚❚' : '▶'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.skipBtn, !canNextF && s.skipOff]}
          onPress={onNext} disabled={!canNextF} activeOpacity={0.8}>
          <MCIcon name="nextMusic" size={23} color="#FFFFFF" />
        </TouchableOpacity>
        <TouchableOpacity style={s.sideBtn} onPress={openQueue} activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <QueueGlyph color="#FFFFFF" />
        </TouchableOpacity>
      </View>

      {/* 底部 喜欢 / 缓存本地 */}
      <View style={s.bottom}>
        <TouchableOpacity style={s.bottomBtn} onPress={onFavorite} activeOpacity={0.85}>
          <Text style={[s.bottomTxt, fav && { color: t.red }]}>{fav ? '♥  已喜欢' : '♡  喜欢'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.bottomBtn} onPress={onCache} activeOpacity={0.85}>
          <Text style={[s.bottomTxt, cached && { color: t.green }]}>
            {cached ? '✓  已缓存本地' : '↓  缓存本地'}
          </Text>
        </TouchableOpacity>
      </View>
      <View style={s.safe} />

      {/* ★ K：队列抽屉 —— FullPlayer 内部一层 absoluteFill View + translateY 滑入，
          0 新增 Modal（MineScreen 已有 Sheet + FullModal 两个挂载点，不再加第三个）。
          不加下滑手势（会与 SeekBar 的 PanResponder 抢），返回键 / 关闭按钮收起。 */}
      {queueOpen ? (
        <Animated.View style={[s.drawer, {
          transform: [{ translateY: drawerY.interpolate({
            inputRange: [0, 1], outputRange: [0, 460],
          }) }],
        }]}>
          <View style={s.drawerHead}>
            <Text style={s.drawerTitle}>播放队列</Text>
            <TouchableOpacity onPress={closeQueue} hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}>
              <Text style={s.drawerClose}>∨</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={s.drawerList} showsVerticalScrollIndicator={false}>
            {(() => {
              const snap = playQueue.snapshot()
              const inBatch = !!(playerState as any).tempPlayList?.length ||
                !!(playerState as any).playInfo?.playerListId
              if (inBatch) {
                return <Text style={s.drawerEmpty}>当前为「播放全部」批次，队列由系统逐首续播。</Text>
              }
              if (!snap.items.length) {
                return <Text style={s.drawerEmpty}>暂无待播 · 听过的歌会按顺序列在这里</Text>
              }
              return snap.items.map((it, i) => (
                <TouchableOpacity key={`${it.id}_${i}`} style={[s.drawerRow, i === snap.cursor && s.drawerRowCur]}
                  onPress={() => { onPick(i); closeQueue() }} activeOpacity={0.75}>
                  <Text style={s.drawerIdx}>{i === snap.cursor ? '▶' : String(i + 1).padStart(2, '0')}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.drawerTxt} numberOfLines={1}>{it.title || '未命名'}</Text>
                    <Text style={s.drawerSub} numberOfLines={1}>{it.artist || ''}</Text>
                  </View>
                </TouchableOpacity>
              ))
            })()}
            <View style={{ height: 24 }} />
          </ScrollView>
        </Animated.View>
      ) : null}
    </Animated.View>
  )
}

const makeStyles = (t: Tokens) => StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 90,
    backgroundColor: '#241C3B', paddingHorizontal: PAD, justifyContent: 'space-between' },
  bgLayer: { ...StyleSheet.absoluteFillObject },
  bgImg: { ...StyleSheet.absoluteFillObject, opacity: 0.92 },
  bgVeil: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(10,12,26,0.60)' },
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  barIco: { color: '#FFFFFF', fontSize: 24, lineHeight: 28 },
  barTitle: { color: 'rgba(255,255,255,0.82)', fontSize: 13, fontWeight: '600' },
  info: { alignItems: 'center', marginTop: 10, flexShrink: 0, marginBottom: 6 },
  title: { color: '#FFFFFF', fontSize: 21, fontWeight: '800', textAlign: 'center' },
  artist: { color: 'rgba(255,255,255,0.62)', fontSize: 13, textAlign: 'center', marginTop: 7 },
  divider: { width: 88, height: 1, backgroundColor: 'rgba(255,255,255,0.16)', marginTop: 18 },
  lyricBox: { flex: 1, minHeight: 0, overflow: 'hidden',
    justifyContent: 'center', alignItems: 'center', paddingVertical: 8, marginTop: 6 },
  lyricRow: { height: 46, width: '100%', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 30 },
  lyricMarker: { position: 'absolute', left: 14, width: 3, height: 22,
    borderRadius: 2, backgroundColor: '#A98CFF' },
  lyricTxt: { textAlign: 'center', maxWidth: '100%', lineHeight: 30 },
  noLrc: { color: 'rgba(255,255,255,0.55)', fontSize: 16, textAlign: 'center' },
  ctrl: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 4, flexShrink: 0 },
  sideBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  skipBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  skipOff: { opacity: 0.32 },
  skipTxt: { color: '#FFFFFF', fontSize: 22 },
  bigPlay: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 14, elevation: 6 },
  bigPlayTxt: { color: '#1C2130', fontSize: 26, fontWeight: '700' },
  bottom: { flexDirection: 'row', justifyContent: 'space-around', paddingBottom: 6 },
  bottomBtn: { paddingVertical: 10, paddingHorizontal: 14 },
  bottomTxt: { color: 'rgba(255,255,255,0.86)', fontSize: 12.5, fontWeight: '600' },
  safe: { height: 22, flexShrink: 0 },
  drawer: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 460,
    backgroundColor: 'rgba(24,20,44,0.97)', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 16, zIndex: 95,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 18, elevation: 12 },
  drawerHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 14 },
  drawerTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  drawerClose: { color: 'rgba(255,255,255,0.8)', fontSize: 22, lineHeight: 26 },
  drawerList: { flex: 1 },
  drawerRow: { flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 11, paddingHorizontal: 10, borderRadius: 12 },
  drawerRowCur: { backgroundColor: 'rgba(169,140,255,0.16)' },
  drawerIdx: { color: '#A98CFF', fontSize: 13, fontWeight: '700', width: 26 },
  drawerTxt: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  drawerSub: { color: 'rgba(255,255,255,0.55)', fontSize: 11.5, marginTop: 3 },
  drawerEmpty: { color: 'rgba(255,255,255,0.55)', fontSize: 13,
    textAlign: 'center', paddingVertical: 32 },
})
