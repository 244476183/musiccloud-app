/**
 * 本地联调检查（不进 GitHub workflow，随手跑一次即可）
 *   node 本地检查.mjs
 *
 * 零第三方依赖：Node 24 的 stripTypeScriptTypes 剥离类型，
 * node:http 起一个模拟「中心 1.4 被动货架」的三端点服务，
 * 真实加载 files/src/mc-center/index.ts，验证整条取源链路。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0, fail = 0
const ck = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' ← ' + extra : ''}`) }

/* ── 1. 模拟中心 1.4 三端点（语义与真实服务端一致）── */
const SCRIPTS = {
  'a.js': '/**\n * @name A源\n */\nconst a = 1\n',
  '中文 音源(测试).js': '/**\n * @name 中文源\n */\nconst b = 2\n',
}
let emptyManifest = false
const hash = s => createHash('sha256').update(s).digest('hex')
const hits = []
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  hits.push(u.pathname + '?' + u.searchParams.toString())
  if (u.searchParams.get('deviceId') !== 'phone1' || u.searchParams.get('token') !== 'tk1') {
    res.writeHead(401); return res.end('{}')
  }
  if (u.pathname === '/mc/app/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, mode: 'passive-shelf' }))
  }
  if (u.pathname === '/mc/app/manifest') {
    const sources = emptyManifest ? [] : Object.entries(SCRIPTS).map(([file, s], i) => ({
      id: 's' + i, name: file, file, sha256: hash(s), lxEnv: 'quickjs',
    }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ protocol: 'mc-app-1', mode: 'passive-shelf', version: 1, sources,
      needMobileSources: sources.length === 0 }))
  }
  if (u.pathname === '/mc/app/source') {
    const file = u.searchParams.get('file') || ''
    const s = SCRIPTS[file]
    if (!s) { res.writeHead(404); return res.end('{}') }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
    return res.end(s)
  }
  res.writeHead(404); res.end('{}')
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port

/* ── 2. 真实加载中心模块（剥离 TS 类型 + 注入 mock 边界）── */
const cfg = { centerBaseUrl: `http://127.0.0.1:${PORT}`, deviceId: 'phone1', token: 'tk1',
  intervalSec: 60, requestTimeoutMs: 3000 }
const store = new Map()
let apis = []
const calls = { import: [], remove: [] }
globalThis.__cfg__ = cfg
globalThis.__storage__ = {
  getData: async k => store.get(k), saveData: async(k, v) => store.set(k, v),
}
globalThis.__data__ = { getUserApiList: async() => [...apis] }
globalThis.__userApi__ = {
  importUserApi: async s => { calls.import.push(s); apis.push({ id: 'ua_' + apis.length }) },
  removeUserApi: async ids => { calls.remove.push(...ids); apis = apis.filter(a => !ids.includes(a.id)) },
}
globalThis.__rn__ = { AppState: { addEventListener: () => ({ remove() {} }) } }

let src = fs.readFileSync(path.join(HERE, 'files/src/mc-center/index.ts'), 'utf8')
src = src.replace(/^import .*$/gm, '')           // 5 行 import 换成下面的注入
const prelude = `
const cfg = globalThis.__cfg__;
const { getData, saveData } = globalThis.__storage__;
const { getUserApiList } = globalThis.__data__;
const { importUserApi, removeUserApi } = globalThis.__userApi__;
const { AppState } = globalThis.__rn__;
`
const js = stripTypeScriptTypes(prelude + src, { mode: 'strip' })
const tmp = path.join(os.tmpdir(), 'mc-center-check-' + process.pid + '.mjs')
fs.writeFileSync(tmp, js)
const mod = await import(pathToFileURL(tmp).href + '?t=' + Date.now())
const start = mod.default
ck('模块导出 initCenterSource 函数', typeof start === 'function')

/* ── 3. 未配置 ⇒ 完全不跑 ── */
cfg.deviceId = ''; cfg.token = ''
const before = hits.length
start()
await new Promise(r => setTimeout(r, 250))
ck('未配置时零网络请求（100% 原装行为）', hits.length === before)
cfg.deviceId = 'phone1'; cfg.token = 'tk1'

/* ── 4. 配置后跑一轮 ── */
start()
await new Promise(r => setTimeout(r, 900))
ck('GET /mc/app/manifest 被调用', hits.some(h => h.startsWith('/mc/app/manifest')))
const srcHits = hits.filter(h => h.startsWith('/mc/app/source'))
ck('GET /mc/app/source 对每个源各一次', srcHits.length === 2, '实际 ' + srcHits.length)
ck('中文/括号/空格文件名已编码且服务端能还原',
  srcHits.some(h => !h.includes('file=a.js')) && calls.import.length === 2)
ck('importUserApi 收到 2 份脚本', calls.import.length === 2, '实际 ' + calls.import.length)
ck('脚本原文逐字节一致', calls.import.every(s => SCRIPTS['a.js'] === s || SCRIPTS['中文 音源(测试).js'] === s))
ck('模块未引用播放器/取链/选源', !/setApiSource|setUserApi\(|loadScript|TrackPlayer|getMusicUrl|musicSdk/.test(
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))

/* ── 5. 第二轮：内容未变 ⇒ 不重复导入 ── */
const n1 = calls.import.length
start()
await new Promise(r => setTimeout(r, 700))
ck('sha256 未变时不重复导入', calls.import.length === n1, `${n1} → ${calls.import.length}`)
ck('去重记录已落盘', store.has('mc_center_imported_v1'))

/* ── 6. 中心返回空清单 ⇒ 静默不崩 ── */
emptyManifest = true
const n2 = calls.import.length
start()
await new Promise(r => setTimeout(r, 600))
ck('中心 0 个移动版源时静默跳过', calls.import.length === n2)

/* ── 7. 脚本内容变更 ⇒ 先删旧再导新 ── */
emptyManifest = false
SCRIPTS['a.js'] = '/**\n * @name A源 v2\n */\nconst a = 99\n'
const n3 = calls.import.length
start()
await new Promise(r => setTimeout(r, 800))
ck('源内容更新时重新导入', calls.import.length === n3 + 1, `${n3} → ${calls.import.length}`)
ck('更新时先调原装 removeUserApi 删旧', calls.remove.length >= 1)

fs.rmSync(tmp, { force: true })
srv.close()
console.log(`\n═══ 本地联调检查：${pass}/${pass + fail} ═══`)
process.exit(fail ? 1 : 0)
