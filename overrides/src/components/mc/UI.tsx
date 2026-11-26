/**
 * 视觉原子件 —— 按真机截图逐项复刻：
 * 几何封面 / 三页 Tab + 月亮 / 白色 mini 播放条 /
 * 数字卡 / 工具格 / 榜单卡 / 场景卡 / 大入口卡 / 单曲卡 / 白色 BottomSheet。
 * 全部只接收回调，不自建播放器、不自建状态机。
 * ★ 十一期深度自查例外：LyricLines 只读 playerState.musicInfo.lrc（纯展示、不写状态）。
 */
import React, { useMemo } from 'react'
import {
  View, Text, StyleSheet, ScrollView, Modal, TouchableOpacity, Image,
} from 'react-native'
import { type Tokens, coverHue } from '@/theme/mc'
import playerState from '@/store/player/state'
import MCIcon from './MCIcon'

/**
 * 封面 URL 归一化：协议相对补 https、占位串/非法协议返回空，卡片底图与 Cover 共用。
 * ★ 十期 P1-14：与 upstream.coverUri 对齐 —— 音源偶把 URL 里的 & 写成 &amp;，
 *   不还原就 404；旧版 UI 这份是老实现，导致大卡/榜单/Cover 仍显示几何块。
 */
export const coverUriOf = (v?: string): string => {
  const s = String(v || '').trim().replace(/&amp;/g, '&')
  if (!s || ['null', 'undefined', '0', 'none', 'default'].includes(s.toLowerCase())) return ''
  return /^\/\//.test(s) ? 'https:' + s : /^https?:\/\//i.test(s) ? s : ''
}

export type SheetTrack = {
  id: string
  title: string
  artist?: string
  album?: string
  duration?: number
  cover?: string
  /** 缓存本地后的私有目录路径；有值时统一播放链路跳过在线取链 */
  localPath?: string
  raw?: any
}

const fmt = (n: number) => {
  const v = Math.max(0, Math.floor(Number(n) || 0))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
}

/* ══ 1. 几何封面：截图里每张列表封面都是这个样式 ══ */
export function Cover({ uri, title, artist, size = 48, radius = 10, t, style }: {
  uri?: string; title?: string; artist?: string; size?: number; radius?: number; t: Tokens; style?: any
}) {
  const [c1, c2] = coverHue(title || uri || 'x')
  const [fail, setFail] = React.useState(false)
  React.useEffect(() => { setFail(false) }, [uri])
  const box: any = { width: size, height: size, borderRadius: radius }
  // ★ 十期 P1-14：统一走 coverUriOf（含 &amp; 还原），不再内联一份老逻辑
  const norm = coverUriOf(uri)
  const valid = !!norm && !fail
  if (valid) {
    return <Image source={{ uri: norm }} style={[box, style]} resizeMode="cover" onError={() => setFail(true)} />
  }
  return (
    <View style={[box, { backgroundColor: c1, overflow: 'hidden' }, style]}>
      <View style={{ position: 'absolute', right: -size * 0.26, top: -size * 0.22,
        width: size * 0.78, height: size * 0.78, borderRadius: size * 0.39,
        backgroundColor: c2, opacity: 0.78 }} />
      <View style={{ position: 'absolute', left: -size * 0.18, bottom: -size * 0.24,
        width: size * 0.6, height: size * 0.6, borderRadius: size * 0.3,
        backgroundColor: 'rgba(0,0,0,0.16)' }} />
      {/* 左下白色 L 折角 */}
      <View style={{ position: 'absolute', left: size * 0.09, bottom: size * 0.1,
        width: size * 0.2, height: Math.max(1.5, size * 0.022), backgroundColor: '#FFF' }} />
      <View style={{ position: 'absolute', left: size * 0.09, bottom: size * 0.1,
        width: Math.max(1.5, size * 0.022), height: size * 0.2, backgroundColor: '#FFF' }} />
      {/* 白圆点 + 深色圆心 */}
      <View style={{ position: 'absolute', right: size * 0.2, top: size * 0.34,
        width: size * 0.19, height: size * 0.19, borderRadius: size * 0.1,
        backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: size * 0.075, height: size * 0.075, borderRadius: size * 0.04, backgroundColor: '#1B1E2E' }} />
      </View>
      {size >= 76 ? (
        <Text numberOfLines={1} allowFontScaling={false} style={{ position: 'absolute', left: size * 0.09,
          bottom: size * 0.06, color: '#FFF', fontSize: Math.max(8, size * 0.075),
          fontWeight: '800', maxWidth: size * 0.82, textShadowColor: 'rgba(0,0,0,.4)',
          textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } }}>
          {String(title || '♪').slice(0, 9)}
        </Text>
      ) : null}
    </View>
  )
}

/* ══ 1.5 刷歌页 2 行同步歌词（纯只读，封在固定 48px 容器里，长短不跳版） ══
 * ★ 十一期深度自查修正：旧版优先读原装全局歌词引擎 useLrcPlay()/useLrcSet()。
 *   核实 core/init/player/lyric.ts 后有两个不可控点：
 *     ① `global.app_event.on('musicToggled', stop)`，而 stop() 是
 *        `void handleSetLyric('')` **异步** —— 切歌窗口内 lrcTools.currentLines
 *        仍残留上一首，引擎路径会短暂串歌词；
 *     ② `lines[line].text` 依赖 lrc-file-parser 的 Line 字段结构，不由我们定义。
 *   而 playerState.musicInfo.lrc 由 upstream.fillMeta() 的 stillCurrent() 校验过，
 *   **一定属于当前曲目**，且切歌时被 setMusicInfo({lrc:''}) 同步清空 → 天然不串。
 *
 *   改为纯只读：解析 musicInfo.lrc 原文 + 外部 position 做行定位。
 *   position 由 usePlayer 每秒 setInterval 驱动重渲染，进度同步不依赖任何引擎状态；
 *   不订阅 app_event、不建定时器、不写状态、不碰主链路。trackId 进 deps 只为切歌即时重算。
 */
