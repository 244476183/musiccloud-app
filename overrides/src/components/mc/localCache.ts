/**
 * 缓存本地（APP 私有目录） —— 零破封、零新增权限。
 *
 * ★ 为什么必须自建：核实 v1.9.2，移动端的「下载」是占位空壳——
 *   src/screens/Home/Views/Download/index.js 只渲染一行「下载」文本，
 *   getList(LIST_IDS.DOWNLOAD) 直接返回 []，全项目只有类型定义没有任务实现。
 *   所以不存在「直接调原装下载」这条路。
 *
 * ★ 走 APP 私有目录 Dir.DocumentDir，不碰公共目录：
 *   避开外部存储读写权限（在封印的非白名单权限里锁死，改它就要破封
 *   + Android 10+ 分区存储适配），也不需要改 Manifest。
 *   文件由原装 @/utils/fs 的 downloadFile 落地，取链仍用原装 getMusicUrl。
 *
 * ★ 播放：条目转成 source:'local' 的 oldMusicInfo → toNewMusicInfo → playTrack，
 *   playTrack 见 localPath 直接跳过去链，播本地文件。不建第二套播放器、不缓存直链。
 *
 * 口径：UI 一律叫「缓存本地 / 已缓存 / 缓存记录」，不叫「下载」。
 */
import {
  downloadFile, mkdir, existsFile, unlink, privateStorageDirectoryPath,
} from '@/utils/fs'
import { getMusicUrl } from '@/core/music'
import { toNewMusicInfo, toOldMusicInfo } from '@/utils/index'
import { getData, saveData } from '@/plugins/storage'
import { type MCTrack, coverOf } from './upstream'
import type { SheetTrack } from './UI'

const KEY = 'mc.local_cache.v1'
const DIR = privateStorageDirectoryPath + '/mc_cache'

export interface CachedItem {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  cover: string
  filePath: string
  size: number
  addedAt: number
}

const safeName = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return 'mc_' + Math.abs(h).toString(36) + '_' + String(s).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
}

const readAll = async(): Promise<CachedItem[]> => {
  const d = await getData<CachedItem[]>(KEY).catch(() => null)
  return Array.isArray(d) ? d.filter(x => x && x.id && x.filePath) : []
}

const writeAll = async(items: CachedItem[]): Promise<void> => {
  await saveData(KEY, items).catch(e => console.log('[mc-cache] 写清单失败', String(e)))
}

/**
 * ★ 十期全面核查 P0-7：旧版每首缓存都是「readAll → 下载 → writeAll(读到的旧清单+自己)」，
 *   快速连点两首 / 浮层里连点两行时，两次并发各自读到同一份旧清单，
 *   后写覆盖先写 → 运行时复现并发 A/B 只剩 [B]。
 *   下载可以继续并发（互不干扰），但「写清单」必须串行且每次写入前重新读。
 */
let writeChain: Promise<unknown> = Promise.resolve()
const withWriteLock = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => {})
  return run
}
const appendCached = (item: CachedItem): Promise<void> => withWriteLock(async() => {
  const cur = await readAll()
  await writeAll([...cur.filter(x => x.id !== item.id), item])
})

export const listCached = async(): Promise<CachedItem[]> => {
  const all = await readAll()
  const out: CachedItem[] = []
  for (const it of all) {
    if (await existsFile(it.filePath).catch(() => false)) out.push(it)
  }
  if (out.length !== all.length) await writeAll(out)   // 文件被系统清掉时顺手清清单
  return out
}

export const isCached = async(id: string): Promise<boolean> =>
  (await listCached()).some(x => x.id === id)

/** ★ 十一期：删除也走写锁，避免「缓存成功写入」与「取消缓存」并发时互相覆盖清单。 */
export const removeCached = async(id: string): Promise<void> => withWriteLock(async() => {
  const all = await readAll()                 // 锁内重新读，绝不拿旧快照写回
  const hit = all.find(x => x.id === id)
  if (hit) await unlink(hit.filePath).catch(() => {})
  await writeAll(all.filter(x => x.id !== id))
})

