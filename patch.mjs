/**
 * 幂等挂载（破封轮，2026-11-25）。
 * 三段独立判定，互不干扰：
 *   ① 往 init/index.ts 插入且仅插入 2 行（沿用定稿锚点）
 *   ② 把 handlePushedHomeScreen 函数体换成空实现，去掉三类启动弹窗
 *   ③ 强制 common.isAgreePact = true（覆盖安装旧版同样生效）
 *
 * ★ 顺序约束：① 的锚点正是 `import { cheatTip }`，② 只置空函数体、保留该 import，
 *   所以 ① 永远找得到锚点；废弃版补丁里「注释掉 import」那步这里不做，避免幂等分支卡死。
 * ★ init() 主链各 await 项一行不动；未用 import 由 Babel 略过（无 noUnusedLocals 检查）。
 */
import fs from 'node:fs'
import path from 'node:path'

const up = process.argv[2]
if (!up) { console.error('缺上游目录参数'); process.exit(1) }

const target = path.join(up, 'src/core/init/index.ts')
let s = fs.readFileSync(target, 'utf8')
const done = []

/* ── ① 挂载取源：只插 2 行 ── */
const MARK_IMPORT = "import initCenterSource from '@/mc-center'"
const MARK_CALL = 'void initCenterSource()'
if (s.includes(MARK_IMPORT) && s.includes(MARK_CALL)) {
  done.push('挂载已存在（幂等，未重复插入）')
} else {
  const anchorImport = "import { cheatTip } from '@/utils/tools'"
  const anchorCall = '  void initSync(setting)'
  if (!s.includes(anchorImport) || !s.includes(anchorCall)) {
    console.error('✗ 上游 v1.9.2 的 init/index.ts 结构不符，拒绝修改')
    process.exit(1)
  }
  if (!s.includes(MARK_IMPORT)) s = s.replace(anchorImport, anchorImport + '\n' + MARK_IMPORT)
  if (!s.includes(MARK_CALL)) s = s.replace(anchorCall, anchorCall + '\n  ' + MARK_CALL)
  done.push('已在 init/index.ts 插入 import + void 调用各 1 行')
}

/* ── ② 去三类启动弹窗（只置空这一个函数体） ── */
const OLD_FN = `let isFirstPush = true
const handlePushedHomeScreen = async() => {
  await cheatTip()
  if (settingState.setting['common.isAgreePact']) {
    if (isFirstPush) {
      isFirstPush = false
      void checkUpdate()
      void initDeeplink()
    }
  } else {
    if (isFirstPush) isFirstPush = false
    showPactModal()
  }
}`
const NEW_FN = `let isFirstPush = true
const handlePushedHomeScreen = async() => {
  // ★ 破封轮：上游三个启动弹框全部去掉
  //   cheatTip()「谨防被骗提示」/ showPactModal()「许可协议」(含 20 秒倒计时) /
  //   checkUpdate()「发现 LX Music 新版本」。
  //   init() 主链一行未动；未用 import 由 Babel 直接略过。
}`
if (s.includes(NEW_FN)) {
  done.push('启动弹框清除（已应用，幂等）')
} else if (s.includes(OLD_FN)) {
  s = s.replace(OLD_FN, NEW_FN)
  done.push('启动弹框清除 → 谨防被骗 / 许可协议 / 版本更新 三框全去')
} else {
  console.error('✗ 未匹配到 v1.9.2 的 handlePushedHomeScreen 原文，拒绝出包')
  process.exit(1)
}
fs.writeFileSync(target, s)

/* ── ③ 双保险：默认设置强制已同意协议 ── */
const def = path.join(up, 'src/config/defaultSetting.ts')
if (fs.existsSync(def)) {
  let d = fs.readFileSync(def, 'utf8')
  if (d.includes("'common.isAgreePact': true")) {
    done.push('默认设置 isAgreePact=true（已应用，幂等）')
  } else if (d.includes("'common.isAgreePact': false")) {
    d = d.replace("'common.isAgreePact': false", "'common.isAgreePact': true")
    fs.writeFileSync(def, d)
    done.push('默认设置 isAgreePact=true（全新/覆盖安装均不弹协议）')
  } else {
    console.warn('⚠ defaultSetting.ts 未匹配 isAgreePact，跳过（② 已置空函数体，不影响）')
  }
} else {
  console.warn('⚠ 缺 defaultSetting.ts，跳过 ③')
}

done.forEach(x => console.log('  ✓ ' + x))
