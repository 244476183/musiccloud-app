/**
 * 推荐页 —— 按废弃版真机截图复刻：
 * 搜索框 / 猜你喜欢+每日推荐 大卡 / TOP500+常听歌手 横卡 / 场景横滑 /
 * 热门榜单 2×2 / 单曲推荐卡 / 4 档曲库；浮层复刻「猜你喜欢」「每日推荐 30 首」。
 * 所有播放走 onPlay（原装 getMusicUrl + setResource），本页零播放器状态。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, ActivityIndicator,
} from 'react-native'
import { type Tokens } from '@/theme/mc'
import {
  BigEntryCard, BoardCard, Chip, Cover, SceneCard, SectionTitle, SheetButton,
  SongListSheet, SongRow, type SheetTrack,
} from '@/components/mc/UI'
import { MODES, bootstrap, pick, pickDaily, pickGuess, snapshot, stats, type Track, type Mode } from '@/components/mc/catalog'
import { searchTracks } from '@/components/mc/upstream'
import { cacheLocal, isCached } from '@/components/mc/localCache'
import { type PlayerView } from '@/components/mc/usePlayer'

const toSheet = (t: Track): SheetTrack => ({
  id: t.id, title: t.title, artist: t.artist, album: t.album,
  duration: t.duration, cover: t.cover, raw: t.raw,
})

type SheetKey = 'guess' | 'daily' | 'board' | null

/**
 * ★ 十期全面核查 P0-1（最影响日常）：McShell 用条件渲染，切 Tab 即卸载本页，
 *   旧版 mode / query / results / list / one 全是组件内 useState → 切走回来全部复位
 *   （选的 DJ 档变均衡、搜过的词和结果清空）。刷歌页早用模块级会话态保住了，这里补上。
 *   只存「用户选出来的状态」，不存浮层/加载态，避免跨会话残留弹窗。
 */
let sessionMode: Mode = 'balanced'
let sessionQuery = ''
let sessionResults: SheetTrack[] | null = null
let sessionList: SheetTrack[] = []
let sessionOne: SheetTrack | null = null
/** ★ 十期第二轮自查：切 Tab 重挂载时 useEffect 会再跑一次 refresh → 曲库展示列表又换一批。
 *  用模块级 key 记住「上次取的是哪个 mode/rev/tick」，重挂载且 key 未变就直接沿用会话列表。 */
let lastRefreshKey = ''
/** ★ 十一期：rev 升模块级，切 Tab 重挂载不再归 0 → 不会「回来无故换一批」。 */
let sessionRev = 0

/** ★ F-05：去掉与上方两张小卡重复的 TOP500 / 常听歌手，扩到 8 张（含「新歌速递」）。 */
const BOARDS: Array<{ title: string, sub: string, seed: string, mode: Mode }> = [
  { title: '飙升榜', sub: '实时 · 全网', seed: '飙升榜', mode: 'fresh' },
  { title: '私人雷达', sub: '独立算法 · DJ', seed: '私人雷达', mode: 'dj' },
  { title: '新歌速递', sub: '最新上线', seed: '新歌速递', mode: 'fresh' },
  { title: '影视原声', sub: 'OST · 剧集', seed: '影视原声', mode: 'balanced' },
  { title: '国风集', sub: '古风 · 戏腔', seed: '国风集', mode: 'familiar' },
  { title: '说唱现场', sub: 'Hip-Hop · Live', seed: '说唱现场', mode: 'dj' },
  { title: '轻音乐', sub: '纯音 · 放松', seed: '轻音乐', mode: 'balanced' },
  { title: '深夜电台', sub: '夜听 · 慢歌', seed: '深夜电台', mode: 'familiar' },
]

const SCENES = [
  { icon: '✦', title: '随便听听', desc: '按你现在的\n状态自动配', color: '#7C5CFF', mode: 'balanced' as Mode },
  { icon: '☾', title: '深夜', desc: '慢下来，留给\n自己的时间', color: '#D94FA0', mode: 'familiar' as Mode },
  { icon: '◐', title: '通勤', desc: '刚好够一段\n路上的时间', color: '#22AEE0', mode: 'fresh' as Mode },
]

/** ★ F-11：叠列小卡（酷狗形态里的「2 张小卡叠成一列」）。
 *  并列结构：主体 Touchable 与 ▶ 各一个 sibling，不嵌套，避免 RN 双触发。 */
