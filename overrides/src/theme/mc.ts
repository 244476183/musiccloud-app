/**
 * 视觉令牌 —— 按真机截图逐项复刻。
 * 推荐页 / 我的页＝浅色淡紫蓝；刷歌页＝深色（强制，不跟随主题切换）。
 * 不读写上游 store、不引 BlurView / 渐变原生模块。
 */
import React, { useEffect, useState } from 'react'
import { getData, saveData } from '@/plugins/storage'

const KEY = 'mc.theme.v1'
export type ThemeMode = 'dark' | 'light'

export interface Tokens {
  isDark: boolean
  statusBar: 'light-content' | 'dark-content'
  bg: string
  bg2: string
  card: string
  card2: string
  cardSolid: string
  line: string
  text: string
  sub: string
  dim: string
  brand: string
  brand2: string
  blue: string
  red: string
  green: string
  purple: string
  gold: string
  ok: string
  warn: string
  pill: string
  chipOn: string
  chipOff: string
  overlay: string
  shade: string
  onBrand: string
  /** 顶部字标条背景（深灰蓝）与胶囊底色 */
  header: string
  headerPill: string
  radius: { sm: number; md: number; lg: number; pill: number }
  fs: { micro: number; sub: number; body: number; sec: number; title: number; num: number; disp: number }
  fw: { normal: '400'; semi: '600'; bold: '700'; heavy: '800' }
  space: (n: number) => number
}

const base = {
  radius: { sm: 12, md: 18, lg: 22, pill: 999 },
  fs: { micro: 11, sub: 13, body: 15, sec: 18, title: 22, num: 30, disp: 30 },
  fw: { normal: '400', semi: '600', bold: '700', heavy: '800' } as Tokens['fw'],
  space: (n: number) => n * 4,
}

/** 浅色：截图里推荐 / 我的 的主视觉，白卡 + 蓝紫品牌色 + 淡紫蓝底 */
export const LIGHT: Tokens = {
  ...base,
  isDark: false,
  statusBar: 'dark-content',
  bg: '#F6F7FD',
  // ★ 九期：状态栏 / TabBar / 内容区必须同底色，bg2 不再单独调色（三段式色带的根因）
  bg2: '#F6F7FD',
  card: '#FFFFFF',
  card2: '#F1F3FC',
  cardSolid: '#FFFFFF',
  line: '#E6EAF5',
  text: '#15182C',
  sub: '#656D8C',
  dim: '#98A0BA',
  brand: '#6D5EFC',
  brand2: '#A855F7',
  blue: '#2F6BFF',
  red: '#FF4D6D',
  green: '#22B87A',
  purple: '#8B5CF6',
  gold: '#E8A54A',
  ok: '#22B87A',
  warn: '#E8A54A',
  pill: '#EEF1FC',
  chipOn: '#2F6BFF',
  chipOff: '#F1F3FC',
  overlay: 'rgba(16,18,36,0.45)',
  shade: 'rgba(30,34,70,0.42)',
  onBrand: '#FFFFFF',
  header: '#5A5B74',
  headerPill: 'rgba(255,255,255,0.18)',
}

/** 深色：刷歌页专用（截图 10：深色渐变底、白字、圆形灰按钮） */
export const DARK: Tokens = {
  ...base,
  isDark: true,
  statusBar: 'light-content',
  bg: '#12151F',
  bg2: '#12151F',   // ★ 九期：刷歌页全屏沉浸，顶部不再另起一道深色带
  card: '#1C2130',
  card2: '#252B3C',
  cardSolid: '#1C2130',
  line: '#333A4E',
  text: '#FFFFFF',
  sub: '#C6CBDD',
  dim: '#8B93AA',
  brand: '#8B7BFF',
  brand2: '#A855F7',
  blue: '#4F8BFF',
  red: '#FF5A7A',
  green: '#31C27C',
  purple: '#8B5CF6',
  gold: '#E8C46A',
  ok: '#4ADE80',
  warn: '#FBBF24',
  pill: '#262B3C',
  chipOn: '#6D5EFC',
  chipOff: '#252B3C',
  overlay: 'rgba(8,9,18,0.62)',
  shade: 'rgba(10,12,24,0.55)',
  onBrand: '#FFFFFF',
  header: '#56576E',
  headerPill: 'rgba(255,255,255,0.16)',
}

export const THEMES: Record<ThemeMode, Tokens> = { light: LIGHT, dark: DARK }

let mode: ThemeMode = 'light'
let inited = false
const listeners = new Set<(m: ThemeMode) => void>()

export const getThemeMode = (): ThemeMode => mode
export const getTokens = (): Tokens => THEMES[mode]

export const initThemeMode = async(): Promise<void> => {
  if (inited) return
  inited = true
  const saved = await getData(KEY).catch(() => null)
  if (saved === 'light' || saved === 'dark') mode = saved
  listeners.forEach(fn => fn(mode))
}

export const setThemeMode = async(m: ThemeMode): Promise<void> => {
  mode = m
  await saveData(KEY, m).catch(() => {})
  listeners.forEach(fn => { try { fn(m) } catch (_) {} })
}

export const toggleThemeMode = (): Promise<void> =>
  setThemeMode(mode === 'dark' ? 'light' : 'dark')

export const subscribeTheme = (fn: (m: ThemeMode) => void): (() => void) => {
  listeners.add(fn)
  fn(mode)
  return () => { listeners.delete(fn) }
}

export const useTheme = () => {
  const [m, setM] = useState<ThemeMode>(mode)
  useEffect(() => subscribeTheme(setM), [])
  return { t: THEMES[m], mode: m, setMode: setThemeMode, toggle: toggleThemeMode }
}

/** 几何封面配色：截图里绿 / 蓝 / 紫 / 橙 / 粉 / 青的鲜艳色块 */
const PALETTE = [
  ['#3FBF7F', '#1E6E52'], ['#4C7DF0', '#2A3E8C'], ['#7B5CF0', '#3B2A8C'],
  ['#F58A3C', '#A8431C'], ['#E85C9A', '#8A2A5C'], ['#2FA8B8', '#155A6B'],
  ['#5B8DEF', '#243C80'], ['#B45CF0', '#5A258C'],
]
export const coverHue = (key: string, n = 0): [string, string] => {
  let h = 0
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) | 0
  return PALETTE[Math.abs(h + n) % PALETTE.length] as [string, string]
}

/* ── 兼容导出：锁页专用（保持原深色，不跟随主界面浅色） ── */
export const MC = {
  bg: '#0E0F1A', bg2: '#141528', card: '#1C1D30', bgCard: '#1C1D30',
  bgInput: '#232538', line: '#2B2D44', text: '#F2F2FA', textSub: '#BCC2DD',
  textDim: '#7C839C', accent: '#6D5EFC', accent2: '#A855F7',
  ok: '#4ADE80', warn: '#FBBF24', red: '#FF5A7A', gold: '#E8C46A',
  danger: '#FF5A7A', onBrand: '#FFFFFF',
}
export const MC_SIZE = {
  tabHeight: 50, radius: 18, pad: 18,
  radiusSm: 12, radiusMd: 18, radiusLg: 22,
  bodySize: 15, subSize: 13,
}

export default useTheme