/** 把一首歌缓存到 APP 私有目录。返回条目；失败抛错由调用方提示。 */
export const cacheLocal = async(t: SheetTrack): Promise<CachedItem> => {
  const exist = (await listCached()).find(x => x.id === t.id)
  if (exist) return exist

  if (!await existsFile(DIR).catch(() => false)) await mkdir(DIR).catch(() => {})

  let raw: any = t.raw && typeof t.raw === 'object' ? t.raw : {
    name: t.title, singer: t.artist, source: 'kw', songmid: t.id,
    types: [], _types: {}, img: t.cover,
  }
  // ★ 自查：若来源是我方 player.track（新格式 LX.Music.MusicInfo，封面在 meta），
  //   再 toNewMusicInfo 会二次转换、字段错位。先用原装 toOldMusicInfo 还原。
  if (raw?.meta && typeof raw.meta === 'object' && !('songmid' in raw)) {
    try { raw = toOldMusicInfo(raw) } catch (_) { /* 保底用原对象 */ }
  }
  // ★ 四次自查：与 playTrack 一致，防 toNewMusicInfo 的 _qualitys undefined 崩溃
  raw = { ...raw, types: raw.types ?? [], _types: raw._types ?? {} }
  const musicInfo = toNewMusicInfo(raw) as LX.Music.MusicInfoOnline
  const url = await getMusicUrl({ musicInfo, quality: '320k', isRefresh: false, allowToggleSource: true })
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('音源未返回可缓存直链')

  const filePath = DIR + '/' + safeName(t.id) + '.mp3'
  const job: any = downloadFile(url, filePath)
  const res: any = await job.promise
  const code = Number(res?.statusCode ?? 200)
  if (code < 200 || code >= 300) {
    await unlink(filePath).catch(() => {})
    throw new Error('缓存失败 HTTP ' + code)
  }

  const item: CachedItem = {
    id: t.id,
    title: t.title,
    artist: t.artist || '',
    album: t.album || '',
    duration: Number(t.duration || 0),
    cover: coverOf(t) || t.cover || '',
    filePath,
    size: Number(res?.bytesWritten || 0),
    addedAt: Date.now(),
  }
  await appendCached(item)   // ★ P0-7 串行写入，不再并发覆盖
  return item
}

/** ★ 十期 P0-8：清空走一次批量写盘（旧版 N 首 = N 次全量读写 + 无确认）。 */
export const clearAllCached = async(): Promise<number> => withWriteLock(async() => {
  const all = await readAll()
  for (const it of all) await unlink(it.filePath).catch(() => {})
  await writeAll([])
  return all.length
})

/** 缓存条目 → 播放用 MCTrack（source:'local'，跳过在线取链） */
export const cachedToTrack = (c: CachedItem): MCTrack => ({
  id: c.id,
  title: c.title,
  artist: c.artist,
  album: c.album,
  duration: c.duration,
  source: 'local',
  songmid: c.filePath,
  cover: c.cover,
  localPath: c.filePath,
  raw: {
    name: c.title, singer: c.artist, source: 'local',
    songmid: c.filePath, filePath: c.filePath, ext: 'mp3',
    interval: c.duration, img: c.cover,
    albumName: c.album, types: [], _types: {},
  },
})

/** UI 展示用：带上 localPath 与 local 原对象，让统一播放链路跳过在线取链 */
export const cachedToSheet = (c: CachedItem): SheetTrack => ({
  id: c.id, title: c.title, artist: c.artist, album: c.album,
  duration: c.duration, cover: c.cover,
  localPath: c.filePath,
  raw: {
    name: c.title, singer: c.artist, source: 'local',
    songmid: c.filePath, filePath: c.filePath, ext: 'mp3',
    interval: c.duration, img: c.cover, albumName: c.album,
    types: [], _types: {},
  },
})
