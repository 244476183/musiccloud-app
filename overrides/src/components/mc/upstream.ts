/**
 * 原装能力薄适配层 —— 只调用洛雪 v1.9.2 的公开 API，不重写、不包一层、不加状态机。
 *
 * 红线（对照废弃版 v3.5~v3.8 爆雷记录）：
 *   ❌ 不自建播放器：不直接碰 TrackPlayer.setupPlayer / reset / add / QueueEnded
 *   ✅ 播放器初始化调用原装导出的 initial()（原装 setupPlayer 就在它内部），幂等且不重复
 *   ❌ 不自建取链阶梯、不自建 URL 缓存、不预取
 *   ❌ 不自建播放状态与续播判定、不轮询
 *   ✅ 搜索用 musicSdk.searchMusic，取链用 online.getMusicUrl
 *   ✅ 播放用 player/utils.setResource + setPlay（UA / 占位轨 / 通知栏全由原装负责）
 *   ✅ 进度只读一次，不建轮询
 */
import { searchMusic } from '@/utils/musicSdk'
import { getMusicUrl } from '@/core/music/online'
import { getPicPath, getLyricInfo } from '@/core/music'
import { toNewMusicInfo, toOldMusicInfo } from '@/utils/index'
import { setPlayMusicInfo, setMusicInfo, setPlayListId } from '@/core/player/playInfo'
import { initial as playerInitial, isInitialized } from '@/plugins/player'
import settingState from '@/store/setting/state'
import playerState from '@/store/player/state'
import { addListMusics, removeListMusics } from '@/core/list'
import { getListMusicSync } from '@/utils/listManage'
import { LIST_IDS } from '@/config/constant'
import { getData, saveData } from '@/plugins/storage'
import {
  getDuration, getPosition, onStateChange, setPause, setPlay, setResource, setCurrentTime,
} from '@/plugins/player/utils'
import { addTempPlayList, clearTempPlayeList } from '@/core/player/tempPlayList'
import { waitSourceReady } from './autoSource'

export type MCTrack = {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  source: string
  songmid: string
  cover: string
  /** 缓存本地后的私有目录文件路径；有值时跳过在线取链，直接播本地文件 */
  localPath?: string
  /** 上游原对象，取链时交给原装 toNewMusicInfo */
  raw: any
}

/**
 * 封面地址归一化 —— 音源返回的封面可能是 `//cdn.x/a.jpg` 协议相对，
 * 也可能藏在 pic/cover/img/picUrl/albumPic 任一字段，或是 'null'/'0'/'none' 占位串。
 * 旧版只认完整 http(s) 字符串，导致大量列表退化成几何色块。
 */
