/**
 * 我的页 —— 三期完全重做（参考 QQ 音乐 / 酷狗「我的」版式，浅色）
 *
 * ★ 只留三个入口：缓存记录 / 我喜欢的歌 / 自建歌单（保持占位）。
 * ★ 旧工具区整块删除；数字卡、设置入口、补货、音质项全部去掉。
 * ★ 新增「全链路检查」（纯只读诊断 + 刷新列表），不写主链、不记画像。
 * ★ L：手动换源入口是「最后无可奈何的退路」，不摆前台。顶部卡改纯展示
 *   （原来整块 TouchableOpacity + 右箭头 ›，单点零跳转，误导用户），
 *   连点 5 次入口单独挪到页面最底部一行极淡小字、无箭头/无图标/无卡片/无引导语。
 *
 * 主界面不再出现任何品牌 / APP 名字样。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native'
import { type Tokens } from '@/theme/mc'
import OriginalSettings from '@/screens/Home/Views/Setting/Vertical/Main'
import { FullModal, Sheet, SongRow, type SheetTrack } from '@/components/mc/UI'
import { getFavoriteTracks, getHistory } from '@/components/mc/upstream'
import { MODES, stats } from '@/components/mc/catalog'
import { centerBaseUrl, readGate } from '@/components/mc/connection'
import { sourceReady } from '@/components/mc/autoSource'
import {
  cachedToSheet, listCached, clearAllCached, type CachedItem,
} from '@/components/mc/localCache'
import { type PlayerView } from '@/components/mc/usePlayer'

type Tab = '缓存记录' | '我喜欢的歌' | '自建歌单'
const TABS: Array<{ key: Tab, icon: string, color: string }> = [
  { key: '缓存记录', icon: '↓', color: '#6D5EFC' },
  { key: '我喜欢的歌', icon: '♥', color: '#FF5470' },
  { key: '自建歌单', icon: '☰', color: '#22B87A' },
]

/** ★ 十期 P0-1：与刷歌/推荐一致，切 Tab 卸载重挂后保留用户选中的分类。 */
let sessionTab: Tab = '我喜欢的歌'

const toSheet = (x: any): SheetTrack => ({
  id: String(x.id ?? x.songmid ?? ''),
  title: String(x.title ?? x.name ?? ''),
  artist: String(x.artist ?? x.singer ?? ''),
  album: String(x.album ?? x.albumName ?? ''),
  duration: Number(x.duration || 0),
  cover: String(x.cover ?? x.pic ?? ''),
  // 缓存本地条目必须带 localPath，否则点播会走在线取链
  localPath: x.localPath,
  raw: x.raw ?? x,
})