export type LrcRow = { time: number, text: string }
export const parseLrcRows = (lrc: string): LrcRow[] => {
  const rows: Array<{ time: number, text: string }> = []
  for (const ln of String(lrc || '').split('\n')) {
    const tags = ln.match(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g)
    if (!tags) continue
    const text = ln.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const tag of tags) {
      const m = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/.exec(tag)
      if (!m) continue
      rows.push({ time: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0), text })
    }
  }
  return rows.sort((a, b) => a.time - b.time)
}

/**
 * ★ v6 全局歌词同步（核查结论：旧实现只靠 usePlayer 每秒整秒 tick 判行，
 *   平均慢 0.5s / 最坏 1s）。这里以整秒 position 为**基准对齐**，
 *   额外用一次性 timeout 在「下一行时间戳」精确推进：
 *     · 每 tick（每秒）重排一次 → 用最新 position 重算剩余时间，永不漂移；
 *     · 切歌 / seek（position 跳变 / rows 变）→ cleanup 清旧 timer 重排；
 *     · playing=false → 清 timer 并冻结当前行，暂停时不再自己切歌词。
 *   不建常驻 interval、不碰 usePlayer、不碰播放器、不碰主链路。
 */
export function useLyricCursor(rows: LrcRow[], position: number,
  trackId?: string, playing: boolean = true): number {
  /** ★ v8：整块重写为「ref 游标 + 链式一次性 timeout」。
   *  旧版在 useEffect 里 setIdx 且 deps 含外部数组 rows，一旦上游产生新引用
   *  就可能形成 effect→setState→重渲染→effect 的嵌套更新链，React 抛
   *  "Maximum update depth exceeded" → 被外层 ErrorBoundary 整壳替换（图 38）。
   *  现在 render 期纯计算、零 setState；effect 只排 timer；deps 不含游标 →
   *  结构上不可能循环。链式 chain() 让同秒内多行也精确推进。 */
  const [, nudge] = React.useState(0)
  const idxRef = React.useRef(0)
  const lastKeyRef = React.useRef<string | undefined>(trackId)
  const lastPosRef = React.useRef(position)
  const timer = React.useRef<any>(null)
  const alive = React.useRef(true)

  // render 期纯计算：当前行基准（不写任何状态）
  let base = 0
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].time <= position + 0.15) base = k
    else break
  }
  // 切歌 / seek 倒退 → 归零重算；正常播放取 max，不回退 timeout 已推进的行
  const reset = lastKeyRef.current !== trackId || position < lastPosRef.current - 1
  if (reset || base > idxRef.current) idxRef.current = base
  if (!rows.length) idxRef.current = 0
  lastKeyRef.current = trackId
  lastPosRef.current = position

  React.useEffect(() => {
    alive.current = true
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (!playing || !rows.length) return
    /** 以「当前已到达的歌曲时间」为基准链式排下一行；每次整秒 tick 重排 → 不漂移。
     *  ★ 全项目重审 P0：旧版 chain() 恒用闭包里捕获的整秒 position 作基准，
     *    但 setTimeout 的 dt 是相对「当前时刻」的 —— 同一秒内出现第二行歌词时，
     *    第二次仍按 (nt2 - 起始整秒) 排，从 10.4 起再等 800ms → 11.2 才切，晚 0.4s。
     *    v8 的复验模拟器用的是绝对 fireAt，与实现的相对 setTimeout 不一致，
     *    所以「全绿」是模拟器自证，不是实现正确。现在把刚到达的行时间传下去作新基准。 */
    const chain = (atTime: number) => {
      const nt = rows[idxRef.current + 1]?.time
      if (nt == null) return
      const dt = (nt - atTime) * 1000
      if (dt <= 0) return                 // 已越过，等下个整秒 tick 对齐
      timer.current = setTimeout(() => {
        timer.current = null
        if (!alive.current) return
        idxRef.current = idxRef.current + 1
        nudge(v => v + 1)                // 只触发一次重渲染，不重跑本 effect
        chain(nt)                        // 用刚到达的那一行时间作新基准
      }, dt)
    }
    chain(position)
    return () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
    }
  }, [rows, position, trackId, playing])

  React.useEffect(() => () => { alive.current = false }, [])
  return idxRef.current
}

export function LyricLines({ position, trackId, playing = true, variant = 'box' }: {
  position: number, trackId?: string, playing?: boolean, variant?: 'box' | 'plain'
}) {
  const lrcText = String((playerState as any).musicInfo?.lrc || '')
  /** position 每秒刷新会重渲染，缓存解析结果避免每秒重复 split+sort。 */
  const rows = useMemo(() => parseLrcRows(lrcText), [lrcText, trackId])
  const i = useLyricCursor(rows, position, trackId, playing)
  const cur = rows[i]?.text || ''
  const next = rows[i + 1]?.text || ''
  const plain = variant === 'plain'
  return (
    <View style={plain ? sLyric.boxPlain : sLyric.box} pointerEvents="none">
      <Text numberOfLines={1} allowFontScaling={false}
        style={plain ? sLyric.curPlain : sLyric.cur}>
        {cur || '♪  暂无歌词'}
      </Text>
      <Text numberOfLines={1} allowFontScaling={false}
        style={plain ? sLyric.nxtPlain : sLyric.nxt}>
        {next || (cur ? '·  ·  ·' : '歌词由音源提供，有就会自动同步')}
      </Text>
    </View>
  )
}

