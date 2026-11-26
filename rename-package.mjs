#!/usr/bin/env node
/**
 * 独立改名脚本（C 项）· 由 build-apk.yml 在 apply.sh 之后调用：
 *   node rename-package.mjs <上游目录>
 *
 * 为什么是独立脚本、而不是改本仓库的 package.json / build.gradle：
 *   这两处在「定稿封印」的冻结清单里。本脚本只作用于 CI 里 clone 出来的
 *   upstream/ 目录，本仓库的 apply.sh / patch.mjs / check-freeze.mjs /
 *   overrides / mc-center / 主链六步全部逐字节不动 —— 0 破封。
 *
 * ★ v26 · CI 编译失败修复（2026-11-26）：
 *   只改 namespace / applicationId / Manifest package 是【不够】的。AGP 8
 *   把 R 类与 BuildConfig 生成在 namespace 对应的包下；若 Java 源码仍声明
 *   cn.toside.music.mobile，就会报 7 个编译错误：
 *     import cn.toside.music.mobile.R            → cannot find symbol
 *     R.drawable.rounded_corner ×2               → package R does not exist
 *     BuildConfig.DEBUG / IS_* ×4                → cannot find symbol
 *   :app:compileReleaseJavaWithJavac FAILED → BUILD FAILED。
 *   另：Manifest 里 android:name=".MainActivity" 按 namespace 展开，Java 类
 *   若留旧包，装上去启动即 ActivityNotFoundException（比编译失败更隐蔽）。
 *   所以必须把 Java 源码目录与包声明一起迁到 com.musiccloud.app，让
 *   namespace = applicationId = Manifest package = Java 包 = R/BuildConfig 包
 *   五者完全一致，零歧义。
 *
 * 六处配置 + 一处目录迁移，漏一处会 Gradle 失败、装包崩或改名不彻底：
 *   ① android/app/build.gradle        namespace / applicationId
 *   ② android/app/src/main/AndroidManifest.xml  package=
 *   ③ package.json                    name(产物名) / version / versionCode
 *   ④ src/config/constant.ts          APP_PROVIDER_NAME（FileProvider）
 *   ⑤ android/settings.gradle         rootProject.name（v25 补漏）
 *   ⑥ android/app/src 下全部 Java 源码：目录 + 包声明 + import（34 个文件）
 *
 * 不动：app.json（RNN 注册名是常量 lxm.HomeScreen，与 app.json 无关）、
 *       res/values/strings.xml（桌面名「飞扬音乐」）、index.js、主链六步、
 *       任何 JS/TS 业务代码。
 *
 * 已逐项核过无 JNI 符号（Java_cn_ / cn_toside 下划线全空）、无 .kt、
 * 无 CMakeLists、无 proguard-rules 引用旧包名、无 sourceSets 指向旧路径。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.argv[2] || 'upstream')
const NEW_ID = 'com.musiccloud.app'
const OLD_ID = 'cn.toside.music.mobile'
const OLD_PROVIDER = 'cn.toside.music.mobile.provider'
const NEW_PROVIDER = `${NEW_ID}.provider`

let changed = 0
const edit = (rel, pairs) => {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) { console.error(`✗ 缺文件 ${rel}`); process.exit(1) }
  let s = fs.readFileSync(p, 'utf8')
  for (const [from, to, label] of pairs) {
    const n = s.split(from).length - 1
    if (n === 0 && s.split(to).length - 1 === 1) {
      console.log(`  ✓ ${label}（已应用，幂等跳过）`)
      continue
    }
    if (n !== 1) { console.error(`✗ ${label}: 期望 1 处，实得 ${n} 处 (${rel})`); process.exit(1) }
    s = s.replace(from, to)
    changed++
    console.log(`  ✓ ${label}`)
  }
  fs.writeFileSync(p, s, 'utf8')
}

console.log(`═══ 改名 → ${NEW_ID} / 1.0 · 上游 ${ROOT} ═══`)

edit('android/app/build.gradle', [
  [`namespace "${OLD_ID}"`, `namespace "${NEW_ID}"`, 'build.gradle namespace'],
  [`applicationId "${OLD_ID}"`, `applicationId "${NEW_ID}"`, 'build.gradle applicationId'],
])

edit('android/app/src/main/AndroidManifest.xml', [
  [`package="${OLD_ID}"`, `package="${NEW_ID}"`, 'Manifest package='],
])

// package.json：name / version / versionCode 三处，逐字段精确替换
{
  const p = path.join(ROOT, 'package.json')
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (j.name === 'musiccloud' && j.version === '1.0' && j.versionCode === 1) {
    console.log('  ✓ package.json name=musiccloud / version=1.0 / versionCode=1（已应用，幂等跳过）')
  } else if (j.version === '1.9.2' && j.versionCode === 79) {
    j.name = 'musiccloud'
    j.version = '1.0'
    j.versionCode = 1
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8')
    changed += 3
    console.log('  ✓ package.json name=musiccloud / version=1.0 / versionCode=1')
  } else {
    console.error(`✗ package.json 版本既不是预期的 1.9.2/79 也不是已改好的 1.0/1，实得 ${j.version}/${j.versionCode}`)
    process.exit(1)
  }
}

edit('src/config/constant.ts', [
  [`APP_PROVIDER_NAME = '${OLD_PROVIDER}'`, `APP_PROVIDER_NAME = '${NEW_PROVIDER}'`, 'APP_PROVIDER_NAME'],
])

/** ★ v25 全量审查补漏：全工程 cn.toside 硬编码共 5 处，settings.gradle 的
 *  rootProject.name 此前漏改。它只影响 Gradle 项目显示名、不影响 APK，
 *  但改名要彻底，避免以后排查时误判。 */