export default ({ t, player, onPlay, refreshTick }: {
  t: Tokens; player: PlayerView; onPlay: (t: SheetTrack) => void
  refreshTick: number
}) => {
  const s = useMemo(() => makeStyles(t), [t])
  const [tab, setTabRaw] = useState<Tab>(sessionTab)
  const setTab = (v: Tab) => { sessionTab = v; setTabRaw(v) }
  const [rev, setRev] = useState(0)
  const [favs, setFavs] = useState<SheetTrack[]>([])
  const [hist, setHist] = useState<SheetTrack[]>([])
  const [cached, setCached] = useState<CachedItem[]>([])
  const [st, setSt] = useState(stats())
  const [diag, setDiag] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * ★ 五期自查⑤：入口完全隐藏 = 用户永远不知道它存在，自动选源一旦失效就无处换源。
   *   从第 3 次起给一行轻提示「再点 N 次可进入设置」，2 秒自动消失；
   *   不占常驻 UI、不额外加按钮。timeout 用 ref 管理并在卸载时清理，防泄漏。
   */
  const [tapHint, setTapHint] = useState('')
  // ★ 七期⑥：RN 的 setTimeout 返回 number，若工程 tsconfig 混入 @types/node，
  //   ReturnType<typeof setTimeout> 会推成 NodeJS.Timeout → clearTimeout 参数类型冲突。
  const hintTimer = useRef<any>(null)
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current) }, [])

  /** ★ 隐藏入口：2 秒内连点头像 5 次 → 原装设置（手动换自定义音源） */
  const tapRef = useRef({ count: 0, at: 0 })
  const onAvatar = () => {
    const now = Date.now()
    const r = tapRef.current
    r.count = (now - r.at < 2000) ? r.count + 1 : 1
    r.at = now
    if (r.count >= 5) {
      r.count = 0; setTapHint('')
      if (hintTimer.current) clearTimeout(hintTimer.current)
      setSettingsOpen(true)
      return
    }
    if (r.count >= 3) {
      setTapHint(`再点 ${5 - r.count} 次可进入设置`)
      if (hintTimer.current) clearTimeout(hintTimer.current)
      hintTimer.current = setTimeout(() => setTapHint(''), 2000)
    }
  }

  useEffect(() => {
    let alive = true
    void (async() => {
      const f = getFavoriteTracks().map(toSheet)
      const h = (await getHistory()).map(toSheet)
      const c = await listCached().catch(() => [] as CachedItem[])
      if (!alive) return
      setFavs(f); setHist(h); setCached(c); setSt(stats())
    })()
    return () => { alive = false }
  }, [rev, refreshTick, player.track?.id])

  const cachedSheets = cached.map(cachedToSheet)
  const list = tab === '我喜欢的歌' ? favs
    : tab === '缓存记录' ? cachedSheets
      : []   // 自建歌单保持占位

  /**
   * ★ 七期⑤：旧版 `onRefresh()` 会 bump 主壳 tick → 推荐页 useEffect 重新
   *   `pick()`（默认 Math.random）→ 用户点一次「只读诊断」，推荐页的曲库列表、
   *   为你推荐、卡片封面全换一批，名不副实还乱跳。改为只刷新本页。
   *   同时诊断数字改为**实时读取**，不再用可能滞后的渲染闭包值。
   */
  const openFullCheck = async() => {
    setRev(v => v + 1)
    const gate = await readGate()
    const ready = await sourceReady()
    const c = await listCached().catch(() => [] as CachedItem[])
    const f = getFavoriteTracks()
    const h = await getHistory().catch(() => [] as any[])
    const st2 = stats()
    setDiag(`设备 ID：${gate?.deviceId || '未配置'}\n` +
      `中心地址：${centerBaseUrl()}\n` +
      `音源总闸：${ready ? '就绪' : '未就绪'}\n` +
      `本地曲库：${st2.count} 首（目标 ${st2.target} / 上限 ${st2.max}）\n` +
      `缓存本地：${c.length} 首 · 收藏：${f.length} 首 · 最近播放：${h.length} 首\n` +
      `推荐档位：${MODES.map(m => m.label).join(' / ')}\n` +
      `管控：服务端停发新源，本机已导入源照常可播\n\n` +
      `音源每 300 秒自动同步一次，内容变更才替换、不重装、不打断播放；\n` +
      `切到后台再回到前台会立即复检一次（等同于立即重取）。\n\n` +
      `取链、播放、进度、歌词、通知栏全部由洛雪原装负责。`)
  }

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
        {/* ★ L：顶部卡纯展示。删掉整块 Touchable + 右箭头 ›，
            不再把「连点 5 次进设置」这个退路摆在前台首要位置。 */}
        <View style={s.hero}>
          <View style={s.avatar}><Text style={s.avatarTxt}>我</Text></View>
          <View style={s.heroBody}>
            <Text style={s.heroTitle}>我的音乐</Text>
            <Text style={s.heroSub}>{favs.length} 首喜欢 · {cached.length} 首已缓存</Text>
          </View>
        </View>

        {/* 三个大入口（只留这三个） */}
        <View style={s.entryRow}>
          {TABS.map(x => (
            <TouchableOpacity key={x.key} style={[s.entry, tab === x.key && s.entryOn]}
              onPress={() => setTab(x.key)} activeOpacity={0.85}>
              <View style={[s.entryIco, { backgroundColor: x.color }]}>
                <Text style={s.entryIcoTxt}>{x.icon}</Text>
              </View>
              <Text style={s.entryTxt}>{x.key}</Text>
              <Text style={s.entryNum}>{x.key === '缓存记录' ? cached.length
                : x.key === '我喜欢的歌' ? favs.length : 0}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 列表 */}
        <View style={s.listHead}>
          <View style={s.secBar} />
          <Text style={s.listTitle}>{tab}</Text>
          <Text style={s.listCount}>{list.length} 首</Text>
        </View>
        <View style={s.whiteCard}>
          {list.length ? list.slice(0, 60).map((tr, i) => (
            <SongRow key={tr.id + i} t={t} track={tr} index={i}
              current={player.track?.id === tr.id} onPress={() => onPlay(tr)} />
          )) : <Text style={s.empty}>
            {tab === '自建歌单' ? '暂无自建歌单'
              : tab === '缓存记录' ? '还没有缓存本地的歌曲，去推荐页搜索或曲库列表点 ↓'
                : '还没有喜欢的歌曲，听歌时点 ♥ 收藏'}
          </Text>}
        </View>

        {tab === '缓存记录' && cached.length ? (
          <TouchableOpacity style={s.clearBtn} onPress={() => {
            // ★ 十期 P0-8：旧版点一下就全删、无确认，且 N 首 = N 次全量写盘
            Alert.alert(
              '清空缓存本地',
              `将删除已缓存的 ${cached.length} 首歌曲（APP 私有目录），此操作不可恢复。`,
              [
                { text: '取消', style: 'cancel' },
                { text: '确认清空', style: 'destructive', onPress: () => {
                  void (async() => {
                    await clearAllCached()
                    setCached(await listCached())
                    setRev(v => v + 1)
                  })()
                } },
              ],
            )
          }}>
            <Text style={s.clearTxt}>清空缓存本地（{cached.length} 首）</Text>
          </TouchableOpacity>
        ) : null}

        {/* ★ 新增：全链路检查（顶栏/菜单全删后唯一的工具按钮） */}
        <TouchableOpacity style={s.checkBtn}
          onPress={() => void openFullCheck().catch(() => setDiag('诊断读取失败，请重试'))} activeOpacity={0.88}>
          <View style={s.checkIco}><Text style={s.checkIcoTxt}>◎</Text></View>
          <View style={s.checkBody}>
            <Text style={s.checkTitle}>全链路检查</Text>
            <Text style={s.checkSub}>设备 · 中心 · 音源 · 曲库 · 缓存 · 收藏（只读）</Text>
          </View>
          <Text style={s.checkArrow}>›</Text>
        </TouchableOpacity>

        <Text style={s.note}>收藏与「我喜欢的音乐」互通；缓存本地存于 APP 私有目录，卸载即清除。不记口味画像、不收集听歌行为。</Text>

        {/* ★ L：退路单独放在页面最底部。极淡小字、无箭头/无图标/无卡片/无引导语，
            不主动提示「再点 N 次」；tapHint 只在用户连点过程中短暂出现。
            入口保留不删 —— 服务端换源失败时卸载重装是主路径，但这条最后退路仍在。 */}
        <TouchableOpacity onPress={onAvatar} activeOpacity={1} style={s.hiddenEntry}
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
          <Text style={s.hiddenTxt} numberOfLines={1} allowFontScaling={false}>
            {tapHint || '设置'}
          </Text>
        </TouchableOpacity>
        <View style={{ height: 24 }} />
      </ScrollView>

      <Sheet visible={!!diag} title="全链路检查" badge="只读信息" onClose={() => setDiag(null)} t={t}>
        <Text style={s.diagTxt}>{diag}</Text>
        <View style={{ height: 18 }} />
      </Sheet>

      {/* 隐藏入口：原装设置组件直接渲染，不注册 RNN screen、不改导航注册、零破封 */}
      <FullModal visible={settingsOpen} title="设置" t={t} onClose={() => setSettingsOpen(false)}>
        <OriginalSettings />
      </FullModal>
    </View>
  )
}