const sLyric = StyleSheet.create({
  box: { height: 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.10)',
    paddingHorizontal: 14, justifyContent: 'center', alignItems: 'center' },
  cur: { color: '#FFF', fontSize: 15, fontWeight: '700', textAlign: 'center', lineHeight: 21 },
  nxt: { color: 'rgba(214,219,238,0.62)', fontSize: 12, textAlign: 'center', lineHeight: 17, marginTop: 2 },
  /* ★ F-15②：汽水化 —— 去掉 48px 灰底盒，歌词直接铺在单色背景上成为主视觉 */
  boxPlain: { minHeight: 78, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 },
  curPlain: { color: '#FFF', fontSize: 21, fontWeight: '700', textAlign: 'center', lineHeight: 30 },
  nxtPlain: { color: 'rgba(255,255,255,0.48)', fontSize: 18, textAlign: 'center', lineHeight: 26, marginTop: 6 },
})

/* ══ 2. 顶部字标条 ══ */
/* ★ 三期：字标条整体删除，主界面不再显示 logo 与 APP 名。
   状态栏留白与深浅色切换由主壳的 StatusBar / TabBar 月亮承担。 */

/* ══ 3. 三页 Tab + 月亮 ══ */
export type TabKey = 'swipe' | 'reco' | 'mine'
export function TabBar({ t, tab, onChange, onToggleTheme, dark }: {
  t: Tokens; tab: TabKey; onChange: (k: TabKey) => void; onToggleTheme: () => void
  /** ★ 十期 P0-3：刷歌页底色强制深色，但月亮必须按**真实主题**渲染，
   *  否则用户在刷歌页点它完全没有反馈（旧版把恒定 DARK 传进来）。 */
  dark?: boolean
}) {
  const s = useMemo(() => baseStyles(t), [t])
  const moonT = dark ? { card: 'rgba(255,255,255,0.12)', brand: '#FFF' } : null
  const items: Array<{ k: TabKey, label: string }> = [
    { k: 'swipe', label: '刷歌' }, { k: 'reco', label: '推荐' }, { k: 'mine', label: '我的' },
  ]
  return (
    <View style={s.tabBar}>
      {items.map(x => (
        <TouchableOpacity key={x.k} style={s.tabItem} onPress={() => onChange(x.k)} activeOpacity={0.8}>
          <Text style={[s.tabTxt, tab === x.k && s.tabTxtOn]}>{x.label}</Text>
          {tab === x.k && <View style={s.tabLine} />}
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={[s.moon, moonT ? { backgroundColor: moonT.card } : null]}
        onPress={onToggleTheme} activeOpacity={0.8}>
        <Text style={[s.moonTxt, moonT ? { color: moonT.brand } : null]}>{dark ? '☀' : '☾'}</Text>
      </TouchableOpacity>
    </View>
  )
}

/* ══ 4. 白色 mini 播放条 ══ */
export function MiniBar({ t, track, onPress, onToggle, onPrev, onNext, canPrev, canNext, playing }: {
  t: Tokens; track: SheetTrack | null; onPress: () => void; onToggle: () => void
  /** ★ H / K：mini 条补齐上一首 + 下一首。判据由 McShell 按态分流传入，
   *   单曲态走 playQueue 历史，批次态走原装队列；刷歌页不渲染 mini 条，
   *   不违反「刷歌不加切歌按钮」。图标用原装 icomoon 的 prevMusic/nextMusic。 */
  onPrev: () => void; onNext: () => void; canPrev: boolean; canNext: boolean
  playing: boolean
}) {
  const s = useMemo(() => baseStyles(t), [t])
  /** ★ 并列结构：外层纯 View，主体 / 播放 / 下一首各一个独立可点区，
   *   不嵌套 TouchableOpacity（避免部分 Android 机型双触发）。 */
  return (
    <View style={s.mini}>
      <TouchableOpacity style={s.miniMain} onPress={onPress} activeOpacity={0.95}>
        <Cover uri={track?.cover} title={track?.title} size={42} radius={11} t={t} />
        <View style={s.miniBody}>
          <Text style={s.miniTitle} numberOfLines={1}>{track?.title || '还没有播放歌曲'}</Text>
          <Text style={s.miniSub} numberOfLines={1}>{track?.artist || '去推荐或刷歌点一首'}</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={s.miniPlay} onPress={onToggle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={s.miniPlayTxt}>{playing ? '❚❚' : '▶'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[s.miniPrev, !canPrev && s.miniNextOff]}
        onPress={onPrev} disabled={!canPrev} activeOpacity={0.8}
        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
        <MCIcon name="prevMusic" size={15} color={t.brand} />
      </TouchableOpacity>
      <TouchableOpacity style={[s.miniNext, !canNext && s.miniNextOff]}
        onPress={onNext} disabled={!canNext} activeOpacity={0.8}
        hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}>
        <MCIcon name="nextMusic" size={15} color={t.brand} />
      </TouchableOpacity>
    </View>
  )
}

/* ★ 三期：旧数字卡 / 工具格组件整体删除（我的页重做后已无引用，减少代码量）。 */

/* ══ 5. 大入口卡（猜你喜欢 / 每日推荐） ══
 * ★ 三期修 ①：旧签名收 `onPlay`，而 RecoScreen 传的是 `onPress` → onPress={undefined}
 *   → 两张最显眼的大卡点了完全没反应。统一为 onPress。
 * ★ 三期修 ⑤：加 cover 真实封面底图 + 渐变遮罩，尺寸/圆角/文字位置全不变。
 */
export function BigEntryCard({ t, variant, title, sub, badge, cover, onPress, onQuickPlay }: {
  t: Tokens; variant: 'guess' | 'daily'; title: string; sub: string; badge?: string
  cover?: string; onPress: () => void
  /** ★ 十一期：▶ 独立可点 → 直接打乱播该卡批次；其余区域仍进浮层自选。
   *    并列结构（外层 View + 两个 sibling Touchable），不嵌套，避免 RN 双触发。 */
  onQuickPlay?: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  const uri = coverUriOf(cover)
  /**
   * ★ 九期（封面修复④）：大卡原来用裸 Image，CDN 404 / 无封面时整块空白，
   *   推荐页最刺眼。加载失败即退回「按标题取主色」的几何底，永不空白。
   */
  const [fail, setFail] = React.useState(false)
  React.useEffect(() => { setFail(false) }, [uri])
  const [c1, c2] = coverHue(title || 'x')
  return (
    <View style={[s.bigCard, variant === 'daily' && s.bigCardDaily]}>
      {/* 主体：点其余区域进浮层自选 */}
      <TouchableOpacity style={s.bigCardMain} onPress={onPress} activeOpacity={0.9}>
        {uri && !fail
          ? <Image source={{ uri }} style={s.cardBgImg} resizeMode="cover" onError={() => setFail(true)} />
          : <View style={[s.cardBgImg, { backgroundColor: c1, overflow: 'hidden' }]}>
              <View style={{ position: 'absolute', right: -40, top: -30, width: 150, height: 150,
                borderRadius: 75, backgroundColor: c2, opacity: 0.6 }} />
              <View style={{ position: 'absolute', left: -30, bottom: -40, width: 120, height: 120,
                borderRadius: 60, backgroundColor: 'rgba(0,0,0,0.16)' }} />
            </View>}
        <View style={s.bigShade} />
        <View style={s.bigTop}>
          <Text style={s.bigTitle} numberOfLines={2}>{title}</Text>
          <Text style={s.bigSub} numberOfLines={2}>{sub}</Text>
        </View>
        {variant === 'daily' ? (
          <View style={s.vinyl}><View style={s.vinylHole} /></View>
        ) : null}
        {badge ? <Text style={s.bigBadge}>{badge}</Text> : null}
      </TouchableOpacity>
      {/* ▶：独立按钮，命中区与主体不重叠 */}
      <TouchableOpacity style={s.bigPlay} onPress={onQuickPlay || onPress} activeOpacity={0.85}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={s.bigPlayTxt}>▶</Text>
      </TouchableOpacity>
    </View>
  )
}

/* ══ 8. 横卡（TOP500 / 常听歌手） ══ */
export function WideCard({ t, title, sub, bg, cover, onPress, onQuickPlay }: {
  t: Tokens; title: string; sub: string; bg: string; cover?: string; onPress: () => void
  /** ★ 十一期：TOP500 / 常听歌手 的 ▶ 直接播该卡批次，其余区域进浮层自选 */
  onQuickPlay?: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <View style={[s.wideCard, { backgroundColor: bg }]}>
      <TouchableOpacity style={s.wideMain} onPress={onPress} activeOpacity={0.88}>
        <Cover uri={coverUriOf(cover)} title={title} size={42} radius={9} t={t} />
        <View style={s.wideBody}>
          <Text style={s.wideTitle} numberOfLines={2}>{title}</Text>
          <Text style={s.wideSub} numberOfLines={2}>{sub}</Text>
        </View>
      </TouchableOpacity>
      <TouchableOpacity style={s.widePlay} onPress={onQuickPlay || onPress} activeOpacity={0.85}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={s.widePlayTxt}>▶</Text>
      </TouchableOpacity>
    </View>
  )
}

/* ══ 9. 场景卡 ══ */
export function SceneCard({ t, icon, title, desc, color, onPress }: {
  t: Tokens; icon: string; title: string; desc: string; color: string; onPress: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <TouchableOpacity style={s.scene} onPress={onPress} activeOpacity={0.88}>
      <View style={[s.sceneIco, { backgroundColor: color }]}><Text style={s.sceneIcoTxt}>{icon}</Text></View>
      <Text style={s.sceneTitle}>{title}</Text>
      <Text style={s.sceneDesc} numberOfLines={2}>{desc}</Text>
    </TouchableOpacity>
  )
}

/* ══ 10. 榜单卡 2×2 ══ */
export function BoardCard({ t, title, sub, seed, cover, onPress, onQuickPlay }: {
  t: Tokens; title: string; sub: string; seed: string; cover?: string; onPress: () => void
  /** ★ 十一期：热门榜单卡 ▶ 直接播该卡批次，其余区域进浮层自选 */
  onQuickPlay?: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <View style={s.board}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.88}>
        <Cover uri={coverUriOf(cover)} title={seed} size={132} radius={12} t={t} style={s.boardCover} />
        <Text style={s.boardTitle} numberOfLines={1}>{title}</Text>
        <Text style={s.boardSub}>{sub}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.boardPlay} onPress={onQuickPlay || onPress} activeOpacity={0.85}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <Text style={s.boardPlayTxt}>▶</Text>
      </TouchableOpacity>
    </View>
  )
}

/* ══ 11. 单曲推荐卡 ══ */
export function SongCard({ t, track, onPlay, onLike, onSkip, liked }: {
  t: Tokens; track: SheetTrack; onPlay: () => void; onLike: () => void; onSkip: () => void; liked?: boolean
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <View style={s.songCard}>
      <Cover uri={track.cover} title={track.title} artist={track.artist} size={76} radius={10} t={t} />
      <View style={s.songBody}>
        <Text style={s.songTitle} numberOfLines={1}>{track.title}</Text>
        <Text style={s.songArtist} numberOfLines={2}>{track.artist || '未知歌手'}</Text>
      </View>
      <TouchableOpacity style={s.songBtn} onPress={onPlay}><Text style={s.songBtnPlay}>▶</Text></TouchableOpacity>
      <TouchableOpacity style={s.songBtn} onPress={onLike}>
        <Text style={[s.songBtnIco, { color: liked ? t.red : t.sub }]}>{liked ? '♥' : '♡'}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.songBtn} onPress={onSkip}><Text style={s.songBtnIco}>✕</Text></TouchableOpacity>
    </View>
  )
}

/* ══ 12. Sheet ══ */
export function Sheet({ visible, title, badge, subtitle, onClose, children, t, actions, toast }: {
  visible: boolean; title: string; badge?: string; subtitle?: string; onClose: () => void
  children?: React.ReactNode; actions?: React.ReactNode; t: Tokens
  /** ★ 十期 P0-5：反馈必须渲染在 Modal 内部（底层页面 msg 会被浮层完全盖住） */
  toast?: string
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetWrap}>
        <TouchableOpacity style={s.sheetMask} onPress={onClose} activeOpacity={1} />
        <View style={s.sheet}>
          {/* ★ 浮层内 Toast：缓存成功 / 批量进度都看得见 */}
          {toast ? (
            <View style={s.sheetToast} pointerEvents="none">
              <View style={s.sheetToastTick}><Text style={s.sheetToastTickTxt}>✓</Text></View>
              <Text style={s.sheetToastTxt} numberOfLines={1}>{toast}</Text>
            </View>
          ) : null}
          <View style={s.sheetHead}>
            {badge ? <View style={s.sheetBadge}><Text style={s.sheetBadgeTxt}>{badge}</Text></View> : <View />}
            <TouchableOpacity style={s.sheetClose} onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={s.sheetCloseTxt}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.sheetTitle}>{title}</Text>
          {subtitle ? <Text style={s.sheetSub}>{subtitle}</Text> : null}
          {actions ? <View style={s.sheetActions}>{actions}</View> : null}
          <View style={s.sheetLine} />
          <ScrollView style={s.sheetBody} contentContainerStyle={{ paddingBottom: 24 }}
            showsVerticalScrollIndicator={false} removeClippedSubviews>
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

export function SheetButton({ t, label, primary, onPress }: {
  t: Tokens; label: string; primary?: boolean; onPress: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <TouchableOpacity style={[s.shBtn, primary && s.shBtnPrimary]} onPress={onPress} activeOpacity={0.85}>
      <Text style={[s.shBtnTxt, primary && s.shBtnTxtPrimary]}>{label}</Text>
    </TouchableOpacity>
  )
}

/* ══ 13. 歌曲行（序号 + 几何封面 + 蓝三角） ══ */
export function SongRow({ t, track, index, current, onPress, onCache }: {
  t: Tokens; track: SheetTrack; index: number; current?: boolean
  onPress: () => void; onCache?: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  /**
   * ★ 自查修正：旧版把「↓ 缓存本地」按钮嵌在整行 TouchableOpacity 里。
   *   RN 嵌套可点击组件在部分机型上会双触发 —— 点一下缓存，顺带把歌也播了。
   *   现改成并列结构：外层纯 View，行主体与缓存按钮各是独立 TouchableOpacity，
   *   命中区域完全不重叠，绝不连带播放。
   */
  return (
    <View style={s.listRow}>
      <TouchableOpacity style={s.listMain} onPress={onPress} activeOpacity={0.85}>
        <Text style={[s.listNum, current && s.listNumOn]}>{current ? '♪' : String(index + 1).padStart(2, '0')}</Text>
        <Cover uri={track.cover} title={track.title} size={50} radius={8} t={t} />
        <View style={s.listBody}>
          <Text style={[s.listTitle, current && s.listTitleOn]} numberOfLines={1}>{track.title}</Text>
          <Text style={s.listArtist} numberOfLines={1}>{track.artist || '未知歌手'}</Text>
        </View>
      </TouchableOpacity>
      {onCache ? (
        <TouchableOpacity style={s.listCacheBtn} onPress={onCache}
          hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
          <Text style={s.listCache}>↓</Text>
        </TouchableOpacity>
      ) : null}
      {/* ★ 三期修 ②：旧版蓝色 ▶ 是纯 Text，落在可点区之外，用户本能点它毫无反应。
          包成独立按钮并绑 onPress，整行三分区域都能播。 */}
      <TouchableOpacity style={s.listPlayBtn} onPress={onPress}
        hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}>
        <Text style={s.listPlay}>▶</Text>
      </TouchableOpacity>
    </View>
  )
}

export function SongListSheet({ visible, title, badge, subtitle, tracks, onClose, onPlay,
  onPlayAll, onBatch, playingId, t, extraChip, extraActions, onCache, toast }: {
  visible: boolean; title: string; badge?: string; subtitle?: string
  tracks: SheetTrack[]; onClose: () => void; onPlay: (t: SheetTrack) => void
  /** ★ 十一期：传整批，由调用方走 playBatch（原装 tempPlayList 逐首续播、播完批自动停） */
  onPlayAll?: (tracks: SheetTrack[]) => void; onBatch?: () => void; playingId?: string; t: Tokens
  extraChip?: React.ReactNode; extraActions?: React.ReactNode
  onCache?: (t: SheetTrack) => void; toast?: string
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <Sheet visible={visible} title={title} badge={badge} subtitle={subtitle} onClose={onClose} t={t}
      toast={toast}
      actions={<>
        {/* ★ 十一期：真「播放全部」—— 整批装入原装稍后播放队列，逐首续播、播完批自动停 */}
        {onPlayAll ? <SheetButton t={t} label="▶  播放全部" primary onPress={() => onPlayAll(tracks)} /> : null}
        {onBatch ? <SheetButton t={t} label="↻  换一批" onPress={onBatch} /> : null}
        {extraActions}
      </>}>
      {extraChip}
      {!tracks.length ? <Text style={s.empty}>曲库还在补货，稍等一下</Text> : null}
      {tracks.map((tr, i) => (
        <SongRow key={tr.id + i} t={t} track={tr} index={i} current={playingId === tr.id}
          onPress={() => onPlay(tr)} onCache={onCache ? () => onCache(tr) : undefined} />
      ))}
      <View style={{ height: 18 }} />
    </Sheet>
  )
}

export function Chip({ label, on, onPress, t }: { label: string; on?: boolean; onPress: () => void; t: Tokens }) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <TouchableOpacity onPress={onPress} style={[s.chip, on && s.chipOn]} activeOpacity={0.8}>
      <Text style={[s.chipTxt, on && s.chipTxtOn]}>{label}</Text>
    </TouchableOpacity>
  )
}

