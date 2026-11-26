/**
 * MCIcon —— 全 APP 唯一的切歌 / 模式图标出口（K）。
 *
 * 复用原装已打进 APK 的 icomoon.ttf + components/common/Icon.tsx，
 * 0 新增字体、0 新增二进制资源、0 破封。
 *
 * ★ v20 坑 3：原装 Icon 内部 `color={color ?? theme['c-font']}` 订阅的是【原装】
 *   theme store，而我方全屏页 / mini 条用 DARK tokens（两套体系）。不显式传色
 *   会拿到原装 c-font（可能是深色）→ 深色页出现黑图标。
 * ★ v24 深度自查：原装 Icon 还会用 useTextShadow() 把一层 textShadow
 *   compose 进 style —— 显式传 color 挡不住这一层。这里传一个 NO_SHADOW
 *   打底的 style 数组把三个阴影属性清零，保证图标在我方深色页干净。
 * `rawSize` 也必须给，否则原装 scaleSizeW 会二次缩放。Icon 本身是 memo。
 *
 * 可用 name（selection.json 52 图标里与本项目相关的）：
 *   prevMusic / nextMusic —— 标准切歌（|◀ / ▶|，不是快退快进）
 *   list-order           —— 顺序播放
 *   single-loop          —— 单曲循环（循环箭头 + 1）
 */
import React from 'react'
import { View, StyleSheet, type StyleProp, type TextStyle } from 'react-native'
import { Icon } from '@/components/common/Icon'

/** 覆盖原装 useTextShadow() 注入的紫色描边；数组后项优先，调用方 style 仍可覆盖。 */
const NO_SHADOW: TextStyle = {
  textShadowColor: 'transparent',
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 0,
}

export default function MCIcon({ name, size = 22, color = '#FFFFFF', style }: {
  name: string
  size?: number
  color: string
  style?: StyleProp<TextStyle>
}) {
  /** icomoon 的 name 是字面量联合，这里按运行时字符串传入。
   *  用 as any 而非 @ts-expect-error：未来若跑完整 tsc，后者在无需抑制时会报
   *  「Unused @ts-expect-error directive」，反而多一处假红。 */
  /** ★ v25：flatten 成单个扁平对象再交给原装 Icon。
   *  原装内部是 StyleSheet.compose(shadowStyle, style)；传数组会变成
   *  [shadowStyle, [NO_SHADOW, style]] 嵌套结构，依赖 RN 的递归 flatten 才能覆盖。
   *  这里直接给扁平对象，compose 后是 [shadowStyle, flat]，flat 在后必然覆盖，
   *  不依赖任何 RN 版本行为。 */
  return <Icon name={name as any} rawSize={size} color={color}
    style={StyleSheet.flatten([NO_SHADOW, style])} />
}

/** 队列图标：icomoon 里没有，纯 View 自绘「▶ + 三横线」（图 37 最右）。
 *  不引字体、不引 SVG 库、0 破封。 */
export const QueueGlyph = ({ color = '#FFFFFF' }: { color?: string }) => (
  <View style={{ width: 20, height: 18, justifyContent: 'space-between' }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', height: 5 }}>
      <View style={{ width: 0, height: 0, borderLeftWidth: 7, borderTopWidth: 4,
        borderBottomWidth: 4, borderTopColor: 'transparent',
        borderBottomColor: 'transparent', borderLeftColor: color }} />
      <View style={{ flex: 1, height: 2, marginLeft: 3, backgroundColor: color, opacity: 0.9 }} />
    </View>
    <View style={{ height: 2, backgroundColor: color, opacity: 0.9 }} />
    <View style={{ height: 2, backgroundColor: color, opacity: 0.55 }} />
    <View style={{ height: 2, backgroundColor: color, opacity: 0.35 }} />
  </View>
)