const makeStyles = (t: Tokens) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  pad: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 96 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: t.card,
    borderRadius: 20, padding: 18, marginBottom: 18,
    shadowColor: '#2B2F52', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: t.brand,
    alignItems: 'center', justifyContent: 'center' },
  avatarTxt: { color: '#FFF', fontSize: 26, fontWeight: '800' },
  heroBody: { flex: 1 },
  heroTitle: { color: t.text, fontSize: 22, fontWeight: '800' },
  heroSub: { color: t.sub, fontSize: 13, marginTop: 5 },
  heroArrow: { color: t.dim, fontSize: 24 },
  heroHint: { color: t.brand, fontSize: 11, maxWidth: 110, textAlign: 'right' },
  entryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 22 },
  entry: { width: '31%', backgroundColor: t.card, borderRadius: 18, paddingVertical: 16,
    alignItems: 'center', borderWidth: 1.5, borderColor: 'transparent' },
  entryOn: { borderColor: t.brand, backgroundColor: t.card2 },
  entryIco: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  entryIcoTxt: { color: '#FFF', fontSize: 22, fontWeight: '700' },
  entryTxt: { color: t.text, fontSize: 12, fontWeight: '700', marginTop: 10 },
  entryNum: { color: t.dim, fontSize: 12, marginTop: 3 },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  secBar: { width: 4, height: 18, borderRadius: 2, backgroundColor: t.brand },
  listTitle: { color: t.text, fontSize: 18, fontWeight: '800' },
  listCount: { marginLeft: 'auto', color: t.dim, fontSize: 12 },
  whiteCard: { backgroundColor: t.card, borderRadius: 18, paddingHorizontal: 12 },
  empty: { color: t.dim, fontSize: 14, textAlign: 'center', paddingVertical: 34 },
  clearBtn: { borderWidth: 1, borderColor: t.red, borderRadius: 14,
    paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  clearTxt: { color: t.red, fontSize: 14, fontWeight: '700' },
  checkBtn: { flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: t.card, borderRadius: 18, padding: 15, marginTop: 22,
    shadowColor: '#2B2F52', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  checkIco: { width: 44, height: 44, borderRadius: 14, backgroundColor: '#EDE9FF',
    alignItems: 'center', justifyContent: 'center' },
  checkIcoTxt: { color: t.brand, fontSize: 22 },
  checkBody: { flex: 1 },
  checkTitle: { color: t.text, fontSize: 16, fontWeight: '800' },
  checkSub: { color: t.sub, fontSize: 12, marginTop: 4 },
  checkArrow: { color: t.dim, fontSize: 22 },
  note: { color: t.dim, fontSize: 11, lineHeight: 18, marginTop: 16 },
  hiddenEntry: { alignSelf: 'center', marginTop: 26, paddingVertical: 6, paddingHorizontal: 18 },
  hiddenTxt: { color: t.dim, fontSize: 10, letterSpacing: 1, opacity: 0.32 },
  diagTxt: { color: t.sub, fontSize: 14, lineHeight: 23, paddingVertical: 8 },  // ★ P2-24 不再写死中灰
})
