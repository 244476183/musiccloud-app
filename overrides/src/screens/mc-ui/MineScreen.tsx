/**
 * 我的页 —— 三期完全重做（参考 QQ 音乐 / 酷狗「我的」版式，浅色）
 *
 * ★ 只留三个入口：缓存记录 / 我喜欢的歌 / 自建歌单（保持占位）。
 * ★ 旧工具区整块删除；数字卡、设置入口、补货、音质项全部去掉。
 * ★ v30 / N：「全链路检查」只读诊断按钮 + Sheet 整体去掉，不再显示。
 * ★ v30 / O：头部「我的音乐」展示卡整体去掉，三个大入口直接作为页首。
 * ★ L：手动换源入口是「最后无可奈何的退路」，不摆前台、保留不删。
 *   连点 5 次入口单独放在页面最底部一行极淡小字、无箭头/无图标/无卡片/无引导语。
 *
 * 主界面不再出现任何品牌 / APP 名字样。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native'
import { type Tokens } from '@/theme/mc'
/**
 * ★ v31：底部退路不再挂整套原装设置，只留「自定义源」这一块。
 * ★ v32 / Q：进一步换成我方精简选源组件 SourcePicker —— 用户只能勾选哪个源启用，
 *   「自定义源管理」按钮（导入/删除/编辑/FAQ 外链）整个不给入口。
 *   原装 Source.tsx 在 upstream 冻结区，不能直接删按钮（破封），故在 overrides 内替换；
 *   仍复用原装 hook / CheckBox / setApiSource，切源行为一字不变，且少挂一整棵管理弹层。
 */
import SourcePicker from '@/screens/mc-ui/SourcePicker'
import { FullModal, SongRow, type SheetTrack } from '@/components/mc/UI'
import { getFavoriteTracks } from '@/components/mc/upstream'
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
  const [cached, setCached] = useState<CachedItem[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** ★ 隐藏入口：2 秒内连点底部小字 5 次 → 自定义源勾选页（最后退路） */
  const tapRef = useRef({ count: 0, at: 0 })
  const onAvatar = () => {
    const now = Date.now()
    const r = tapRef.current
    r.count = (now - r.at < 2000) ? r.count + 1 : 1
    r.at = now
    if (r.count >= 5) {
      r.count = 0
      setSettingsOpen(true)
      return
    }
  }

  useEffect(() => {
    let alive = true
    void (async() => {
      const f = getFavoriteTracks().map(toSheet)
      const c = await listCached().catch(() => [] as CachedItem[])
      if (!alive) return
      setFavs(f); setCached(c)
    })()
    return () => { alive = false }
  }, [rev, refreshTick, player.track?.id])

  const cachedSheets = cached.map(cachedToSheet)
  const list = tab === '我喜欢的歌' ? favs
    : tab === '缓存记录' ? cachedSheets
      : []   // 自建歌单保持占位

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
        {/* ★ v30 / O：头部「我的音乐」展示卡整体去掉，三个大入口直接作为页首。 */}
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

        <Text style={s.note}>收藏与「我喜欢的音乐」互通；缓存本地存于 APP 私有目录，卸载即清除。不记口味画像、不收集听歌行为。</Text>

        {/* ★ L：退路单独放在页面最底部。极淡小字、无箭头/无图标/无卡片/无引导语，
            不提示、不引导；入口保留不删 —— 服务端换源失败时卸载重装是主路径，
            这条最后的手动选源退路仍在。 */}
        <TouchableOpacity onPress={onAvatar} activeOpacity={1} style={s.hiddenEntry}
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
          <Text style={s.hiddenTxt} numberOfLines={1} allowFontScaling={false}>
            设置
          </Text>
        </TouchableOpacity>
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* ★ v32 / Q：只挂精简选源列表；底部小字退路、白底外壳、返回键全部不动。 */}
      <FullModal visible={settingsOpen} title="自定义源" t={t} onClose={() => setSettingsOpen(false)}>
        <SourcePicker />
      </FullModal>
    </View>
  )
}

const makeStyles = (t: Tokens) => StyleSheet.create({
  root: { flex: 1, backgroundColor: t.bg },
  /* ★ v30 / O：头部卡整体删掉，把原本由 hero 撑出的页首留白补进 paddingTop。 */
  pad: { paddingHorizontal: 18, paddingTop: 22, paddingBottom: 96 },
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
  note: { color: t.dim, fontSize: 11, lineHeight: 18, marginTop: 16 },
  hiddenEntry: { alignSelf: 'center', marginTop: 26, paddingVertical: 6, paddingHorizontal: 18 },
  hiddenTxt: { color: t.dim, fontSize: 10, letterSpacing: 1, opacity: 0.32 },
})
