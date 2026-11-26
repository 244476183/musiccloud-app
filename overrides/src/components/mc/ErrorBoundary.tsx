/**
 * F-13 保险丝 —— 渲染期错误边界 + 全局未捕获兜底。
 *
 * 如实边界：本环境没有 Logcat / 崩溃栈，这一层**不修根因**，只做两件事：
 *   ① 让渲染期异常不再直接闪退，给一条可见的「出错了 · 点此重载」；
 *   ② 把最近一条错误栈落盘（mc.last.error.v1），崩溃页同时直显详情；
 *      取证靠页面截图或本地存储，不再依赖任何设置入口。
 *
 * 原装本来就有全局 JS / 原生异常捕获（utils/errorHandle.ts → app.ts），
 * 这里只补 React 渲染边界与未捕获 Promise，且**链式调回原 handler**，不破坏红屏与上报。
 * 全部在 components/mc 内，不改 index.js / app.ts / 任何冻结文件 → 0 破封。
 */
import React from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native'
import { saveData } from '@/plugins/storage'

const KEY = 'mc.last.error.v1'

export const saveLastError = (e: any): void => {
  try {
    const msg = String(e?.message ?? e ?? '')
    const stack = String(e?.stack ?? '')
    void saveData(KEY, { at: Date.now(), msg, stack }).catch(() => {})
  } catch (_) { /* 兜底本身绝不能再抛 */ }
}

/** 全局未捕获 Promise / JS handler：挂一次、链式调回原 handler。 */
export const installGlobalHandlers = (): (() => void) => {
  try {
    const g: any = global as any
    const ErrU = g.ErrorUtils
    if (ErrU && typeof ErrU.getGlobalHandler === 'function' && !g.__mcErrHooked) {
      g.__mcErrHooked = true
      const prev = ErrU.getGlobalHandler()
      ErrU.setGlobalHandler((e: any, fatal: boolean) => {
        saveLastError(e)
        if (typeof prev === 'function') prev(e, fatal)
      })
    }
  } catch (_) { /* 平台无 ErrorUtils 时静默跳过 */ }
  return () => { /* 全局 handler 不卸载，避免把原 handler 链弄断 */ }
}

type Props = { children: React.ReactNode }
type State = { err: Error | null }

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(e: Error): State { return { err: e } }

  componentDidCatch(e: Error) { saveLastError(e) }

  componentDidMount() { installGlobalHandlers() }

  private reload = () => {
    // 不静默吞：给一个明确的重载入口；RN 下优先走 DevSettings，生产退回重置本边界。
    try {
      const g: any = global as any
      if (g.__DEV__ && g.DevSettings?.reload) { g.DevSettings.reload(); return }
    } catch (_) { /* noop */ }
    this.setState({ err: null })
  }

  render() {
    if (!this.state.err) return this.props.children
    const e: any = this.state.err
    /** ★ v8：崩溃详情直接显示在页面上 —— 无 Logcat 时，用户一崩截图即可精确定位，
        不必再翻找任何设置入口。只展示 message + stack 首行，不刷屏。 */
    const msg = String(e?.message ?? e ?? '未知错误')
    const first = String(e?.stack ?? '').split('\n').slice(0, 2).join('\n')
    return (
      <View style={s.root}>
        <Text style={s.title}>出了点问题</Text>
        <Text style={s.sub}>错误详情已显示在下方，截图即可反馈</Text>
        <Text style={s.detail} selectable numberOfLines={5}>{msg}{first ? '\n' + first : ''}</Text>
        <TouchableOpacity style={s.btn} onPress={this.reload} activeOpacity={0.88}>
          <Text style={s.btnTxt}>点此重载</Text>
        </TouchableOpacity>
      </View>
    )
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#12151F', alignItems: 'center',
    justifyContent: 'center', padding: 30, paddingTop: Platform.OS === 'android' ? 60 : 30 },
  title: { color: '#FFFFFF', fontSize: 20, fontWeight: '700' },
  sub: { color: '#8B93AA', fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 12 },
  detail: { color: '#C7B8FF', fontSize: 11, lineHeight: 17, textAlign: 'left',
    marginTop: 22, alignSelf: 'stretch', backgroundColor: 'rgba(109,94,252,0.12)',
    borderRadius: 10, padding: 12, overflow: 'hidden' },
  btn: { marginTop: 28, backgroundColor: '#6D5EFC', borderRadius: 14,
    paddingVertical: 13, paddingHorizontal: 34 },
  btnTxt: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
})
