# 洛雪原装 v1.9.2 ＋ 中心取音源

**之前所有 APP 项目已全部抛弃，一点不留。** 这个包从官方原装 `lyswhut/lx-music-mobile` 的
`v1.9.2`（HEAD `0669d1b6…`）重新起步，**只加一个功能**：后台从中心「被动货架」同步音源 js，
交给洛雪原装 `importUserApi()` 落库。

除此之外 **UI、应用名、图标、权限、启动弹框、取链、播放、通知栏、状态机 —— 全部原装，一行未改**。

---

## 它到底加了什么

```
后台定时 GET 中心清单 → GET 每个 js 原文 → 原装 importUserApi() 落库
```

然后你在**原版洛雪「设置 → 自定义音源」**里就能看到并选用这些源。选源之后的一切
（`setApiSource → loadScript → QuickJS → getMusicUrl → TrackPlayer`）**全是原装链路**，本模块不再参与。

明确不做：不选源、不取链、不播放、不加 UI、不弹框、不改任何显示、不阻塞启动。
`config.json` 未填 deviceId/token 时模块**直接不运行**，此时 APK 等价于 100% 未修改的官方原版。

---

## 出包 4 步

1. **解压**，编辑 `files/src/mc-center/config.json`，填 `centerBaseUrl` / `deviceId` / `token`
   （deviceId 和 token 在中心后台「设备白名单」加一台 `target=app` 的设备后获得）。
   详见 `中心取源配置说明.md`。
2. **整包推到 GitHub 仓库**（不要传 zip 本身，传解压后的文件）。
3. 网页新建 `.github/workflows/build-apk.yml`，把包里 **`build-apk.yml` 全文复制粘贴**进去，保存。
4. Actions 页手动 **Run workflow** → 下载 artifact `lxmusic-center-apk` → 安装。

装完打开就是**原版洛雪界面**（名称「洛雪音乐助手」、原版图标；首次启动的原版协议/防骗提示属正常）。
到「设置 → 自定义音源」选一个中心同步来的源，即可正常搜播。

---

## 包里有什么

| 文件 | 作用 |
|---|---|
| `build-apk.yml` | GitHub Actions 出包 workflow（8 步，全程无自检阻断） |
| `apply.sh` | 打补丁：完整性校验 → 复制 3 个新文件 → init 插 2 行 → 生成签名配置 |
| `patch.mjs` | 幂等挂载脚本，只往 `src/core/init/index.ts` 插 2 行 |
| `files/src/mc-center/` | **唯一新增代码**：`index.ts` + `config.json` + `README.md` |
| `本地检查.mjs` | 本地联调检查（可选，需 Node 22+：`node 本地检查.mjs`，不进 workflow） |
| `原装改动清单.md` | 前后逐字节对账表，证明原装只被加了 2 行 |
| `服务端核查报告.md` | 对最新 1.4 服务端的实测排查结论 |
| `中心取源配置说明.md` | 填配置与后台标记音源的步骤 |

---

## 🔒 定稿封印（2026-11-24 真机验收通过）

**本版已定稿锁死。以后只允许改 UI 和 3 项不影响主程序的权限，整条链路一个字都不许碰。**

任何一轮新对话 / 任何一次改动之前，**先读 `定稿封印.md`**；改完必跑：

```bash
node check-freeze.mjs      # 红灯 = 不许推、不许出包
```

约束靠 `定稿封印.md` + `基线清单.json`（哈希）+ `check-freeze.mjs`，不靠 AI 记忆。
刻意不挂进 workflow —— `build-apk.yml` 保持 8 步零阻断，这道闸在**本地提交前**。

---

## 如实边界

- **没有真机**。这里的验证是「完整原装上游 + 补丁前后逐字节对账 + 中心模块真实联调 + 服务端真实起服实测」，
  不等于 Android 真机上 ExoPlayer 首帧/音频焦点/QuickJS 的验收。
- 服务端只下发 js 原文，**不参与取链与播放**。之前「打开一直连接音源 / 恒 0 / 死循环跳歌」
  的元凶在已被抛弃的自建 APP 层，与服务端代码无关；但服务端有 3 个**配置点**会直接造成无源，
  必须核对，见 `服务端核查报告.md`。
- 音源脚本本身是否能在手机 QuickJS 里出声，仍需你用**洛雪原版**逐个验证后再在后台标记。
  报告里点名了 3 个「远程加载器」脚本，标了会让原装 init 一直等不到 `inited`。
- release 签名复用仓库自带 `debug.keystore`（不改 `build.gradle` 一行），可覆盖安装；正式分发请换自有 keystore。