const StackMini = ({ t, s, title, sub, bg, cover, onPress, onQuickPlay }: {
  t: Tokens; s: any; title: string; sub: string; bg: string; cover?: string
  onPress: () => void; onQuickPlay: () => void
}) => (
  <View style={[s.miniCell, { backgroundColor: bg }]}>
    <TouchableOpacity style={s.miniCellMain} onPress={onPress} activeOpacity={0.88}>
      <Cover uri={cover} title={title} size={36} radius={9} t={t} />
      <View style={s.miniCellBody}>
        <Text style={s.miniCellTitle} numberOfLines={1}>{title}</Text>
        <Text style={s.miniCellSub} numberOfLines={1}>{sub}</Text>
      </View>
    </TouchableOpacity>
    <TouchableOpacity style={s.miniCellPlay} onPress={onQuickPlay} activeOpacity={0.85}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
      <Text style={s.miniCellPlayTxt}>▶</Text>
    </TouchableOpacity>
  </View>
)

const dateLabel = () => {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 · ${week} · 30 首`
}

export default ({ t, player, onPlay, onPlayBatch, refreshTick }: {
  t: Tokens; player: PlayerView; onPlay: (t: SheetTrack) => void
  /** ★ 十一期：卡片 ▶ / 浮层「播放全部」走批次播放（原装 tempPlayList） */
  onPlayBatch: (tracks: SheetTrack[], shuffle: boolean) => void
  refreshTick: number
}) => {
  const s = useMemo(() => makeStyles(t), [t])
  const [mode, setModeRaw] = useState<Mode>(sessionMode)
  const [list, setList] = useState<SheetTrack[]>(sessionList)
  const [one, setOne] = useState<SheetTrack | null>(sessionOne)
  const [query, setQuery] = useState(sessionQuery)
  const [results, setResults] = useState<SheetTrack[] | null>(sessionResults)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  /** ★ 十期 P0-5：浮层内反馈（Modal 独立窗口，底层 msg 完全看不见） */
  const [sheetToast, setSheetToast] = useState('')
  const toastTimer = useRef<any>(null)
  const msgTimer = useRef<any>(null)
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    if (msgTimer.current) clearTimeout(msgTimer.current)
  }, [])
  const showMsg = (text: string) => {
    setMsg(text)
    if (msgTimer.current) clearTimeout(msgTimer.current)
    // ★ P1-20：旧版提示要手点才消失，切歌/切页还残留
    msgTimer.current = setTimeout(() => setMsg(''), 3200)
  }
  const showToast = (text: string) => {
    setSheetToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setSheetToast(''), 2600)
  }
  const setMode = (m: Mode) => { sessionMode = m; setModeRaw(m) }
  const setQueryPersist = (v: string) => { sessionQuery = v; setQuery(v) }
  const setResultsPersist = (v: SheetTrack[] | null) => { sessionResults = v; setResults(v) }
  const [sheet, setSheet] = useState<SheetKey>(null)
  const [sheetTracks, setSheetTracks] = useState<SheetTrack[]>([])
  const [sheetTitle, setSheetTitle] = useState('')
  const [sheetBadge, setSheetBadge] = useState('')
  const [sheetMode, setSheetMode] = useState<Mode>('balanced')
  const [st, setSt] = useState(stats())
  const [rev, setRev] = useState(sessionRev)
  const bumpRev = () => { sessionRev += 1; setRev(sessionRev) }

  const refresh = async(m: Mode) => {
    setBusy(true)
    try {
      // ★ 五期自查③：与刷歌页一致，全新安装冷启空池时等同一轮灌池完成再重取
      let ts = await pick(m, 8)
      if (!ts.length) { await bootstrap(); ts = await pick(m, 8) }
      sessionList = ts.map(toSheet)
      sessionOne = ts.length ? toSheet(ts[0]) : null
      setList(sessionList); setOne(sessionOne)
      setSt(stats())
    } catch (e: any) { showMsg(String(e?.message || e)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    const key = `${mode}|${rev}|${refreshTick}`
    const userKey = `${mode}|${rev}`
    if (lastRefreshKey === key) { setSt(stats()); return }
    /**
     * ★ 十一期深度自查 P1-5：McShell 的 autoRestock() 完成会 setTick → refreshTick 变。
     *   旧版这会触发 refresh() 重取，推荐列表「自己换一批」—— 用户明确问过
     *   「是否每隔一段时间自动换一批」，答案是不会。现在只有用户主动改档位 / 点换一批
     *   （mode|rev 变化）才重取列表；自动补货完成只刷新曲库数字与卡片封面（covers 仍依赖 tick）。
     */
    const prevUserKey = lastRefreshKey ? lastRefreshKey.split('|').slice(0, 2).join('|') : ''
    lastRefreshKey = key
    if (prevUserKey === userKey && sessionList.length) { setSt(stats()); return }
    void refresh(mode)
  }, [mode, rev, refreshTick])

  const dateKey = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  /** 三种来源：猜你喜欢＝最近播放共现加权；每日推荐＝日期种子当天稳定；榜单＝4 档重排。 */
  const querySheet = (k: SheetKey, m: Mode, n: number) =>
    k === 'guess' && m === 'balanced' ? pickGuess(n)
      : k === 'daily' ? pickDaily(dateKey(), n)
        : pick(m, n)

  const fillSheet = async(k: SheetKey, m: Mode, n: number) => {
    setBusy(true)
    try {
      /**
       * ★ 六期自查①（最要紧）：全新安装冷启、bootstrap 还在异步灌池时，
       *   用户**先点两张大卡** → pickGuess/pickDaily 拿到空池 → 浮层显示
       *   「曲库还在补货，稍等一下」，且没有 refreshTick 变化就**永远不再重取**。
       *   刷歌页 / 推荐页列表早有 await bootstrap 兜底，浮层这条漏了。
       *   这里与它们一致：等同一轮灌池完成，再按原来源重查一次。
       */
      let ts = await querySheet(k, m, n)
      if (!ts.length) { await bootstrap(); ts = await querySheet(k, m, n) }
      setSheetTracks(ts.map(toSheet))
    } catch (e: any) { showMsg(String(e?.message || e)) }
    finally { setBusy(false) }
  }

  const openSheet = (k: SheetKey, m: Mode, title: string, badge: string, n = 30) => {
    setSheet(k); setSheetMode(m); setSheetTitle(title); setSheetBadge(badge)
    void fillSheet(k, m, n)
  }

  /** 单曲缓存到 APP 私有目录（UI 一律叫「缓存本地」）
   *  ★ 十期 P0-5 / P1-19：反馈同时给主页面 msg 和浮层 toast；
   *    重复缓存不再静默「3 → 3 首」，明确告知已在本地。 */
  const doCache = async(tr: SheetTrack) => {
    setBusy(true); setMsg('')
    try {
      const already = await isCached(tr.id).catch(() => false)
      await cacheLocal(tr)
      const text = already ? `已在缓存本地 · ${tr.title}` : `已缓存本地 · ${tr.title}`
      showMsg(text); showToast(text)
    } catch (e: any) {
      const text = '缓存本地失败：' + String(e?.message || e)
      showMsg(text); showToast(text)
    } finally { setBusy(false) }
  }

  /** 浮层「缓存本地」：串行缓存前 8 首，避免 30 首并发把取链打挂。 */
  const cacheBatch = async() => {
    setBusy(true); setMsg('')
    let done = 0
    const batch = sheetTracks.slice(0, 8)
    try {
      for (let i = 0; i < batch.length; i++) {
        showToast(`正在缓存本地 ${i + 1}/${batch.length} …`)
        try { await cacheLocal(batch[i]); done++ } catch (_) { /* 单首失败不影响其它 */ }
      }
      const text = `已缓存本地 ${done} 首，可在「我的 → 缓存记录」查看`
      showMsg(text); showToast(text)
    } finally { setBusy(false) }
  }

  const doSearch = async() => {
    const q = query.trim()
    if (!q) { setResultsPersist(null); return }
    setBusy(true); setMsg('')
    try {
      const r = await searchTracks(q, 30)
      setResultsPersist(r.map(x => ({ id: x.id, title: x.title, artist: x.artist, album: x.album,
        duration: x.duration, cover: x.cover, raw: x.raw })))
      if (!r.length) showMsg('没搜到，换个关键词试试')
    } catch (e: any) { showMsg('搜索失败：' + String(e?.message || e)) }
    finally { setBusy(false) }
  }

  const playAndClose = (tr: SheetTrack) => { setSheet(null); onPlay(tr) }

  /**
   * ★ 十一期：卡片 ▶ / 场景卡 —— 取该卡对应的一批歌，直接打乱播放（随机起点的播放全部）。
   *   场景卡只走这里，不弹浮层；其余卡片主体仍进浮层自选。
   *   冷启空池时等同一轮 bootstrap，再不行给人话提示，绝不静默无反应。
   */
  const quickPlay = async(k: SheetKey, m: Mode, n = 30) => {
    setMsg('')
    try {
      let ts = await querySheet(k, m, n)
      if (!ts.length) { await bootstrap(); ts = await querySheet(k, m, n) }
      if (!ts.length) { showMsg('曲库正在自动补货，稍等一下再点'); return }
      onPlayBatch(ts.map(toSheet), true)
      showMsg(`已开始播放 · ${k === 'board' ? '按场景' : '该卡'}随机 ${ts.length} 首`)
    } catch (e: any) { showMsg(String(e?.message || e)) }
  }

  /** 浮层「▶ 播放全部」：按列表顺序整批续播，播完这批自动停。 */
  const playAllAndClose = (tracks: SheetTrack[]) => { setSheet(null); onPlayBatch(tracks, false) }

  /**
   * ★ 三期修 ⑤：卡片封面全空不是 bug，是旧版压根没传 uri。
   *   从曲库里取真实 CDN 封面按位分配，卡片尺寸/圆角/文字位置全不变，只换材质。
   *   取不到时 UI.tsx 的 Cover / Image 自动回退几何封面。
   */
  /**
   * ★ 九期（封面修复②，修正七期④的副作用）：七期为治「封面乱跳」改成只取
   *   snapshot().slice(0,8)，但冷启第一批恰好最可能没封面 → 一张都没有时
   *   整页卡片全空，反而放大了「大部分封面都没有」。
   *   改为从**全池**筛出有图的取前 8 张（池子顺序稳定，仍不随随机列表抖）；
   *   deps 带上 player.track?.id，播放回填封面后（McShell → backfillCover）自动补上。
   *   全池真的没图才返回 ['']，由 Cover / 大卡几何兜底，永不空白。
   */
  /** ★ 十一期：去掉 player.track?.id 依赖 —— 旧版一切歌大卡封面就整批换，
   *  用户以为「推荐页每隔一段时间自动换一批」。改为只随曲库池内容 / 数量变化。 */
  const covers = useMemo(() => {
    const all = snapshot().map(x => String(x.cover || '')).filter(Boolean).slice(0, 8)
    return all.length ? all : ['']
  }, [refreshTick, st.count])
  const cv = (i: number) => covers[i % covers.length]

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
        {/* 搜索框 */}
        <View style={s.searchBox}>
          <Text style={s.searchIco}>⌕</Text>
          <TextInput style={s.input} value={query} onChangeText={setQueryPersist}
            placeholder="搜歌名、歌手..." placeholderTextColor={t.dim}
            returnKeyType="search" onSubmitEditing={() => void doSearch()} />
          {query ? (
            <TouchableOpacity onPress={() => { setQueryPersist(''); setResultsPersist(null) }}>
              <Text style={s.searchClear}>✕</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {busy ? <ActivityIndicator color={t.brand} style={{ marginVertical: 8 }} /> : null}

        {results ? (
          <>
            <SectionTitle t={t} right="清空" onRight={() => { setResultsPersist(null); setQueryPersist('') }}>
              搜索结果 · {results.length} 首
            </SectionTitle>
            <View style={s.whiteCard}>
              {results.map((tr, i) => (
                <SongRow key={tr.id + i} t={t} track={tr} index={i}
                  current={player.track?.id === tr.id} onPress={() => onPlay(tr)}
                  onCache={() => void doCache(tr)} />
              ))}
              {!results.length ? <Text style={s.empty}>暂无歌曲</Text> : null}
            </View>
          </>
        ) : (
          <>
            {/* ★ 本轮：全部固定位置，不再横滑。双大卡在上、双小卡在下。
                ▶ 仍直接播该卡批次，点其余区域进浮层自选（功能一字未动）。 */}
            <View style={s.bigRow}>
              <View style={s.bigItem}>
                <BigEntryCard t={t} variant="guess" title="猜你喜欢" sub="私人 DJ" cover={cv(0)}
                  badge="独立算法" onPress={() => openSheet('guess', 'balanced', '猜你喜欢', '独立算法 · 私人 DJ', 30)}
                  onQuickPlay={() => void quickPlay('guess', 'balanced', 30)} />
              </View>
              <View style={s.bigItem}>
                <BigEntryCard t={t} variant="daily" title="每日推荐" sub={dateLabel()} cover={cv(1)}
                  onPress={() => openSheet('daily', 'fresh', '每日推荐 30 首',
                    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`, 30)}
                  onQuickPlay={() => void quickPlay('daily', 'fresh', 30)} />
              </View>
            </View>
            <View style={s.miniRow}>
              <View style={s.miniItem}>
                <StackMini t={t} s={s} title="TOP500" sub="20 个榜单" bg="#3FA9E8" cover={cv(2)}
                  onPress={() => openSheet('board', 'familiar', 'TOP500 · 热门榜单', '实时 · 全网', 30)}
                  onQuickPlay={() => void quickPlay('board', 'familiar', 30)} />
              </View>
              <View style={s.miniItem}>
                <StackMini t={t} s={s} title="常听歌手" sub="按熟悉度" bg="#F5A24A" cover={cv(3)}
                  onPress={() => openSheet('board', 'balanced', '常听歌手', '按熟悉度排序', 30)}
                  onQuickPlay={() => void quickPlay('board', 'balanced', 30)} />
              </View>
            </View>

            {/* 场景横滑：★ 十一期：整卡直接播，不给自选浮层 */}
            <SectionTitle t={t}>按现在的场景听</SectionTitle>
            <View style={s.sceneRow}>
              {SCENES.map(x => (
                <SceneCard key={x.title} t={t} icon={x.icon} title={x.title} desc={x.desc}
                  color={x.color} onPress={() => void quickPlay('board', x.mode, 30)} />
              ))}
            </View>

            {/* ★ 本轮：8 张 2 列 × 4 行固定网格，不横滑（效果图 2 口径）。
                SectionTitle 不传 right，避免「带 › 却没 onRight」的假可点。 */}
            <SectionTitle t={t}>热门歌单</SectionTitle>
            <View style={s.boardGrid}>
              {BOARDS.map((b, i) => (
                <View key={b.title} style={s.boardCell}>
                  <BoardCard t={t} title={b.title} sub={b.sub} seed={b.seed} cover={cv(4 + i)}
                    onPress={() => openSheet('board', b.mode, `${b.title} · 热门榜单`, b.sub, 30)}
                    onQuickPlay={() => void quickPlay('board', b.mode, 30)} />
                </View>
              ))}
            </View>

            {/* ★ F-04：「为你推荐」「曲库」两区块已按要求删除。
                4 档选档能力仍在刷歌页档位浮层里完整保留，不构成能力倒退。 */}
          </>
        )}
        <View style={{ height: 20 }} />
      </ScrollView>

      {/*
        ★ 十期二轮①（本轮修复自己暴露的高频问题）：旧 msg 是 ScrollView 顶部一行 13px 小字，
          而这轮 P0-6 给「曲库列表」补了 ↓ —— 曲库列表恰在页面最底部，用户滚到底点缓存，
          反馈在顶部根本看不见；sheetToast 又只在浮层打开时才渲染。
          改成 root 内的悬浮 Snackbar：与滚动位置无关，主页面/搜索结果/曲库列表都看得见。
          浮层打开时由 Sheet 内的 toast 负责，两层互不干扰。
      */}
      {msg ? (
        <View style={s.snack} pointerEvents="none">
          <Text style={s.snackTxt} numberOfLines={2}>{msg}</Text>
        </View>
      ) : null}

      <SongListSheet visible={!!sheet} title={sheetTitle} badge={sheetBadge}
        tracks={sheetTracks} onClose={() => setSheet(null)}
        onPlay={playAndClose} onPlayAll={playAllAndClose}
        onBatch={() => {
          // ★ 十一期：daily 是日期种子、guess 是固定种子+最近播放，**两者都是确定性结果**，
          //   直接 fillSheet 原样返回同一批 → 点「换一批」毫无反应（十期只修了 daily，漏了 guess）。
          //   用户主动要换就改走 board 的随机重排，并同步 badge 免得名实不符。
          const deterministic = sheet === 'daily' || sheet === 'guess'
          if (deterministic) setSheetBadge('已换一批')
          void fillSheet(deterministic ? 'board' : sheet,
            deterministic ? 'balanced' : sheetMode, 30)
        }}
        onCache={tr => void doCache(tr)}
        playingId={player.track?.id} t={t} toast={sheetToast || undefined}
        extraActions={<SheetButton t={t} label="↓  缓存本地" onPress={() => void cacheBatch()} />}
        extraChip={sheet === 'guess' ? (
          <>
            <View style={s.sheetChipRow}>
              <Text style={s.sheetModeLabel}>{MODES.find(m => m.key === sheetMode)?.label}</Text>
            </View>
            {/* ★ 六期自查②：旧版切档传 'board'，浮层标题仍是「猜你喜欢」但内容已变成
                榜单重排 → 名实不符。保持 'guess' 来源，档位只改权重。 */}
            <View style={s.chips}>
              {MODES.map(m => (
                <Chip key={m.key} label={m.label} on={sheetMode === m.key} t={t}
                  onPress={() => { setSheetMode(m.key); void fillSheet('guess', m.key, 30) }} />
              ))}
            </View>
          </>
        ) : null} />
    </View>
  )
}

