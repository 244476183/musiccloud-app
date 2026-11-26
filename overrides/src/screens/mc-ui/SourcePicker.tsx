/**
 * ★ v32 / Q：精简选源页 —— 用户唯一能做的是「勾选哪个源启用」
 *
 * 由 v31 的 <Source />（原装 Setting/settings/Basic/Source.tsx）替换为本组件：
 *   · 保留：useUserApiList / useStatus / useSettingValue 三个原装 hook、
 *           原装 CheckBox + Text + createStyle 白底样式、勾选走原装 setApiSource。
 *   · 去掉：「自定义源管理」按钮、UserApiEditModal 整棵子树（导入/删除/编辑/FAQ 外链）、
 *           内置源列表（api-source-info.ts 的 sources 本就是空数组）、
 *           与 FullModal 顶栏「自定义源」重复的 SubTitle 小标题。
 *
 * 为什么不直接删 Source.tsx 那两行：它在 upstream 冻结区，改了破封。
 * 本组件放在 overrides 白名单路径内，upstream 一字不动。
 *
 * 数据层已核：4 个 hook 全是模块级全局 state + Event 单例，不需要设置页 Provider；
 * 换源仍由服务端改脚本内容（sha256 变 → mc-center 重导）驱动，app 不给任何编辑入口。
 *
 * 零破封 / 零主链六步 diff / 零新增定时器 / 零新增 Modal（反而少挂一整棵管理弹层）。
 */
import { memo, useCallback, useMemo } from 'react'
import { View } from 'react-native'
import CheckBox from '@/components/common/CheckBox'
import Text from '@/components/common/Text'
import { createStyle } from '@/utils/tools'
import { setApiSource } from '@/core/apiSource'
import { useI18n } from '@/lang'
import { useSettingValue } from '@/store/setting/hook'
import { useStatus, useUserApiList } from '@/store/userApi'
import { useTheme } from '@/store/theme/hook'

const useActive = (id: string) => {
  const active = useSettingValue('common.apiSource')
  return useMemo(() => active == id, [active, id])
}

const Item = ({ id, name, desc, statusLabel, change }: {
  id: string
  name: string
  desc?: string
  statusLabel?: string
  change: (id: string) => void
}) => {
  const isActive = useActive(id)
  const theme = useTheme()
  return (
    <CheckBox marginBottom={5} check={isActive} onChange={() => { change(id) }} need>
      <Text style={styles.sourceLabel}>
        {name}
        {
          desc ? <Text style={styles.sourceDesc} color={theme['c-500']} size={13}>  {desc}</Text> : null
        }
        {
          statusLabel ? <Text style={styles.sourceStatus} size={13}>  {statusLabel}</Text> : null
        }
      </Text>
    </CheckBox>
  )
}

export default memo(() => {
  const t = useI18n()
  const raw = useUserApiList()
  const status = useStatus()
  const activeId = useSettingValue('common.apiSource')

  const list = useMemo(() => {
    const getStatus = () => {
      if (status.status) return t('setting_basic_source_status_success')
      if (status.message == 'initing') return t('setting_basic_source_status_initing')
      return t('setting_basic_source_status_failed')
    }
    return raw.map(api => ({
      id: api.id,
      name: api.name,
      desc: [/^\d/.test(api.version) ? `v${api.version}` : api.version].filter(Boolean).join(', '),
      statusLabel: api.id == activeId ? `[${getStatus()}]` : '',
    }))
  }, [raw, status, activeId, t])

  const change = useCallback((id: string) => { setApiSource(id) }, [])

  return (
    <View style={styles.list}>
      {
        list.length
          ? list.map(({ id, name, desc, statusLabel }) => (
            <Item key={id} id={id} name={name} desc={desc} statusLabel={statusLabel} change={change} />
          ))
          : <Text style={styles.empty} size={13}>暂无可用音源，请稍后重试</Text>
      }
    </View>
  )
})

const styles = createStyle({
  list: {
    flexGrow: 0,
    flexShrink: 1,
    /* FullModal 的 body 无内边距；原装 SubTitle 提供的左右留白在这里补齐。 */
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  empty: {
    opacity: 0.6,
    paddingVertical: 20,
  },
  sourceLabel: {},
  sourceDesc: {},
  sourceStatus: {},
})
