/**
 * 横屏 / 平板首页壳（UI 覆盖）—— 自查补上的缺口。
 * 原装 Home/index.tsx 会按 useHorizontalMode() 在 Vertical / Horizontal 间切换，
 * 只覆盖竖屏会让平板用户完全绕过「首次锁页、不准跳过」。
 *
 * 结构照搬原装 Horizontal/index.tsx，仅去掉末尾的 <PlayerBar />：
 * 播放条由 McShell 统一渲染一份，避免双播放条。
 * Aside 保留 → 原装「设置 → 自定义音源」入口在横屏下同样可达。
 */
import { View } from 'react-native'
import Aside from './Aside'
import StatusBar from '@/components/common/StatusBar'
import Header from './Header'
import Main from './Main'
import { createStyle } from '@/utils/tools'
import GateHost from '@/components/mc/GateHost'

const styles = createStyle({
  container: {
    flex: 1,
    flexDirection: 'row',
  },
  content: {
    flex: 1,
    overflow: 'hidden',
  },
})

export default () => (
  <GateHost
    original={
      <>
        <StatusBar />
        <View style={styles.container}>
          <Aside />
          <View style={styles.content}>
            <Header />
            <Main />
          </View>
        </View>
      </>
    }
  />
)
