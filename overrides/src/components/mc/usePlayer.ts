/**
 * 播放展示状态 —— 唯一一处定时器，1 秒一次，**只读、纯展示**。
 *
 * ★ P0 修正：删掉自建 `playing` 副本。
 *   旧版订阅 TrackPlayer.onStateChange 自己维护布尔，且注册发生在
 *   McShell 挂载时（setupPlayer 尚未跑）→ 注册失败、无 .catch → 副本恒 false
 *   → 暂停按钮永远走 doResume()，这就是「播放后停不下来」的真因。
 *   原装已有权威字段 `playerState.isPlay` 和 hook `useIsPlay()`
 *   （store/player/hook.ts，订阅 playStateChanged，由 service.ts → app_event.play() 驱动）。
 *   现在直接复用，播放图标 / 暂停 / 文案由 React 自动随状态重渲染。
 *
 * 边界：轮询只调 getPosition / getDuration 读进度，不判尾、不切歌、不取链、不写播放器。
 */
import { useEffect, useState } from 'react'
import playerState from '@/store/player/state'
import { useIsPlay } from '@/store/player/hook'
import { readProgress } from './upstream'
import { snapshot, coverKeys } from './catalog'
import { type SheetTrack } from './UI'

export type PlayerView = {
  track: SheetTrack | null
  playing: boolean
  position: number
  duration: number
  stateText: string
}

/**
 * ★ 自查修正（封面断链，对应需求 5）：
 *   `playMusicInfo.musicInfo` 是**新格式** LX.Music.MusicInfoOnline —— 顶层只有
 *   name/singer/meta，没有 `pic` / `img`；封面在 `meta.picUrl`，而 `fillMeta()`
 *   写回的是**另一个 state** `playerState.musicInfo.pic`（原装 PlayerBar 也读它）。
 *   旧版只读 `m.pic ?? m.img` → 恒空 → mini 播放条 / 播放浮层永远是几何色块。
 *   （上一版真机截图 3 底部 mini 条正是紫色几何块，实证。）
 *   现在四路兜底：meta.picUrl → playerState.musicInfo.pic → 老格式 pic/img。
 */
const toTrack = (m: any): SheetTrack | null => {
  if (!m) return null
  const pm: any = (playerState as any).musicInfo || {}
  let cover = String(m.meta?.picUrl ?? pm.pic ?? m.pic ?? m.img ?? '')
  /**
   * ★ F-06 分流修复：切歌瞬间 playTrack 先清空 playerState.musicInfo.pic，
   *   fillMeta 异步回填前有一段空窗 → mini 条显示几何块（图 25 实证）。
   *   两个 state 都为空时，按当前曲目 id 从曲库池反查补图（池子由
   *   backfillCover「播一首补一首」持续维护）。不写状态、不碰播放链路。
   */
  if (!cover) {
    const id = String(m.id ?? m.songmid ?? '')
    const name = String(m.name ?? m.title ?? '').trim()
    const singer = String(m.singer ?? m.artist ?? '').trim()
    try {
      /**
       * ★ 本轮修复：播放态 id 形如 `kw_123456`，曲库 id 是 `123456`，
       *   旧版严格 === 恒不命中 → 切歌空窗期掉几何兜底（用户报「好多没封面」）。
       *   复用 catalog 的 coverKeys 做多口径反查，再补「歌名|歌手」兜底。
       */
      const keys = new Set(coverKeys(id))
      const hit = snapshot().find(x => {
        const cand = [
          String(x.id ?? ''), String(x.songmid ?? ''),
          String(x.raw?.id ?? ''), String(x.raw?.songmid ?? ''),
        ]
        if (cand.some(c => c && keys.has(c))) return true
        return !!name && !!singer &&
          String(x.title ?? '').trim() === name && String(x.artist ?? '').trim() === singer
      })
      if (hit) cover = String(hit.cover || '')
    } catch (_) { /* 池子未就绪时忽略，保留几何兜底 */ }
  }
  return {
    id: String(m.id ?? m.songmid ?? ''),
    title: String(m.name ?? m.title ?? ''),
    artist: String(m.singer ?? m.artist ?? ''),
    album: String(m.meta?.albumName ?? m.albumName ?? m.album ?? ''),
    cover,
    raw: m,
  }
}

