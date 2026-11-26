/**
 * ★ v32 / P：音源「发现新版本」弹窗永久压制
 *   零破封 / 零主链 diff / 零新增定时器 / 零新增 Modal / 不加载或重载任何脚本。
 *
 * 弹窗链路（逐行核实）：
 *   脚本 lx.send('updateAlert') → preload → 原生 api-action('showUpdateAlert')
 *   → utils/nativeModules/userApi.ts:88 `if (!loadScriptInfo?.allowShowUpdateAlert) return`
 *   → 否则 core/init/userApi/index.ts:192 showUpdateAlert() → confirmDialog / tipDialog。
 *
 * 唯一开关是 `allowShowUpdateAlert`。addUserApi(utils/data.ts:564) 写死 true，
 * 所以「服务端改脚本内容 → mc-center 删旧条目重导 → 新 id 的 flag 回 true」会让
 * 「点一次关闭」失效。本模块订阅 list_changed，每次列表变化都压回 false，
 * 正好覆盖「换源是服务端的事」这条路径；不碰 mc-center（冻结区）。
 *
 * ★ 冷启时序（本轮实证：两条保障都指向同一结果，互不冲突）：
 *   initUserApi 末尾 setUserApiList() 发 list_changed（Event.emit 是 setImmediate 异步），
 *   init/index.ts 紧接着 setApiSource() → setUserApi() 里 `state.list.find` 取到 target，
 *   再 `await getUserApiScript(target.id)`，最后才 `loadScript({...target})`。
 *   ① core 包装第一步 utils/data.setUserApiAllowShowUpdateAlert 会【同步】执行
 *      `targetApi.allowShowUpdateAlert = enable`；而 state.list / userApis / target
 *      经 getUserApiList() 是同一批对象引用（已逐行核实），target 立即变 false。
 *   ② 本模块另外【就地改 list 元素】，让守卫在同步阶段就收敛，并在上游将来
 *      改成返回拷贝、或列表被拆成两套对象时仍然成立（冗余保险，值相同）。
 *   两条叠加 → loadScript 展开必拿到 false，冷启第一次也不会弹。
 *
 * 收敛守卫：只对 flag !== false 的条目动手；core 包装内部再次 emit list_changed 时
 * 全部已是 false → 回调直接跳过，不会形成 setImmediate 风暴。
 *
 * 模块顶层注册（bundle 求值期，早于 core/init 的 setUserApiList）；ESM 只求值一次，幂等。
 */
import { event } from '@/store/userApi/event'
import { state } from '@/store/userApi/state'
import { setUserApiAllowShowUpdateAlert } from '@/core/userApi'

const suppress = (list: LX.UserApi.UserApiInfo[]): void => {
  if (!Array.isArray(list)) return
  for (const api of list) {
    if (!api || api.allowShowUpdateAlert === false) continue
    // ① 就地改引用：覆盖 setUserApi 已取到、正在 await 的 target
    api.allowShowUpdateAlert = false
    // ② 落盘 + 同步 action（替换数组元素，但值仍是 false），保证重启后不回弹
    void setUserApiAllowShowUpdateAlert(api.id, false).catch(() => {})
  }
}

event.on('list_changed', suppress)
suppress(state.list)

export {}
