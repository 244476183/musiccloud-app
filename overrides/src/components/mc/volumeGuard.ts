/**
 * ★ v32 / R：player.volume 复位兜底
 *
 * 背景：player.volume 是持久化设置（core/common.ts updateSetting → saveData），
 * plugins/player/index.ts 的 initial() 启动读它调 setVolume(volume)。
 * v31 把设置页收成只剩「自定义源」后，原装音量滑块已无 UI 入口 ——
 * 若早期版本被拖到 <100 并落盘，用户既看不见也调不回来。
 *
 * 做法：只在值 !== 1 时复位一次。改的是「设置值」本身，因此之后无论播放器
 * 何时懒初始化（ensurePlayer → playerInitial）读到的都是 1；另外补一次
 * setVolume(1) 覆盖「播放器已初始化」的情形（未初始化时 Promise 会 reject，吞掉即可）。
 *
 * 已核 configUpdated 的三个订阅者（init/player/player.ts、playProgress.ts、
 * preloadNextMusic.ts）分别只关心 togglePlayMethod / playbackRate / togglePlayMethod，
 * 对 player.volume 全部 no-op，不会牵动播放状态。
 *
 * 零破封 / 零主链六步 diff / 零新增定时器 / 零新增 Modal。
 * 默认 1 时零写入、零事件、零播放器调用（最常见路径完全静默）。
 */
import settingState from '@/store/setting/state'
import { updateSetting } from '@/core/common'
import { setVolume } from '@/plugins/player'

export const resetVolumeIfNeeded = (): void => {
  if (settingState.setting['player.volume'] === 1) return
  updateSetting({ 'player.volume': 1 })
  void setVolume(1).catch(() => {})
}