export function SectionTitle({ t, children, right, onRight }: {
  t: Tokens; children: React.ReactNode; right?: string; onRight?: () => void
}) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <View style={s.sec}>
      <View style={s.secBar} />
      <Text style={s.secTitle}>{children}</Text>
      {right ? <TouchableOpacity onPress={onRight}><Text style={s.secRight}>{right} ›</Text></TouchableOpacity> : null}
    </View>
  )
}

export function StatBar({ t, label, value }: { t: Tokens; label: string; value: string | number }) {
  const s = useMemo(() => baseStyles(t), [t])
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue} numberOfLines={1}>{String(value)}</Text>
    </View>
  )
}

/* ★ 本轮 D-6 A：旧抽屉 NowPlayingSheet（含「点这里跳到中间 · 进度条当前只读」）
   自 F-14 全屏单曲页起零调用，整块删除；全局进度条现在只有 FullPlayer.SeekBar 一处实现，
   全屏页与刷歌页共用。 */

/* ══ 14. 全屏容器：给「设置」「歌词」这类原装组件用 ══
   原装设置页 / 歌词页都是 FlatList（flex:1），不能塞进 Sheet 的 ScrollView（会嵌套滚动）。
   单独全屏 Modal，白底，带一条返回条；不注册 RNN screen、不改导航注册。 */
