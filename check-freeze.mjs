#!/usr/bin/env node
/**
 * 定稿封印核对 · 提交前 / 出包前必跑：node check-freeze.mjs [仓库根目录]
 *
 * 刻意不进 GitHub workflow（workflow 保持 8 步零阻断，见 定稿封印.md 第四节）。
 * 红灯 = 不许推、不许 Run workflow、先回滚。
 *
 * 校验 6 项：冻结区哈希 / 冻结文件哈希 / config 结构锁 / 新增文件白名单 /
 *            overrides 路径与 Manifest 最小 diff / 守门件自检。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)))
const CFG = path.join(ROOT, '基线清单.json')
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
const rel = p => path.relative(ROOT, p).split(path.sep).join('/')

let pass = 0, fail = 0, warn = 0
const ok = (n, extra = '') => { pass++; console.log('  ✓ ' + n + (extra ? ' ← ' + extra : '')) }
const bad = (n, extra = '') => { fail++; console.log('  🔴 ' + n + (extra ? ' ← ' + extra : '')) }
const note = (n) => { warn++; console.log('  🟡 ' + n) }

if (!fs.existsSync(CFG)) { console.error('✗ 缺 基线清单.json，守门失效'); process.exit(1) }
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'))

/* 收集当前文件（排除构建产物与上游目录） */
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'upstream', 'out', 'dist', '__MACOSX'])
const files = []
const walk = d => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) walk(path.join(d, e.name)); continue }
    if (e.name.endsWith('.zip') || e.name.startsWith('.')) continue
    files.push(path.join(d, e.name))
  }
}
walk(ROOT)
const byRel = new Map(files.map(p => [rel(p), p]))

console.log('\n═══ 定稿封印核对 · ' + cfg.version + ' ═══')
console.log('  上游: ' + cfg.upstream.repo + ' @ ' + cfg.upstream.tag + ' (' + cfg.upstream.head.slice(0, 12) + '…)\n')

/* ① apply.sh 冻结区：按标记切分，扩展区放行 */
console.log('── ① 冻结区（apply.sh 标记以上）──')
const ap = byRel.get('apply.sh')
if (!ap) bad('apply.sh 缺失')
else {
  const txt = fs.readFileSync(ap, 'utf8')
  if (!txt.includes(cfg.applyFreezeMarker)) bad('apply.sh 冻结标记被删（禁止）')
  else {
    const frozen = txt.split(cfg.applyFreezeMarker)[0]
    const got = sha(Buffer.from(frozen))
    got === cfg.frozenApplySha256 ? ok('冻结区逐字节一致', got.slice(0, 16))
      : bad('冻结区被改', `期望 ${cfg.frozenApplySha256.slice(0, 16)} / 实得 ${got.slice(0, 16)}`)
  }
}

/* ② 冻结文件 */
console.log('── ② 冻结文件哈希 ──')
for (const [f, want] of Object.entries(cfg.frozenFiles)) {
  const p = byRel.get(f)
  if (!p) { bad(f + ' 缺失'); continue }
  const got = sha(fs.readFileSync(p))
  got === want ? ok(f, got.slice(0, 16)) : bad(f + ' 被改', `${want.slice(0, 16)} → ${got.slice(0, 16)}`)
}

/* ③ config.json：值放行，结构锁死 */
console.log('── ③ config.json 结构锁（值可填）──')
const cp = byRel.get('files/src/mc-center/config.json')
if (!cp) bad('config.json 缺失')
else {
  try {
    const c = JSON.parse(fs.readFileSync(cp, 'utf8'))
    const keys = Object.keys(c).sort().join(',')
    const wantKeys = Object.keys(cfg.configKeys).sort().join(',')
    keys === wantKeys ? ok('键集合一致', keys) : bad('键集合被改', `期望 ${wantKeys} / 实得 ${keys}`)
    let typeOk = true
    for (const [k, t] of Object.entries(cfg.configKeys)) {
      const got = Array.isArray(c[k]) ? 'array' : typeof c[k]
      if (got !== t) { typeOk = false; bad(`字段 ${k} 类型`, `期望 ${t} / 实得 ${got}`) }
    }
    if (typeOk) ok('5 个字段类型一致 · 值可自由填', `deviceId=${JSON.stringify(c.deviceId)}`)
  } catch (e) { bad('config.json 非法 JSON', String(e.message || e)) }
}