export const coverUri = (u: any): string => {
  if (typeof u !== 'string') return ''
  // ★ 九期：音源脚本偶尔把 URL 里的 & 写成 &amp;，不还原会 404
  const v = u.trim().replace(/&amp;/g, '&')
  if (!v || ['null', 'undefined', '0', 'none', 'default'].includes(v.toLowerCase())) return ''
  if (/^\/\//.test(v)) return 'https:' + v
  if (!/^https?:\/\//i.test(v)) return ''
  return v
}

/** 一首歌所有可能的封面字段都试一遍；取不到才由 Cover 画几何封面。
 *  ★ 九期（封面修复③）：补齐 meta / album / artwork 等常见字段，
 *    不同音源脚本返回结构差异很大，漏一个字段就是一片空白。 */
export const coverOf = (x: any): string => {
  const r = x?.raw && typeof x.raw === 'object' ? x.raw : x
  const meta = (r?.meta && typeof r.meta === 'object') ? r.meta
    : (x?.meta && typeof x.meta === 'object') ? x.meta : {}
  const alb = (r?.album && typeof r.album === 'object') ? r.album : {}
  return coverUri(x?.cover) || coverUri(r?.pic) || coverUri(r?.cover) ||
    coverUri(r?.img) || coverUri(r?.picUrl) || coverUri(r?.albumPic) ||
    coverUri(r?.albumImg) || coverUri(r?.artworkUrl100) || coverUri(r?.artwork) ||
    coverUri(meta?.picUrl) || coverUri(meta?.pic) || coverUri(meta?.img) ||
    coverUri(meta?.cover) || coverUri(alb?.picUrl) || coverUri(alb?.cover) ||
    coverUri(x?.picUrl) || coverUri(x?.img) || coverUri(r?.cover_large) ||
    coverUri(r?.coverLarge) || coverUri(r?.data?.cover) || coverUri(r?.song?.cover) ||
    coverUri(alb?.artwork) || coverUri(meta?.pic_url) || ''
}

/** v1.9.2 内置搜索每首带 interval（"03:52"），必须自己解析；废弃版曾因丢此函数导致曲库恒 0。 */
const parseInterval = (v: any): number => {
  if (typeof v === 'number') return v
  const parts = String(v).split(':').map(Number)
  return parts.length === 2 ? parts[0] * 60 + parts[1] : (Number(v) || 0)
}

/**
 * ★ 全案风险最高的一段（约 40 行）。
 * v1.9.2 的 searchMusic 返回「每个平台一个结果集对象」{ list:[...], source:'kw', ... }，
 * source 在外层、不在每首歌上；直接当歌曲数组取 x.name 会全 undefined → 搜索恒 0 首。
 * 定稿锁死 v1.9.2，导出名确定，故写死 import，不做扫描生成。
 */
export const searchTracks = async(keyword: string, limit = 30): Promise<MCTrack[]> => {
  const r: any = await (searchMusic as any)({ name: keyword, singer: '', limit })
  const groups: any[] = Array.isArray(r) ? r : (r && (r.list || r.data || r.songs) ? [r] : [])
  let list: any[] = []
  for (const g of groups) {
    if (!g) continue
    const outer = (!Array.isArray(g) && g)
      ? String(g.source || g.sourceName || g.from || g.src || '') : ''
    if (Array.isArray(g)) list.push(...g)
    else if (Array.isArray(g.list)) list.push(...g.list.map((x: any) =>
      (x && typeof x === 'object' && !x.source && outer) ? { ...x, source: outer } : x))
    else if (Array.isArray(g.data)) list.push(...g.data)
    else if (Array.isArray(g.songs)) list.push(...g.songs)
  }
  if (!list.length && groups.length && !Array.isArray(groups[0]) && groups[0] &&
      (groups[0].name || groups[0].title || groups[0].songmid)) list = groups
  if (Array.isArray(list) && Array.isArray(list[0])) list = list.flat(1)
  return list.filter(Boolean).map((x: any) => {
    const id = String(x.id ?? x.songmid ?? x.hash ?? (x.name || '') + '|' + (x.singer || ''))
    const source = String(x.source || (x.meta && x.meta.source) || '')
    // ★ P1：音源脚本对种子词（如「治愈系」）搜索时会把 singer 填成关键词本身，
    //   真机截图里刷歌页歌手显示「治愈系」就是这个。命中关键词时改用真歌手字段。
    const singerRaw = String(x.singer ?? x.artist ?? x.artistName ?? '')
    const artist = singerRaw === keyword ? String(x.artist ?? x.artistName ?? '') : singerRaw
    const cover = coverOf(x)
    return {
      id,
      title: String(x.name ?? x.title ?? x.songName ?? ''),
      artist,
      album: String(x.albumName ?? x.album ?? ''),
      duration: Number(x.interval ? parseInterval(x.interval) : (x.duration || 0)),
      source,
      songmid: String(x.songmid ?? x.id ?? x.hash ?? ''),
      cover,
      // 取链要传上游原对象；内置搜索结果往往没有 id，补上，否则原装取链拿到 undefined。
      // ★ 自查：原装 toNewMusicInfo 的 `meta.picUrl = oldMusicInfo.img`（不是 pic！）。
      //   旧版只设 pic → meta.picUrl 恒 undefined → 原装 getPicPath 拿不到缓存封面、
      //   通知栏 artwork 也缺。补 img 后封面一层贯通，getPicPath 直接命中不额外请求音源。
      //   同步修正 singer，让 mini 条、通知栏、歌词页显示一致。
      raw: { ...x, id: x.id ?? x.songmid ?? x.hash ?? id, source, singer: artist,
        pic: cover, img: cover,
        types: x.types ?? [], _types: x._types ?? {} },
    }
  }).filter((x: MCTrack) => !!x.title)
}

/**
 * 原装播放器初始化 —— 这是「打开 APP 我方 UI 一首都放不了，去原装点一首后全部能播」的真因。
 *
 * ★ 逐行核实 v1.9.2：
 *   config/globalData.ts: playerStatus.isInitialized 初值 = false
 *   core/player/player.ts 的 handlePlay() 第一句：
 *     if (!isInitialized()) await playerInitial({...})   → TrackPlayer.setupPlayer(...)
 *   plugins/player/playList.ts 的 handlePlayMusic() 里
 *     TrackPlayer.getCurrentTrack() / add() / skip() / play() 都要求 setupPlayer 已完成。
 *
 *   原装播放任何一首（playListById → handlePlay）都会先跑这一步；
 *   我方旧版 playTrack 直接 setResource + setPlay，**跳过了 setupPlayer** →
 *   原生播放器从未初始化 → getCurrentTrack/add/play 静默失效 → 无声、00:00。
 *   用户去「原装」点一首，等于替我们跑了 playerInitial，全局 isInitialized 变 true，
 *   之后我方 setResource 才真正加轨出声。
 *
 * ★ 修法：照抄 handlePlay 那几行，调用原装自己导出的 initial()/isInitialized()。
 *   不是自建播放器（废弃版爆雷是另起 TrackPlayer.setupPlayer + 两套 service），
 *   initial() 自带幂等：isIniting || isInitialized 时直接 return，绝不会重复 setup。
 */
/**
 * ★ 八期自查①（快滑连点）：两次 playTrack 并发时，两者都会先读 isInitialized()
 *   （此刻还是 false）→ **各自跑一次 playerInitial / setupPlayer**，是原装不期望的重入。
 *   共享一个进行中的 Promise：同一时刻只初始化一次，成功或失败都清空、允许后续重试。
 *   仍是只调原装导出的 initial()，不自建播放器、不加状态机。
 */
let playerInitPromise: Promise<void> | null = null
const ensurePlayer = (): Promise<void> => {
  if (isInitialized()) return Promise.resolve()
  if (playerInitPromise) return playerInitPromise
  const p = (async() => {
    await playerInitial({
      volume: settingState.setting['player.volume'],
      playRate: settingState.setting['player.playbackRate'],
      cacheSize: settingState.setting['player.cacheSize'] ? parseInt(settingState.setting['player.cacheSize']) : 0,
      isHandleAudioFocus: settingState.setting['player.isHandleAudioFocus'],
      isEnableAudioOffload: settingState.setting['player.isEnableAudioOffload'],
    })
  })()
  playerInitPromise = p.then(
    () => { playerInitPromise = null },
    e => { playerInitPromise = null; throw e },
  )
  return playerInitPromise
}

/**
 * 取链 → 写回原装播放状态 → 播放，全部转发原装。
 * ★ 补 setPlayMusicInfo：原装 playListById 本来就调它，之前漏掉导致播放栏/歌词/进度全错。
 *   isTempPlay=true 已核实：getPlayIndex(null,…) 不抛错，watchList 跳过 playNext。
 */
/**
 * ★ P1：补回原装 handlePlay() → debouncePlay() 里被我们绕过的两组写回。
 *   getPicPath  → setMusicInfo({ pic }) → app_event.picUpdated()
 *   getLyricInfo→ setMusicInfo({ lrc,tlrc,lxlrc,rlrc,rawlrc }) → app_event.lyricUpdated()
 *                                      → core/lyric.setLyric() 灌入原装歌词引擎
 *   core/lyric.ts 的 setLyric() 是「无参、读 playerState.musicInfo.lrc」的，
 *   所以只要把数据写回原装状态，原装 PlayDetail/Vertical/Lyric.tsx 就能直接显示。
 * 每条异步结果都做「当前曲目 id」校验：快滑切歌时上一首的回调不会覆盖新歌（稳定的关键）。
 */
const fillMeta = async(musicInfo: LX.Music.MusicInfoOnline): Promise<void> => {
  const targetId = String(musicInfo.id)
  const stillCurrent = () =>
    String((playerState as any).playMusicInfo?.musicInfo?.id ?? '') === targetId
  try {
    const pic = await getPicPath({ musicInfo })
    if (pic && stillCurrent()) {
      setMusicInfo({ pic })
      ;(global as any).app_event?.picUpdated?.()
    }
  } catch (_) { /* 该音源未提供封面 → Cover 组件几何封面兜底 */ }
  if (!stillCurrent()) return                 // 已切歌，别再向音源发歌词请求
  try {
    const li: any = await getLyricInfo({ musicInfo })
    if (li && stillCurrent()) {
      setMusicInfo({
        lrc: li.lyric || '', tlrc: li.tlyric || '', lxlrc: li.lxlyric || '',
        rlrc: li.rlyric || '', rawlrc: li.rawlrcInfo?.lyric || '',
      })
      ;(global as any).app_event?.lyricUpdated?.()
    }
  } catch (_) { /* 该音源未提供歌词 → 显示「该音源未提供歌词」 */ }
}

/**
 * ★ 八期自查②（最要紧，直接影响「刷歌能流畅刷」）：
 *   上滑切歌 → playTrack 是 async：waitSourceReady → ensurePlayer → getMusicUrl(网络)
 *   → setPlayMusicInfo → setResource → setPlay。flip 入场动画 ~370ms 后解锁，
 *   而取链常比这慢，**两次 playTrack 必然并发**。旧版没有并发守卫：
 *   先发起的 A 若后返回，会覆盖 B 的 setPlayMusicInfo/setResource/setPlay →
 *   「队列显示 B、声音却是 A」；且 playerState 停在 A，B 的 fillMeta 的
 *   stillCurrent() 反而判 false → B 播着却没封面没歌词，A 的封面歌词倒写进来了。
 *
 *   修法：模块级请求序号，每个 await 后检查自己是否仍是最新一次；过期调用安静返回
 *   false，绝不写 playerState、绝不 setResource。纯 UI 层「丢弃过期异步结果」，
 *   不碰播放器、不碰取链语义、不建状态机、不引定时器。
 *   返回 boolean 供调用方决定是否 touch / 记历史（过期那首不该算「听过」）。
 */
let playSeq = 0
export const playTrack = async(t: MCTrack): Promise<boolean> => {
  const seq = ++playSeq
  const stale = () => seq !== playSeq
  // ★ 修正上一版的第二个错误：这里原本是「就绪检查失败就 throw」的硬门槛。
  //   原装 handlePlay 从来不做这种前置检查，直接取链；
  //   而 apisReady() 是我自己写的判据，真机上脚本 sources 结构一旦与假设不符就会恒 false，
  //   结果连播放器初始化都不执行 → 点了完全没反应。
  //   现在改成软等待：最多 2 秒、顺带尝试补选一次源，超时一律继续，
  //   让原装 getMusicUrl 给出真实结果或真实错误，绝不由我方判据挡死播放。
  // ★ 自查修正：缓存本地条目不需要音源就绪，直接播文件，不该干等 2 秒
  if (!t.localPath) await waitSourceReady(2000).catch(() => false)
  if (stale()) return false
  // ★ 真因修复：先让原装把 TrackPlayer 初始化好，否则 setResource 是空操作
  await ensurePlayer()
  if (stale()) return false
  /**
   * ★ 四次自查（真崩溃点）：原装 toNewMusicInfo 的 online 分支**无条件**执行
   *   `meta._qualitys.flac32bit` —— 若音频对象缺 `_types`（音源返回不规范、
   *   或收藏条目经 toOldMusicInfo 还原后 _types 为 undefined），这里直接 TypeError，
   *   表现为「点这首歌毫无反应」。统一在转换前兜底 types/_types。
   */
  let raw: any = t.raw && typeof t.raw === 'object' ? t.raw : {
    name: t.title, singer: t.artist, source: t.source || 'kw', songmid: t.songmid || t.id,
    interval: t.duration, albumName: t.album, img: t.cover,
  }
  raw = { ...raw, types: raw.types ?? [], _types: raw._types ?? {} }
  const musicInfo = toNewMusicInfo(raw) as LX.Music.MusicInfoOnline
  // ★ 缓存本地条目直接用私有目录文件，跳过在线取链（断网也能播）
  const url: string = t.localPath
    ? t.localPath
    : await getMusicUrl({ musicInfo, quality: '320k', isRefresh: false, allowToggleSource: true })
  if (!t.localPath && !/^https?:\/\//i.test(String(url || ''))) throw new Error('音源未返回可播直链')
  if (stale()) return false                 // ★ 取链回来的那一刻，用户可能已滑到下一首
  await setPlayMusicInfo(null, musicInfo as any, true)
  if (stale()) return false                 // ★ 写回是 async，期间也可能被新一次切歌抢先
  /**
   * ★ 四次自查（串歌）：核实 setPlayMusicInfo 只 setPlayMusicInfo + setProgress，
   *   **不清** `playerState.musicInfo` 的 pic/lrc（它属于另一个 state）。
   *   core/lyric.stop() 只清歌词引擎、也不写回 state。于是切到「无歌词/无封面」的歌时，
   *   上一首的 lrc/pic 会残留 → hasLrc 误判 → 歌词页显示上一首歌词，
   *   且 mini 条封面第二兜底会显示上一首封面。切歌时同步清空六个字段。
   */
  setMusicInfo({ pic: '', lrc: '', tlrc: '', rlrc: '', lxlrc: '', rawlrc: '' })
  ;(global as any).app_event?.picUpdated?.()   // 让 usePlayer 立刻重读，不闪上一首封面
  await setResource(musicInfo as LX.Player.PlayMusic, url, 0)
  if (stale()) return false
  await setPlay()
  if (stale()) return false
  void pushHistory(t)
  // ★ 自查修正：缓存本地条目（source:'local'）跳过 fillMeta。
  //   getPicPath/getLyricInfo 的 local 分支会去在线找「其他源」的封面与歌词，
  //   断网播本地文件时这属于多余网络请求，还会异步报错刷日志。
  //   cachedToSheet 已自带封面，歌词本来就不内嵌，故直接跳过。
  if (!t.localPath) void fillMeta(musicInfo)
  return true
}

/**
 * ★ 十一期「播放全部」：复用原装自带的「稍后播放队列」tempPlayList，不是自建续播状态机、
 *   不是 500ms 轮询判尾。原装 service.ts 播完 emit playerEnded → core/init/player →
 *   playNext(true) → 优先消费 tempPlayList → handlePlayNext → handlePlay（原装完整链路：
 *   取链、封面、歌词、通知栏）。队列播空后 playerListId 为 null → handleToggleStop 自动停。
 *
 * 四条硬约束（缺一条就串台）：
 *   ① 先 clearTempPlayeList()，清掉上一批残留；
 *   ② 顺序必须是 clear → await playTrack(first) → add(rest)，否则 addTempPlayList 内部
 *      的 `if (!playMusicInfo.musicInfo) void playNext()` 会抢跑播 rest[0]；
 *   ③ 显式 setPlayListId(null)，杜绝播完批后 playNext 误去消费某个原装列表的下一首；
 *   ④ 所有**单曲**播放入口（McShell.play）也必须先 clearTempPlayeList()。
 * shuffle=true 用于卡片 ▶（打乱批次后播首曲）；false 用于浮层「▶ 播放全部」（按列表顺序）。
 */
export const playBatch = async(tracks: MCTrack[], shuffle = false): Promise<boolean> => {
  if (!tracks.length) return false
  const list = shuffle ? [...tracks] : [...tracks]
  if (shuffle) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[list[i], list[j]] = [list[j], list[i]]
    }
  }
  clearTempPlayeList()
  setPlayListId(null)
  const ok = await playTrack(list[0])
  if (!ok) return false                       // 首曲被更新的请求抢占，不装队列
  const rest = list.slice(1)
    .map(t => ({ listId: null, musicInfo: toMusicInfo(t) }))
    .filter(x => !!x.musicInfo) as unknown as LX.Player.TempPlayListItem[]
  if (rest.length) addTempPlayList(rest)
  return true
}

/** 单曲播放前清掉批次队列，防止「装过一批后去刷歌切歌」被残留队列接管串台。 */
export const clearBatch = (): void => clearTempPlayeList()

export const doPause = () => setPause()
export const doResume = () => setPlay()

/** 拖动进度：转原装 setCurrentTime，不自己判尾、不续播。 */
export const seekToRatio = async(r: number): Promise<void> => {
  const { duration } = await readProgress()
  if (duration > 0) await setCurrentTime(Math.max(0, Math.min(1, r)) * duration)
}

/* ── 收藏：直接读写原装「我喜欢的音乐」，与原装设置页互通 ── */

/**
 * ★ 十一期真 bug 修复（喜欢按钮永远取消不了）：
 *   addListMusics 存进去的是 `toNewMusicInfo(raw)` —— id 带 source 前缀（如 kw_123456）；
 *   而旧版 favId() 用曲库 id（123456）去比、删也传它 → isFavorite() 恒 false、
 *   removeListMusics 删不到那条 → 每次点都走「添加」，♥ 永远不回 ♡。
 *   统一以「原装转换后 id」为比对 / 删除基准；转换前兜底 types/_types 防崩溃。
 */
const toMusicInfo = (t: MCTrack): any => {
  let raw: any = t.raw && typeof t.raw === 'object' ? t.raw : {
    name: t.title, singer: t.artist, source: t.source || 'kw', songmid: t.songmid || t.id,
    interval: t.duration, albumName: t.album, img: t.cover,
  }
  /**
   * ★ 十一期深度自查：mini 播放条 / NowPlayingSheet 传的是 player.track，
   *   它的 raw 是**新格式** LX.Music.MusicInfo（usePlayer.toTrack 直接 raw: m）。
   *   直接 toNewMusicInfo 会二次转换：songmid 在 meta.songId 而非顶层 →
   *   id 变 `kw_undefined`，且原装 utils/index.ts:50 的 `meta._qualitys.flac32bit`
   *   因 `_types` undefined 直接 TypeError（旧版被 catch 吞掉，每次点喜欢白抛一次异常，
   *   playBatch 遇到新格式则静默漏歌）。先还原成老格式再转换，一条覆盖所有入口。
   */
  if (raw?.meta && typeof raw.meta === 'object' && !('songmid' in raw)) {
    try { raw = toOldMusicInfo(raw) } catch (_) { /* 保底用原对象，仍由下方 try 兜住 */ }
  }
  raw = { ...raw, types: raw.types ?? [], _types: raw._types ?? {} }
  try { return toNewMusicInfo(raw) } catch (_) { return null }
}

const favId = (t: MCTrack): string => {
  const n = toMusicInfo(t)
  return String(n?.id ?? t.id ?? t.songmid ?? '')
}

export const favoriteIds = (): string[] =>
  (getListMusicSync(LIST_IDS.LOVE) as any[]).map(x => String(x.id ?? x.songmid ?? '')).filter(Boolean)

export const isFavorite = (t: MCTrack): boolean => favoriteIds().includes(favId(t))

export const toggleFavorite = async(t: MCTrack): Promise<boolean> => {
  try {
    if (isFavorite(t)) {
      await removeListMusics(LIST_IDS.LOVE, [favId(t)])
      return false
    }
    const n = toMusicInfo(t)
    if (!n) return false                       // 转换失败就别把异常对象写进收藏
    await addListMusics(LIST_IDS.LOVE, [n as any], 'top')
    return true
  } catch (e) {
    console.log('[mc] 收藏失败', String(e))
    return isFavorite(t)
  }
}

/**
 * 原装收藏里的对象转回我方展示结构。
 *
 * ★ 自查修正（「我的 → 我喜欢的歌」点播会失败）：
 *   toggleFavorite 存进去的是 `toNewMusicInfo(t.raw)` —— **新格式** LX.Music.MusicInfo
 *   （封面在 meta.picUrl，id 带 source 前缀）。旧版注释误以为「原装存的是老格式」，
 *   直接 `raw: x`，于是从收藏页点播时 playTrack 又对它做一次 toNewMusicInfo，
 *   songmid / meta 全部错位 → 取链必然失败。
 *   现在用原装 `toOldMusicInfo` 还原成上游老格式，播放链路与搜索结果完全一致；
 *   封面从 meta.picUrl 取（新格式顶层没有 pic/img）。
 */
export const getFavoriteTracks = (): MCTrack[] =>
  (getListMusicSync(LIST_IDS.LOVE) as any[]).map(x => {
    let old: any
    try { old = x?.meta ? toOldMusicInfo(x) : x } catch (_) { old = x }
    return {
      id: String(x.id ?? x.songmid ?? ''),
      title: String(x.name ?? x.title ?? ''),
      artist: String(x.singer ?? x.artist ?? ''),
      album: String(x.meta?.albumName ?? x.albumName ?? x.album ?? ''),
      duration: 0,
      source: String(x.source ?? ''),
      songmid: String(old?.songmid ?? x.meta?.songId ?? x.id ?? ''),
      cover: String(x.meta?.picUrl ?? x.pic ?? x.img ?? ''),
      // ★ 四次自查：收藏过的「缓存本地」歌曲是 source:'local'，文件路径在 meta.filePath。
      //   不补 localPath 的话从「我喜欢的」点播会走在线 getMusicUrl（我方 import 的是
      //   @/core/music/online，不认 local）→ 取链失败。补上即可断网直播本地文件。
      localPath: x.source === 'local' ? String(x.meta?.filePath ?? '') : undefined,
      raw: old,
    }
  }).filter(x => !!x.title)

/* ── 最近播放：纯本地 storage，零网络、零耦合 ── */
const HISTORY_KEY = 'mc.history.v1'

export const pushHistory = async(t: MCTrack): Promise<void> => {
  try {
    const old = (await getData<MCTrack[]>(HISTORY_KEY)) || []
    const next = [t, ...old.filter(x => x.id !== t.id)].slice(0, 60)
    await saveData(HISTORY_KEY, next)
  } catch (_) { /* 历史写失败不影响播放 */ }
}

export const getHistory = async(): Promise<MCTrack[]> => {
  try { return (await getData<MCTrack[]>(HISTORY_KEY)) || [] } catch (_) { return [] }
}

/** 只读一次进度，用于展示；不建 500ms 轮询。 */
export const readProgress = async(): Promise<{ position: number, duration: number }> => {
  try {
    const [position, duration] = await Promise.all([getPosition(), getDuration()])
    return { position, duration }
  } catch (_) {
    return { position: 0, duration: 0 }
  }
}

/** 只订阅原装状态做展示，绝不用于触发切歌。返回取消订阅函数。 */
export const subscribePlayState = async(listener: (state: string) => void): Promise<() => void> => {
  const remove = await onStateChange(listener as any)
  return typeof remove === 'function' ? remove : () => {}
}
