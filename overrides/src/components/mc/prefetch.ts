/**
 * D-2 A｜预取下一首直链，压缩「刷歌某些歌 3~5 秒才出声」。
 *
 * 真因（核查结论）：我方硬编码 quality:'320k' + allowToggleSource:true，
 * 该源取不到 320k 时原装会并发遍历其它 4 个源搜索再逐个取链，
 * 整段 3~5 秒暴露在「松手 → 出声」之间。这里在【上一首还放着】时提前跑完
 * 这段并落进原装 URL 缓存，滑到那首时 getStoreMusicUrl 命中即秒回。
 *
 * 硬约束（v19 / v20 / v21 / v22）：
 *   ❌ 不调 playTrack、不碰 setPlayMusicInfo / setResource / setPlay（主链六步零 diff）
 *   ❌ 不占 playSeq 并发守卫、不写播放状态、不建定时器、不订阅事件
 *   ❌ 不调 waitSourceReady（避免与 playTrack 的 1.5s 节流 kick 相互拖延）
 *   ✅ 自建单飞 Map：同一曲目并发预取只跑一次；与正式播共享同一 musicInfo 口径
 *   ✅ 成功后 **await** saveMusicUrl(mi, '320k', url)：
 *      原装写缓存用的是脚本实际返回音质（可能 128k），而正式播读的是 '320k'，
 *      key 对不上就命中不了；且原装是 `void` 不等待，必须自己 await。
 *   ✅ 失败静默：正式播会自行重跑完整取链，最多多一次，有上界
 *
 * ★ v21②：不 import upstream.ts 的私有 toMusicInfo（那样会给 upstream 加 export，
 *   破坏「主链零 diff」）。这里直接用原装公开转换函数 toNewMusicInfo 构造，
 *   与 playTrack 用的是同一个函数、同样的 types/_types 兜底，不是第二套实现。
 *   预取输入只来自 catalog 的 Track（老格式 raw），不会遇到 player.track 的新格式。
 */
import { toNewMusicInfo, toOldMusicInfo } from '@/utils/index'
import { getMusicUrl } from '@/core/music/online'
import { saveMusicUrl } from '@/utils/data'
import { type SheetTrack } from './UI'

const inflight = new Map<string, Promise<void>>()

const buildMusicInfo = (tr: SheetTrack): any => {
  let raw: any = tr.raw && typeof tr.raw === 'object' ? tr.raw : {
    name: tr.title, singer: tr.artist || '', source: 'kw',
    songmid: tr.id, interval: tr.duration, albumName: tr.album || '', img: tr.cover || '',
  }
  if (raw?.meta && typeof raw.meta === 'object' && !('songmid' in raw)) {
    try { raw = toOldMusicInfo(raw) } catch (_) { /* 保底用原对象 */ }
  }
  raw = { ...raw, types: raw.types ?? [], _types: raw._types ?? {} }
  try { return toNewMusicInfo(raw) } catch (_) { return null }
}

/** 由 SwipeScreen 在切到下一首之前调用；入队即幂等，返回 void 不阻塞 UI。 */
export const prefetchTrack = (tr: SheetTrack | null | undefined): void => {
  if (!tr || !tr.id || (tr as any).localPath) return
  const key = String(tr.id)
  if (inflight.has(key)) return

  const job = (async() => {
    try {
      const mi = buildMusicInfo(tr)
      if (!mi || !mi.id) return
      const url: string = await getMusicUrl({
        musicInfo: mi, quality: '320k', isRefresh: false, allowToggleSource: true,
      } as any)
      if (!/^https?:\/\//i.test(String(url || ''))) return
      await saveMusicUrl(mi, '320k' as any, url)
    } catch (_) { /* 失败静默：正式播自行重跑完整取链 */ }
    finally { inflight.delete(key) }
  })()
  inflight.set(key, job)
  void job
}