/* ④ 新增文件白名单 + overrides 路径 + Manifest 最小 diff */
console.log('── ④ 新增文件 / UI 覆盖白名单 ──')
const known = new Set([
  ...Object.keys(cfg.frozenFiles), 'apply.sh', 'files/src/mc-center/config.json',
  ...cfg.documentFiles, ...Object.keys(cfg.guardFiles), '基线清单.json',
])
const hitPrefix = (r, list) => list.some(x => r === x || r.startsWith(x))

const normalizeManifest = txt => txt.split(/\r?\n/)
  .filter(l => !cfg.permissionAllow.some(p => l.includes(p)))
  .join('\n')

let overrideCount = 0
for (const [r, p] of byRel) {
  if (known.has(r)) continue
  const isDoc = r.endsWith('.md') && !r.includes('/')
  if (isDoc) { note('新增文档（放行）: ' + r); continue }
  if (!r.startsWith('overrides/')) { bad('白名单外新增文件', r); continue }
  overrideCount++
  const target = r.slice('overrides/'.length)
  if (hitPrefix(target, cfg.uiDeny)) { bad('overrides 触碰冻结路径', target); continue }
  if (!hitPrefix(target, cfg.uiAllow)) { bad('overrides 路径不在 UI 白名单', target); continue }
  if (path.basename(target) === 'AndroidManifest.xml') {
    const got = sha(Buffer.from(normalizeManifest(fs.readFileSync(p, 'utf8'))))
    got === cfg.manifestNormalizedSha256
      ? ok('Manifest 最小 diff 合规（仅增删 3 项白名单权限）', target)
      : bad('Manifest 改了权限以外的行', target)
    continue
  }
  if (target === 'permissions.json') {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      const badKeys = Object.keys(d).filter(k => !cfg.permissionAllow.includes(k))
      badKeys.length ? bad('permissions.json 含非白名单权限', badKeys.join(',')) : ok('permissions.json 合规', target)
    } catch (e) { bad('permissions.json 非法', String(e.message || e)); continue }
    continue
  }
  if (target === 'app.json') {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      const keys = Object.keys(d).sort().join(',')
      keys === 'displayName,name' && d.name === 'LX Music'
        ? ok('app.json 仅改 displayName（name 保持 LX Music）', target)
        : bad('app.json 动了 name 或键集合（会启动崩）', `${keys} / name=${d.name}`)
    } catch (e) { bad('app.json 非法', String(e.message || e)); continue }
    continue
  }
  ok('UI 覆盖放行', target)
}
if (!overrideCount) ok('当前无任何 UI/权限覆盖（定稿态）')

/* ⑤ 守门件自检 */
console.log('── ⑤ 守门件 ──')
for (const [f, want] of Object.entries(cfg.guardFiles)) {
  const p = byRel.get(f)
  if (!p) { bad('守门件缺失: ' + f); continue }
  const got = sha(fs.readFileSync(p))
  got === want ? ok(f + ' 未被改', got.slice(0, 16)) : bad(f + ' 被改（破锁）', `${want.slice(0, 16)} → ${got.slice(0, 16)}`)
}
note('基线清单.json 无法自校验（自引用）· 改动必须单独一轮、显式确认')

/* ⑥ 可选：本地若有 upstream，核对补丁产物 */
const upInit = path.join(ROOT, 'upstream/src/core/init/index.ts')
if (fs.existsSync(upInit)) {
  const got = sha(fs.readFileSync(upInit))
  got === cfg.patchedInitSha256 ? ok('本地 upstream 的 init 仍是定稿 2 行', got.slice(0, 16))
    : bad('本地 upstream init 与定稿不符', got.slice(0, 16))
}

console.log('\n═══ 汇总：' + pass + ' 通过 / ' + fail + ' 红灯 / ' + warn + ' 提示 ═══')
if (fail) { console.log('🔴 封印不符 → 停手、回滚、不许推、不许出包。'); process.exit(1) }
console.log('✓ 封印完好 · 整条链路未被碰 · 可以提交')
