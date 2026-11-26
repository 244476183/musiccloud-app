/**
 * 首次连接页 —— F-17 整页重做（按确认效果图）。
 *
 * 显示层：
 *   「设备 ID」→「用户名」、「令牌」→「密钥」；删掉输入框里的 deviceId / token 占位字；
 *   副标题 / 查看连接信息（含中心地址与说明）/ 底部说明 / 错误红字 全部去掉，
 *   页面不出现任何一行提示文字。整页改为深色留白、无厚重卡片、统一圆角字阶。
 *   校验失败只给「描边变色 + 极轻震动」非文字反馈，加载用一个转圈。
 *
 * ★ 硬约束（只换脸、不动骨头）：底层 Gate = { deviceId, token }、存储键 mc_gate_v1、
 *   写回 config.json 的字段、ping 拼的 ?deviceId=&token= 一个都不改。
 *   改了字段名会直接 401，新装用户永远进不去。
 *   GateHost.tsx / connection.ts / 安装包配置 一行不动 → 0 破封、零主链路影响。
 *
 * 行为红线不变：首次锁页不可跳过、403 严格不放行、校验不通过留在本页；
 * enableOnce 幂等、saveGate 成功才通知父组件卸载（避免对已卸载组件 setState）。
 */
import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Animated, KeyboardAvoidingView, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native'
import { MC, MC_SIZE } from '@/theme/mc'
import { applyGate, enableOnce, ping, saveGate, type Gate } from './connection'

export default ({ onDone }: { onDone: (g: Gate) => void }) => {
  // 内部变量名保留 deviceId / token：它们就是中心协议认的两个字段，只改显示文案。
  const [deviceId, setDeviceId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const [focus, setFocus] = useState<'user' | 'secret' | null>(null)
  /** 非文字失败反馈：只驱动一次描边抖动，不渲染任何文字。 */
  const [failed, setFailed] = useState(false)
  const shake = useRef(new Animated.Value(0)).current
  const failTimer = useRef<any>(null)
  useEffect(() => () => { if (failTimer.current) clearTimeout(failTimer.current) }, [])

  const flashFail = () => {
    setFailed(true)
    shake.setValue(0)
    Animated.sequence([
      Animated.timing(shake, { toValue: 1, duration: 70, useNativeDriver: false }),
      Animated.timing(shake, { toValue: -1, duration: 70, useNativeDriver: false }),
      Animated.timing(shake, { toValue: 0, duration: 90, useNativeDriver: false }),
    ]).start()
    if (failTimer.current) clearTimeout(failTimer.current)
    failTimer.current = setTimeout(() => setFailed(false), 900)
  }

  const submit = async() => {
    const g: Gate = { deviceId: deviceId.trim(), token: token.trim() }
    if (!g.deviceId || !g.token) { flashFail(); return }
    if (busy) return
    setBusy(true)
    setFailed(false)
    const r = await ping(g)
    if (r.ok) {
      try {
        await saveGate(g)
        applyGate(g)
        enableOnce()
        setBusy(false)
        onDone(g)
        return
      } catch (_) {
        flashFail()
      }
    } else {
      flashFail()
    }
    setBusy(false)
  }

  const borderOf = (k: 'user' | 'secret') => {
    if (failed) return MC.red
    if (focus === k) return MC.accent
    return MC.line
  }

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <Text style={s.mark}>飞 扬 音 乐</Text>
        <Text style={s.title}>连接音乐中心</Text>

        <Animated.View style={{ transform: [{ translateX: shake }] }}>
          <Text style={s.label}>用户名</Text>
          <View style={[s.field, { borderColor: borderOf('user') }]}>
            <TextInput
              style={s.input}
              value={deviceId}
              onChangeText={t => { setDeviceId(t); setFailed(false) }}
              onFocus={() => setFocus('user')}
              onBlur={() => setFocus(null)}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
            {/* ★ 深度自查修复③：旧显示条件带 focus === 'user'，而按下 × 的瞬间
                TextInput 先 onBlur 把 focus 清空 → 按钮先卸载、onPress 丢失，点不到。
                改为「有内容就显示清除」，与主流输入框一致；focus 仍只管描边高亮。 */}
            {!!deviceId ? (
              <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => { setDeviceId(''); setFailed(false) }}>
                <Text style={s.fieldIco}>✕</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <Text style={s.label}>密钥</Text>
          <View style={[s.field, { borderColor: borderOf('secret') }]}>
            <TextInput
              style={s.input}
              value={token}
              onChangeText={t => { setToken(t); setFailed(false) }}
              onFocus={() => setFocus('secret')}
              onBlur={() => setFocus(null)}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showSecret}
              editable={!busy}
            />
            <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => setShowSecret(v => !v)}>
              <Text style={s.fieldIco}>{showSecret ? '◉' : '◎'}</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>

        <TouchableOpacity style={[s.btn, busy && s.btnDisabled]}
          onPress={() => void submit().catch(() => flashFail())} disabled={busy} activeOpacity={0.88}>
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.btnText}>进入</Text>}
        </TouchableOpacity>

        {/* ★ J：底部常驻版权标识（用户追加）。口径收窄为「不出现操作/错误/
            连接信息提示，保留这一行版权」；与 F-17「失败只给非文字反馈」不冲突。
            弹性留白撑开，不用绝对定位 —— 这页有 KeyboardAvoidingView，
            绝对定位在键盘弹起时容易被顶飞。 */}
        <View style={s.copyFlex} />
        <Text style={s.copyright} allowFontScaling={false}
          pointerEvents="none">老技术员原创，仿冒必究</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: MC.bg },
  scroll: { flexGrow: 1, paddingHorizontal: 30, paddingTop: 210, paddingBottom: 60 },
  mark: { color: MC.accent, fontSize: 12, letterSpacing: 4, opacity: 0.68, marginBottom: 14 },
  title: { color: MC.text, fontSize: 26, fontWeight: '700', marginBottom: 46 },
  label: { color: MC.textDim, fontSize: 12.5, marginBottom: 9, marginTop: 6 },
  field: { flexDirection: 'row', alignItems: 'center', backgroundColor: MC.bgCard,
    borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, minHeight: 54, marginBottom: 22 },
  input: { flex: 1, color: MC.text, fontSize: MC_SIZE.bodySize, paddingVertical: 14, padding: 0 },
  fieldIco: { color: MC.textDim, fontSize: 15, paddingLeft: 10 },
  btn: { backgroundColor: MC.accent, borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginTop: 14, shadowColor: MC.accent, shadowOpacity: 0.30,
    shadowRadius: 16, elevation: 6 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  copyFlex: { flexGrow: 1, minHeight: 28 },
  copyright: { color: MC.textDim, fontSize: 11, letterSpacing: 1.5, opacity: 0.45,
    textAlign: 'center', paddingBottom: 4 },
})
