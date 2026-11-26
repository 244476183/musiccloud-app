# src/mc-center · 中心取音源

本目录是**本工程唯一新增的代码**，其余全部是洛雪 v1.9.2 原装。

## 它做什么

后台定时从中心「被动货架」拉音源清单与 js 原文，交给洛雪原装
`importUserApi()` 落库。之后你在**原版洛雪设置 → 自定义音源**里就能看到并选用这些源。

## 它不做什么

- 不选源、不取链、不播放 —— `setApiSource` / `loadScript` / TrackPlayer 一律不碰
- 不加任何 UI、不改界面、不弹框
- 不改应用名、图标、权限、网络安全配置、启动弹框
- 不阻塞启动（`init()` 里 `void` 调用，全部 try/catch 静默）

**未配置 `config.json` 里的 deviceId/token 时，本模块直接不运行，APP 等价于 100% 原装。**

## 配置

编辑同目录 `config.json`：

| 字段 | 说明 |
|---|---|
| `centerBaseUrl` | 中心地址，如 `http://192.168.88.9:7575` |
| `deviceId` / `token` | 在中心后台「设备白名单」加一台 `target=app` 的设备后填入 |
| `intervalSec` | 复检间隔秒，默认 60 |
| `requestTimeoutMs` | 单次请求超时，默认 8000 |

改完保存 → 推 GitHub → 重跑 workflow 出包。

## 协议（服务端 1.4 纯货架，全部只读 GET）

- `GET /mc/app/ping?deviceId&token` — 排障用
- `GET /mc/app/manifest?deviceId&token` — 返回只标了「移动版 QuickJS」的源清单
- `GET /mc/app/source?deviceId&token&file=<文件名>` — 返回 js 原文

文件名含中文/括号/空格，模块内已逐个 `encodeURIComponent`（服务端实测不编码会 400）。

## 去重

用原装 `@/plugins/storage` 存 `file → {sha256, id}`。内容未变绝不重复导入；内容变了先
`removeUserApi(旧id)` 再 `importUserApi(新脚本)`。单条失败不影响其它源、下次心跳自动重试。
