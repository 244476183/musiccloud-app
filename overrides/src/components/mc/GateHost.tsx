/**
 * 门控宿主 —— 竖屏与横屏首页壳共用的唯一入口。
 *
 * 自查修正：原方案只覆盖 Vertical/index.tsx，平板/横屏模式会由
 * src/screens/Home/index.tsx 选中 Horizontal/index.tsx，从而绕过整个
 * 「首次锁页、不准跳过」的门控，且 config.json 空凭证导致取源根本没启用。
 * 现在两个壳都走同一个 GateHost，横竖屏一致。
 *
 * 三态：loading（不渲染，防冷启动闪主页）/ gate（只锁页）/ home（套 UI 壳）。
 * 老用户冷启动：读回配置 → 写回 cfg → 启用一次 → 直接进主页，不发 ping、不锁页、被踢无感。
 */
import { useEffect, useState, type ReactNode } from 'react'
import ConnectGate from './ConnectGate'
import McShell from './McShell'
import { applyGate, enableOnce, readGate, type Gate } from './connection'
import { initThemeMode } from '@/theme/mc'

type State = 'loading' | 'gate' | 'home'

export default ({ original }: { original: ReactNode }) => {
  const [state, setState] = useState<State>('loading')

  useEffect(() => {
    let alive = true
    void (async() => {
      // ★ 十期 P1-22：useTheme 初值取模块级默认 light，旧版存了深色的用户冷启会闪一帧浅色。
      //   本壳 loading 阶段先把主题读回来再显示 home，首帧即正确。
      // ★ 十期二轮④：主题与凭证都是本地 storage 读，串行会白等两轮；并行后仍保证
      //   applyGate / enableOnce 只在两者都就绪后执行。
      const [, g]: [void, Gate | null] = await Promise.all([
        initThemeMode().catch(() => {}),
        readGate(),
      ])
      if (!alive) return
      if (g) {
        applyGate(g)
        enableOnce()
        setState('home')
      } else {
        setState('gate')
      }
    })()
    return () => { alive = false }
  }, [])

  if (state === 'gate') return <ConnectGate onDone={() => setState('home')} />
  if (state === 'loading') return null
  return <McShell original={original} />
}
