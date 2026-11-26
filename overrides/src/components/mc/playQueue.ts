/**
 * H / K 共用的一份会话内播放队列（不落盘、上限 50）。
 *
 * 一份 items[] + cursor 同时管三件事：
 *   · H：上一首 / 下一首（单曲态）
 *   · K：队列抽屉显示
 *   · K：顺序播放（主动切歌时走 stepNext）
 *
 * 硬约束（v19 / v20 / v21 / v22 / v24 复核）：
 *   ❌ 不接管原装 tempPlayList —— 批次态由 McShell 分流走原装 playNext。
 *      （否则 play() 里的 clearBatch() 会清掉整批「稍后播放」）
 *   ❌ 不订阅 app_event.playerEnded（那是取链空窗信号，不是播完）
 *   ❌ 不建定时器、不建第二套心跳、不写播放状态
 *   ✅ 只在 playTrack 真正落地后 record；失败 / stale 时精确回拨
 *
 * ★ v24 深度自查修复（真 bug）：
 *   旧 restore() 是 `if (cursor > 0) cursor -= 1` —— 盲目减一。
 *   但 stepPrev 已经把 cursor 减过一次、jumpTo 可能往前跳很多，
 *   失败时再 -1 会「越退越前」；而普通新播（推荐页点一首）根本没切歌，
 *   失败时也不该动光标。现在用 armed / savedCursor 记住「发起切歌前」的位置，
 *   只有切歌在途才精确回拨；record 落地时清标记。
 */
import { type SheetTrack } from './UI'

const MAX = 50
let items: SheetTrack[] = []
let cursor = -1
let armed = false        // 是否有一笔「切歌」在途（stepNext / stepPrev / jumpTo）
let savedCursor = -1     // 发起该笔切歌前的光标

const arm = (): void => { armed = true; savedCursor = cursor }

export const snapshot = (): { items: SheetTrack[], cursor: number } =>
  ({ items: items.slice(), cursor })

/** 播放真正落地后记一行。回环（同一首重复播）不重复记。 */
export const record = (tr: SheetTrack): void => {
  armed = false                         // 这笔已落地，清掉回拨标记
  if (!tr || !tr.id) return
  const id = String(tr.id)
  if (cursor >= 0 && items[cursor]?.id === id) return
  // 从历史某首重新起播 → 截断后段再追加，避免「上一首」跳到已被抛弃的分支
  if (cursor < items.length - 1) items = items.slice(0, cursor + 1)
  items.push(tr)
  if (items.length > MAX) items = items.slice(-MAX)
  cursor = items.length - 1
}

/** 取链失败 / 被并发守卫判 stale：只有切歌在途才回到发起前；普通新播光标不动。 */
export const restore = (): void => {
  if (armed) cursor = savedCursor
  armed = false
}

export const canPrev = (): boolean => cursor > 0
export const canNext = (): boolean => cursor >= 0 && cursor < items.length - 1

/** 顺序播放 / 按钮切歌：先移 cursor 再返回曲目。
 *  随后 play() → record(tr) 会发现 items[cursor].id === tr.id 直接返回，不会重复记。 */
export const stepNext = (): SheetTrack | null => {
  if (!canNext()) return null
  arm()
  cursor += 1
  return items[cursor]
}
export const stepPrev = (): SheetTrack | null => {
  if (!canPrev()) return null
  arm()
  cursor -= 1
  return items[cursor]
}

/** K：队列抽屉点某首 → 移 cursor 并返回。随后 play() → record(tr)
 *  会发现 items[cursor].id === tr.id 直接返回，不会重复记。 */
export const jumpTo = (i: number): SheetTrack | null => {
  if (i < 0 || i >= items.length) return null
  arm()
  cursor = i
  return items[i]
}