export const usePlayer = (): PlayerView => {
  const playing = useIsPlay()                 // ★ 原装权威状态，不自建副本
  /** ★ 严查 v11 P0：lyricUpdated 不改变 setInfo 的任何比较项，会让 React
   *  bail-out 不重渲染 → FullPlayer / LyricLines 渲染期直读的 lrc 拿不到新值。
   *  只给这个事件一次强制重渲染（每首歌 1 次，极稀疏），不碰浅比较优化。 */
  const [, bumpMeta] = useState(0)
  const [info, setInfo] = useState<{ track: SheetTrack | null, position: number, duration: number }>({
    track: null, position: 0, duration: 0,
  })

  useEffect(() => {
    let alive = true
    const tick = async() => {
      const m: any = (playerState as any).playMusicInfo?.musicInfo
      const { position, duration } = await readProgress()
      if (!alive) return
      // ★ 深度自查修复②：getPosition() 返回浮点秒，直接 === 恒不等，
      //   上一版浅比较等于白做，仍每秒换状态对象。统一压成整数秒再比 / 再存：
      //   fmt() 本来就 floor，进度显示、歌词行定位、seek 比例都按整秒，视觉无差异；
      //   状态对象每秒最多变一次（+1），主壳与当前页不再无谓重渲染。
      const nt = toTrack(m)
      /**
       * ★ 全项目重审 D：readProgress() 在读失败 / TrackPlayer 未就绪时返回 {0,0}。
       *  旧版直接把它压成整秒写进 state → 播放中偶发一次读失败，进度条就跳到
       *  「0:00 / 0:00」再下一秒跳回，这是反复报的「跳动」另一根因。
       *  区分两种情形：切歌（track 变了）本就该归零；同一首歌读失败则保留上一帧，
       *  等下个 tick 拿到真值，零跳变。 */
      /** ★ 再次自查 P2：duration 是进度条的分母，只有它有效才算这一帧有效。
       *  旧判据 `duration > 0 || position > 0` 会把 {position:84, duration:0}
       *  这种「半异常」当成有效 → 写 dur=0 → 进度条 0:00/0:00 且一秒不能拖。 */
      const valid = duration > 0
      setInfo(prev => {
        const changed = (prev.track?.id ?? '') !== (nt?.id ?? '')
        const pos = valid ? Math.floor(position) : (changed ? 0 : prev.position)
        const dur = valid ? Math.floor(duration) : (changed ? 0 : prev.duration)
        return (
          prev.track?.id === nt?.id && prev.track?.cover === nt?.cover &&
          prev.track?.title === nt?.title && prev.position === pos &&
          prev.duration === dur
        ) ? prev : { track: nt, position: pos, duration: dur }
      })
    }
    void tick().catch(() => {})
    const timer = setInterval(() => { void tick().catch(() => {}) }, 1000)
    // ★ 自查：切歌不再等最多 1 秒才刷新歌名/封面。原装 setPlayMusicInfo 会 emit
    //   musicToggled，fillMeta 写完封面 emit picUpdated、写完歌词 emit lyricUpdated；
    //   订阅这三个立刻 tick 一次（lyricUpdated 还负责让「无歌词」提示层自动切走）。
    //   卸载必逐个 off，绝不泄漏监听。
    const appEvent: any = (global as any).app_event
    const events = ['musicToggled', 'picUpdated', 'lyricUpdated']
    const onToggled = () => { void tick().catch(() => {}) }
    /** ★ 严查 v11：setMusicInfo({lrc}) 之后才 emit lyricUpdated，此时渲染期直读
     *  playerState.musicInfo.lrc 已是新值 —— 只要触发一次重渲染歌词就即时出现。 */
    const onLyric = () => { void tick().catch(() => {}); bumpMeta(v => v + 1) }
    const handlers: Record<string, () => void> = {
      musicToggled: onToggled, picUpdated: onToggled, lyricUpdated: onLyric,
    }
    if (appEvent && typeof appEvent.on === 'function') events.forEach(e => appEvent.on(e, handlers[e]))
    return () => {
      alive = false; clearInterval(timer)
      if (appEvent && typeof appEvent.off === 'function') events.forEach(e => appEvent.off(e, handlers[e]))
    }
  }, [])                                     // 只建一次；playing 变化由 hook 触发重渲染

  return {
    track: info.track,
    playing,                                 // 图标 / 暂停 / 文案全部以此为准
    position: info.position,
    duration: info.duration,
    stateText: !info.track ? '待播放' : (playing ? '播放中' : '已暂停'),
  }
}