export function FullModal({ visible, title, onClose, children, t }: {
  visible: boolean; title: string; onClose: () => void; children: React.ReactNode; t?: Tokens
}) {
  const s = useMemo(() => makeFullModalStyles(t), [t])
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        <View style={s.bar}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
            <Text style={s.back}>←  返回</Text>
          </TouchableOpacity>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
        </View>
        <View style={s.body}>{children}</View>
      </View>
    </Modal>
  )
}
/**
 * ★ 十期二轮②（回退本轮 P2-25 的过度改动）：
 *   首轮把「顶栏跟随主题」而 body 保留白底 → 深色主题下变成**半深半白**，
 *   比原来整页白更割裂，反而违背九期「全屏沉浸」。
 *   且 FullModal 里是原装设置 / 原装歌词，它们读**原装 theme 变量**（不跟我们的 mode 同步），
 *   容器跟着变深会出现「黑字黑底」不可读。
 *   结论：整页统一白底最稳；只让返回按钮取主题色保持品牌感，并记录为已知取舍。
 */
const makeFullModalStyles = (t?: Tokens) => StyleSheet.create({
  root: { flex: 1, backgroundColor: '#FFFFFF' },
  bar: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14,
    borderBottomWidth: 1, borderBottomColor: '#EDEFF6', gap: 14, backgroundColor: '#FFFFFF' },
  back: { color: t?.brand ?? '#6D5EFC', fontSize: 15, fontWeight: '700' },
  title: { color: '#15182C', fontSize: 17, fontWeight: '800', flex: 1 },
  body: { flex: 1, overflow: 'hidden', backgroundColor: '#FFFFFF' },
})