const makeStyles = (t: Tokens) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  pad: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 96 },
  // ★ 十期 P0-2：旧版写死 #FFF，深色主题下 t.text 是白字 → 输入完全看不见
  searchBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.card,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, gap: 9,
    shadowColor: '#3A4270', shadowOpacity: 0.08, shadowRadius: 10, elevation: 2 },
  searchIco: { color: t.dim, fontSize: 20 },
  input: { flex: 1, color: t.text, fontSize: 14, padding: 0 },
  searchClear: { color: t.dim, fontSize: 16 },
  /* ★ 十期二轮① 悬浮 Snackbar：bottom 96 避开悬浮 mini 条（16+62），不与它重叠 */
  snack: { position: 'absolute', left: 18, right: 18, bottom: 96, zIndex: 40,
    backgroundColor: t.isDark ? 'rgba(30,35,48,0.96)' : 'rgba(21,24,44,0.93)',
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16,
    shadowColor: '#000', shadowOpacity: 0.24, shadowRadius: 14, elevation: 8 },
  snackTxt: { color: '#FFF', fontSize: 13, fontWeight: '700', textAlign: 'center', lineHeight: 19 },
  row2: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  /* ★ 本轮：全部固定位置，尺寸/圆角/字阶统一收紧（不再横滑、不再过大） */
  bigRow: { flexDirection: 'row', gap: 12, marginTop: 14 },
  bigItem: { flex: 1, minWidth: 0 },
  miniRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  miniItem: { flex: 1, minWidth: 0 },
  miniCell: { height: 96, borderRadius: 14, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 10, gap: 8, overflow: 'hidden' },
  miniCellMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniCellBody: { flex: 1, minWidth: 0 },
  miniCellTitle: { color: '#FFF', fontSize: 13, fontWeight: '800' },
  miniCellSub: { color: 'rgba(255,255,255,.88)', fontSize: 10, marginTop: 3 },
  miniCellPlay: { width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.28)', alignItems: 'center', justifyContent: 'center' },
  miniCellPlayTxt: { color: '#FFF', fontSize: 11, marginLeft: 1 },
  sceneRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  boardGrid: { flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'space-between', marginBottom: 6 },
  boardCell: { width: '48.5%', marginBottom: 10 },
  whiteCard: { backgroundColor: t.card, borderRadius: 18, paddingHorizontal: 12, marginBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  sheetChipRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 4, marginTop: -6 },
  sheetModeLabel: { color: '#22B87A', fontSize: 14, fontWeight: '700' },
  empty: { color: t.dim, fontSize: 14, textAlign: 'center', paddingVertical: 26 },
  /* ★ 六期自查④：旧引导按钮已删，对应两条死样式清掉 */
  note: { color: t.dim, fontSize: 11, lineHeight: 17, marginTop: 14 },
})
