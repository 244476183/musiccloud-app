# v26 · GitHub Actions 编译失败修复说明（2026-11-26）

## 失败点
日志 `11:17:51`：`:app:compileReleaseJavaWithJavac FAILED`，7 个错误 → `BUILD FAILED in 4m 17s`。

```
LyricView.java:29   import cn.toside.music.mobile.R   → cannot find symbol
LyricView.java:335/511  R.drawable.rounded_corner      → package R does not exist
MainApplication.java:24/48/53/66  BuildConfig.*        → cannot find symbol
```

## 根因
C 项改名只改了 6 处配置（build.gradle 的 namespace / applicationId、Manifest package、
package.json、src/config/constant.ts 的 APP_PROVIDER_NAME、settings.gradle），
但 `android/app/src` 下 **35 个 Java 文件仍声明 `cn.toside.music.mobile`**。

AGP 8 把 `R` 类与 `BuildConfig` 生成在 **namespace 对应的包**下（即 `com.musiccloud.app`），
Java 却仍去 `cn.toside.music.mobile` 找，于是编译失败。
更隐蔽的一层：Manifest 里 `android:name=".MainActivity"` 按 namespace 展开成
`com.musiccloud.app.MainActivity`，Java 类若留旧包，即使编过，装上去启动也会
`ActivityNotFoundException`。

## 修法（只改 rename-package.mjs）
在原有 6 处配置替换之后，增加：

1. **⑥ Java 源码整体迁移**
   - `main/java/cn/toside/music/mobile/` → `main/java/com/musiccloud/app/`（整棵目录搬）
   - `release/java/cn/toside/music/ReactNativeFlipper.java` → `release/java/com/musiccloud/app/`
   - 35 个 `.java` 全文替换 package 声明 / import / static import
   - 清掉旧空目录
   - 结果：namespace = applicationId = Manifest package = Java 包 = R/BuildConfig 包，五者一致
2. **⑦ 全工程残留断言**：扫 upstream 全部文本文件，`cn.toside.music.mobile` 残留必须为 0，
   否则 `process.exit(1)` 拒绝出包（把「漏改一处」变成硬红灯）
3. 脚本改为**可重复执行**（幂等），二次运行不会误报红

已逐项核过：无 JNI 符号、无 .kt、无 CMakeLists、无 proguard-rules 引用旧包名、
无 sourceSets 指向旧路径 —— 整棵 Java 目录搬迁是安全的。
`app.json` / strings.xml（桌面名）/ index.js / 主链六步一律不动。

**本仓库改动清单**：`rename-package.mjs`（修复）+ `基线清单.json`（重定该文件哈希与版本说明）。
`apply.sh` / `patch.mjs` / `check-freeze.mjs` / `build-apk.yml` / `overrides/` / `mc-center`
/ 取链六步全部逐字节未动。

## 验证（沙盒内，真实上游副本）
- fresh 首跑：39 个旧包名命中 → **0**；35 个 Java 文件全部落 `com/musiccloud/app/`
- `LyricView.java` → `import com.musiccloud.app.R`；`BuildConfig` 与 MainApplication 同包
- Manifest `.MainApplication` / `.MainActivity` 均能找到对应 Java 类
- Java 编译期一致性静态检查 **0 不一致**（35 文件，含 3 条 static import 按类解析）
- 幂等复跑：`✓ 已是目标状态，无需改动`
- 封印 **48/0**、本地联调 **13/13**
- `node --check rename-package.mjs` 通过

## 怎么推到 GitHub（不用删库）
仓库**根目录**覆盖这两个文件即可：
- `rename-package.mjs`
- `基线清单.json`

`.github/workflows/build-apk.yml` **不用动**（它没有变，哈希未改）。
然后 Actions → `build-musiccloud-apk` → **Run workflow** → 下载 `musiccloud-1.0-apk`。

CI 里 `rename-package.mjs` 会在 `apply.sh` 之后自动执行，日志会多出：
```
✓ Java 迁移：2 处目录 / 35 个文件包声明 → com.musiccloud.app
✓ 全工程旧包名残留 = 0
```

## 如实边界
沙盒没有 Android SDK / Gradle，本地**无法真编译**；最终以 CI 的
`BUILD SUCCESSFUL` + artifact 为准。
日志里其它输出均非失败原因，不动：附注 tag 的 `is not a commit` warning、
`setup-java@v4` 弃用、AGP `compileSdk 36` 建议、npm deprecated 依赖告警、
`git diff 6 insertions/11 deletions`（冻结区过时提示文案，实际只改 1 个文件）。