/* ══ 样式 ══ */
const baseStyles = (t: Tokens) => StyleSheet.create({
  /* header */
  /* tabs */
  /* ★ 九期：TabBar 完全透明，与状态栏/内容区同一底色，只靠文字高亮和指示线区分 */
  tabBar: { height: 54, backgroundColor: 'transparent', flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 22, gap: 4 },
  tabItem: { paddingHorizontal: 4, height: 54, marginRight: 26, alignItems: 'center', justifyContent: 'center' },
  tabTxt: { color: t.sub, fontSize: 18, fontWeight: '600' },
  tabTxtOn: { color: t.isDark ? '#FFF' : t.text, fontWeight: '800' },
  tabLine: { position: 'absolute', bottom: 6, width: 20, height: 3, borderRadius: 2, backgroundColor: t.brand },
  moon: { marginLeft: 'auto', width: 38, height: 38, borderRadius: 19,
    backgroundColor: t.isDark ? 'rgba(255,255,255,0.12)' : '#FFF',
    alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.08,
    shadowRadius: 6, elevation: 2 },
  moonTxt: { color: t.isDark ? '#E9ECFA' : t.brand, fontSize: 19 },
  /* ★ 九期：mini 条改悬浮圆角胶囊，不再横贯一条白块割裂页面 */
  mini: { position: 'absolute', left: 14, right: 14, bottom: 16, height: 62,
    flexDirection: 'row', alignItems: 'center', gap: 11, borderRadius: 20,
    backgroundColor: t.cardSolid, paddingHorizontal: 12,
    shadowColor: '#1E285A', shadowOpacity: 0.16, shadowRadius: 16, elevation: 8 },
  miniMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 11 },
  miniBody: { flex: 1, minWidth: 0 },
  miniTitle: { color: t.text, fontSize: 13, fontWeight: '800' },
  miniSub: { color: t.sub, fontSize: 11, marginTop: 2 },
  miniPlay: { width: 42, height: 42, borderRadius: 21, backgroundColor: t.brand,
    alignItems: 'center', justifyContent: 'center', shadowColor: t.brand, shadowOpacity: 0.34,
    shadowRadius: 8, elevation: 4 },
  miniPlayTxt: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  miniNext: { width: 34, height: 34, borderRadius: 17, backgroundColor: t.chipOff,
    alignItems: 'center', justifyContent: 'center' },
  miniPrev: { width: 34, height: 34, borderRadius: 17, backgroundColor: t.chipOff,
    alignItems: 'center', justifyContent: 'center' },
  miniNextOff: { opacity: 0.34 },
  miniNextTxt: { color: t.brand, fontSize: 15, fontWeight: '700' },
  /* ★ 五期自查⑥：数字卡 / 工具格组件已删，对应 8 条死样式一并清掉（减少代码量） */
  /* big entry */
  /* ★ F-11：宽度交给外层横滑 item 控制（酷狗形态：窄竖卡同行横滑），
       字号/圆角统一收紧，去掉「尺寸太大、生硬」的观感 */
  /* ★ 本轮：0.70 竖长条（约 580 高）太大 → 1.45 横向卡（约 280 高），
       双大卡固定占一行，不再横滑。 */
  bigCard: { width: '100%', aspectRatio: 1.45, borderRadius: 16,
    backgroundColor: '#6E7488', overflow: 'hidden' },
  bigCardDaily: { backgroundColor: '#182238' },
  /* ★ 十一期：主卡主体铺满外层，▶ 作为 sibling 独立可点（并列结构，不嵌套） */
  bigCardMain: { ...StyleSheet.absoluteFillObject, padding: 15, justifyContent: 'space-between' },
  bigShade: { ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(10,12,26,0.30)' },
  bigTop: { zIndex: 1 },
  bigTitle: { color: '#FFF', fontSize: 15.5, fontWeight: '800', textShadowColor: 'rgba(0,0,0,.45)', textShadowRadius: 8 },
  bigSub: { color: 'rgba(255,255,255,.86)', fontSize: 11, marginTop: 5, lineHeight: 16 },
  /* ★ 深度自查：横卡高仅约 119dp，旧 top:42% 会压到左上标题/副标题 → 改贴底左侧 */
  bigBadge: { position: 'absolute', left: 16, bottom: 16, color: '#FFF', fontSize: 12 },
  /* ★ 横卡里黑胶缩到 40² 并上移，避免 bottom 130 > 卡高被裁、也不压 ▶ */
  vinyl: { position: 'absolute', right: 16, top: 26, width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#8A8F9E', alignItems: 'center', justifyContent: 'center', opacity: 0.9 },
  vinylHole: { width: 13, height: 13, borderRadius: 7, backgroundColor: '#1B1E2E' },
  bigPlay: { position: 'absolute', right: 12, bottom: 12, width: 42, height: 42, borderRadius: 21,
    backgroundColor: t.blue, alignItems: 'center', justifyContent: 'center', zIndex: 2 },
  bigPlayTxt: { color: '#FFF', fontSize: 20, marginLeft: 2 },
  /* wide card */
  wideCard: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 16, padding: 12 },
  wideMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 10 },
  wideBody: { flex: 1 },
  wideTitle: { color: '#FFF', fontSize: 15, fontWeight: '800', lineHeight: 19 },
  wideSub: { color: 'rgba(255,255,255,.86)', fontSize: 11, marginTop: 3, lineHeight: 15 },
  widePlay: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.26)',
    alignItems: 'center', justifyContent: 'center' },
  widePlayTxt: { color: '#FFF', fontSize: 13, marginLeft: 1 },
  /* scene */
  /* ★ 本轮：不再横滑，3 张等分固定一行 */
  scene: { flex: 1, minWidth: 0, backgroundColor: t.card, borderRadius: 14, padding: 12,
    shadowColor: '#3A4270', shadowOpacity: 0.08, shadowRadius: 10, elevation: 2 },
  sceneIco: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sceneIcoTxt: { color: '#FFF', fontSize: 19 },
  sceneTitle: { color: t.text, fontSize: 14, fontWeight: '800', marginTop: 10 },
  sceneDesc: { color: t.sub, fontSize: 11, lineHeight: 16, marginTop: 4 },
  /* board */
  board: { width: '100%', backgroundColor: t.card, borderRadius: 14, padding: 9, marginBottom: 0,
    shadowColor: '#3A4270', shadowOpacity: 0.10, shadowRadius: 10, elevation: 2 },
  boardCover: { alignSelf: 'center', width: '100%', height: 92 },
  boardPlay: { position: 'absolute', right: 20, top: 20, width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(109,94,252,0.94)', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, elevation: 3 },
  boardPlayTxt: { color: '#FFF', fontSize: 14, marginLeft: 1 },
  boardTitle: { color: t.text, fontSize: 13, fontWeight: '800', marginTop: 8 },
  boardSub: { color: t.sub, fontSize: 10, marginTop: 2 },
  /* song card */
  songCard: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.card,
    borderRadius: 18, padding: 12, marginBottom: 12 },
  songBody: { flex: 1, minWidth: 0 },
  songTitle: { color: t.text, fontSize: 18, fontWeight: '800' },
  songArtist: { color: t.sub, fontSize: 13, marginTop: 3 },
  songBtn: { width: 40, height: 44, borderRadius: 12, borderWidth: 1, borderColor: t.line,
    alignItems: 'center', justifyContent: 'center' },
  songBtnPlay: { color: t.text, fontSize: 16 },
  songBtnIco: { color: t.sub, fontSize: 18 },
  /* sheet
     ★ 十期 P2-23：旧版整套浮层写死纯白 + 深灰字，深色主题下白得刺眼、与全屏沉浸割裂。
       Sheet 本来就收 t，现在主底色/文字/描边/按钮全部跟随 t。 */
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheetMask: { ...StyleSheet.absoluteFillObject, backgroundColor: t.overlay, zIndex: 1 },
  // ★ 三期修 ④：Android 上层遮罩可能盖住内容点击，给 sheet 明确抬层
  sheet: { backgroundColor: t.card, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    maxHeight: '88%', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 12,
    zIndex: 2, elevation: 12 },
  /* ★ 十期 P0-5：浮层内 Toast（Modal 是独立窗口，底层 msg 完全看不见） */
  sheetToast: { position: 'absolute', bottom: 18, left: 18, right: 18, zIndex: 20,
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 999, backgroundColor: '#1E8F63',
    shadowColor: '#125E42', shadowOpacity: 0.36, shadowRadius: 14, elevation: 8 },
  sheetToastTick: { width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.24)',
    alignItems: 'center', justifyContent: 'center' },
  sheetToastTickTxt: { color: '#FFF', fontSize: 12, fontWeight: '800' },
  sheetToastTxt: { flex: 1, color: '#FFF', fontSize: 13, fontWeight: '700' },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetBadge: { backgroundColor: t.chipOff, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 7 },
  sheetBadgeTxt: { color: t.brand, fontSize: 13, fontWeight: '700' },
  sheetClose: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, borderColor: t.line,
    alignItems: 'center', justifyContent: 'center' },
  sheetCloseTxt: { color: t.sub, fontSize: 18 },
  sheetTitle: { color: t.text, fontSize: 30, fontWeight: '800', marginTop: 16, marginBottom: 16 },
  sheetSub: { color: t.sub, fontSize: 13, marginTop: -8, marginBottom: 14 },
  sheetActions: { flexDirection: 'row', gap: 10, marginBottom: 14, alignItems: 'center' },
  sheetLine: { height: 1, backgroundColor: t.line, marginBottom: 6 },
  sheetBody: { flexGrow: 0 },
  shBtn: { borderWidth: 1, borderColor: t.line, borderRadius: 12, paddingHorizontal: 16,
    paddingVertical: 11, alignItems: 'center' },
  shBtnPrimary: { backgroundColor: t.brand, borderColor: t.brand, shadowColor: t.brand,
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 3 },
  shBtnTxt: { color: t.text, fontSize: 15, fontWeight: '700' },
  shBtnTxtPrimary: { color: '#FFF' },
  /* list row */
  listMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  listCacheBtn: { paddingHorizontal: 6, paddingVertical: 8, justifyContent: 'center' },
  listPlayBtn: { paddingHorizontal: 6, paddingVertical: 8, justifyContent: 'center' },
  /** ★ 全项目重审 A：父 bigCardMain 有 padding:15，absoluteFill + width/height:'100%'
   *    会按 content box 缩水 → 大卡封面右侧/底部各露 30dp 底色（与图37 竖带同源）。
   *    改纯 absoluteFillObject 才铺满 padding box。全工程 AST 扫描发现，非视觉改版。 */
  cardBgImg: { ...StyleSheet.absoluteFillObject },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: t.line },
  listNum: { color: t.dim, fontSize: 14, width: 26 },
  listNumOn: { color: t.brand, fontWeight: '800' },
  listBody: { flex: 1, minWidth: 0 },
  listTitle: { color: t.text, fontSize: 17, fontWeight: '700' },
  listTitleOn: { color: t.brand, fontWeight: '800' },        // ★ P1-13 播放中标当前曲
  listArtist: { color: t.sub, fontSize: 13, marginTop: 3 },
  listCache: { color: t.dim, fontSize: 17, width: 28, textAlign: 'center' },
  listPlay: { color: t.blue, fontSize: 18, width: 28, textAlign: 'center' },
  /* chips / sections / stats */
  chip: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999,
    backgroundColor: t.chipOff, marginRight: 8, marginBottom: 8 },
  chipOn: { backgroundColor: t.chipOn },
  chipTxt: { color: t.sub, fontSize: 14, fontWeight: '600' },
  chipTxtOn: { color: '#FFF' },
  sec: { flexDirection: 'row', alignItems: 'center', marginTop: 22, marginBottom: 12, gap: 9 },
  secBar: { width: 4, height: 19, borderRadius: 2, backgroundColor: t.brand },
  secTitle: { color: t.text, fontSize: 21, fontWeight: '800', flex: 1 },
  secRight: { color: t.brand, fontSize: 13 },
  stat: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    backgroundColor: t.card, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8 },
  statLabel: { color: t.sub, fontSize: 14 },
  statValue: { color: t.text, fontSize: 15, fontWeight: '700', maxWidth: '62%' },
  empty: { color: t.dim, fontSize: 14, textAlign: 'center', paddingVertical: 30 },
})