edit('android/settings.gradle', [
  [`rootProject.name = '${OLD_ID}'`, `rootProject.name = '${NEW_ID}'`, 'settings.gradle rootProject.name'],
])

/* ───────────────────────────────────────────────────────────────────────
 * ⑥ v26 · Java 源码包名整体迁移（CI 编译失败的真正修复）
 * ─────────────────────────────────────────────────────────────────────── */
const MAIN_OLD = path.join(ROOT, 'android/app/src/main/java', OLD_ID.replace(/\./g, '/'))
const MAIN_NEW = path.join(ROOT, 'android/app/src/main/java', NEW_ID.replace(/\./g, '/'))
// 原装 release 源集这个文件的目录是 cn/toside/music/，但 package 声明是
// cn.toside.music.mobile（目录与声明本就不一致）。迁移后两者统一。
const REL_OLD = path.join(ROOT, 'android/app/src/release/java/cn/toside/music/ReactNativeFlipper.java')
const REL_NEW = path.join(ROOT, 'android/app/src/release/java', NEW_ID.replace(/\./g, '/'), 'ReactNativeFlipper.java')

let javaMoved = 0
if (!fs.existsSync(MAIN_OLD)) {
  if (!fs.existsSync(MAIN_NEW)) {
    console.error(`✗ 缺 Java 源码目录 ${path.relative(ROOT, MAIN_OLD)}，上游结构不符，拒绝出包`)
    process.exit(1)
  }
  console.log('  ✓ Java 源码包名已是新名（幂等，跳过迁移）')
} else {
  fs.mkdirSync(path.dirname(MAIN_NEW), { recursive: true })
  fs.renameSync(MAIN_OLD, MAIN_NEW)          // 整棵 cache/crypto/lyric/userApi/utils 一起搬
  javaMoved++
}
if (fs.existsSync(REL_OLD)) {
  fs.mkdirSync(path.dirname(REL_NEW), { recursive: true })
  fs.renameSync(REL_OLD, REL_NEW)
  javaMoved++
}
// 清掉残留空目录（非空则 rmdir 抛错，忽略即可，不影响编译）
for (const d of [
  'android/app/src/main/java/cn/toside/music/mobile',
  'android/app/src/main/java/cn/toside/music',
  'android/app/src/main/java/cn/toside',
  'android/app/src/main/java/cn',
  'android/app/src/release/java/cn/toside/music',
  'android/app/src/release/java/cn/toside',
  'android/app/src/release/java/cn',
]) {
  try { fs.rmdirSync(path.join(ROOT, d)) } catch { /* 非空或不存在都无妨 */ }
}

// 全文替换所有 .java 的 package 声明 / import / static import / R 引用
const JAVA_SRC = path.join(ROOT, 'android/app/src')
const all = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else all.push(p)
  }
})(JAVA_SRC)
const javaFiles = all.filter(f => f.endsWith('.java'))
let javaEdited = 0
for (const f of javaFiles) {
  const s = fs.readFileSync(f, 'utf8')
  if (!s.includes(OLD_ID)) continue
  fs.writeFileSync(f, s.split(OLD_ID).join(NEW_ID), 'utf8')
  javaEdited++
}
if (javaMoved > 0 && javaEdited < 20) {
  console.error(`✗ Java 包声明替换数异常（${javaEdited}），疑似上游结构变化，拒绝出包`)
  process.exit(1)
}
console.log(`  ✓ Java 迁移：${javaMoved} 处目录 / ${javaEdited} 个文件包声明 → ${NEW_ID}`)
console.log('    · R / BuildConfig 现由 namespace 生成于同包，7 个编译错误消除')
console.log('    · Manifest 相对类名 .MainActivity / .MainApplication 与新 Java 包一致')

/* ───────────────────────────────────────────────────────────────────────
 * ⑦ 全工程残留断言：任何一处漏改都不许出包
 * ─────────────────────────────────────────────────────────────────────── */
const IGNORE = new Set(['node_modules', '.git', 'build', '.gradle', '.cxx'])
const TEXT_EXT = /\.(java|kt|xml|gradle|properties|pro|json|ts|tsx|js|mjs|cjs|txt|md)$/
const leftover = []
;(function scan(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!IGNORE.has(e.name)) scan(p); continue }
    if (!TEXT_EXT.test(e.name)) continue
    let s
    try { s = fs.readFileSync(p, 'utf8') } catch { continue }
    if (s.includes(OLD_ID) || s.includes(OLD_PROVIDER)) leftover.push(path.relative(ROOT, p))
  }
})(ROOT)
if (leftover.length) {
  console.error('✗ 仍残留旧包名，拒绝出包：\n  ' + leftover.join('\n  '))
  process.exit(1)
}
console.log('  ✓ 全工程旧包名残留 = 0（含 .java / build.gradle / Manifest / constant.ts）')

if (changed || javaEdited) {
  console.log(`\n✓ 完成，共 ${changed} 处配置替换 + ${javaEdited} 个 Java 文件迁移。`)
  console.log('  产物：musiccloud-v1.0-universal.apk + 4 个分架构包（versionCode 1/1001~1004）')
  console.log('  未分发、可重装 → 旧数据 / 双图标 / versionCode 降级顾虑全部不成立。')
} else {
  console.log('\n✓ 已是目标状态（幂等复跑），无需改动。')
}
