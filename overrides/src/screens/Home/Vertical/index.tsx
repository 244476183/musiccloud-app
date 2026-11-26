/**
 * 竖屏首页壳（UI 覆盖）—— 只做「把门控套在原装内容外面」。
 * 保留 `import Content from './Content'`：原装首页内容直接复用，
 * 且 apply.sh 冻结区那句 grep 断言仍成立。
 * Content 不含 PlayerBar（PlayerBar 由 McShell 统一渲染），不会双播放条。
 */
import Content from './Content'
import GateHost from '@/components/mc/GateHost'

export default () => <GateHost original={<Content />} />
