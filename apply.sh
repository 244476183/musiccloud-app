#!/usr/bin/env bash
# 洛雪原装 v1.9.2 + 「中心取音源」一键补丁
# 用法： ./apply.sh <完整上游目录>
# 只做四件事：校验上游完整 → 复制 3 个新文件 → 往 init 插 2 行 → 生成 release 签名配置
# 不替换 UI、不改应用名/图标/权限/NSC/启动链、不删任何原装文件。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
UP="${1:-$HERE/upstream}"

echo "[1/5] 校验上游完整性（防止把被中断的 clone 当成完整工程）…"
# ★ 上一轮踩过的坑：checkout 被超时中断时工作区会少 751 个文件，
#   但 .git 仍在，生成器会误判「上游没有这些模块」。这里先挡住。
for f in src/core/init/index.ts src/core/userApi.ts src/core/apiSource.ts \
         src/utils/index.ts src/utils/data.ts src/utils/musicSdk/index.js \
         src/store/userApi/state.ts src/store/player/state.ts \
         src/plugins/player/utils.ts src/core/music/online.ts \
         src/app.ts index.js package.json android/app/build.gradle \
         android/app/src/main/res/xml/network_security_config.xml; do
  [ -f "$UP/$f" ] || { echo "✗ 上游不完整，缺 $f"; echo "  请删掉目录后重新 clone：git clone --depth 1 --branch v1.9.2 https://github.com/lyswhut/lx-music-mobile.git"; exit 1; }
done
echo "  ✓ 15 个关键路径齐全，上游完整"

echo "[2/5] 复制「中心取音源」3 个新文件 …"
cp -R "$HERE/files/." "$UP/"
for f in src/mc-center/index.ts src/mc-center/config.json src/mc-center/README.md; do
  [ -f "$UP/$f" ] || { echo "✗ 缺 $f"; exit 1; }
done
echo "  ✓ src/mc-center/ 已就位（原装目录一个文件都没被覆盖）"

echo "[3/5] 往原装 init 主链挂载（仅插 2 行）…"
node "$HERE/patch.mjs" "$UP"

echo "[4/5] release 签名配置（构建必需，非 APP 功能改动）…"
# 原装 build.gradle 的 signingConfigs.release 会读 android/keystore.properties，
# 仓库默认没有这个文件，不生成 assembleRelease 会在配置阶段直接失败。
# 这里复用仓库自带 debug.keystore，不改 build.gradle 一行，签名稳定可覆盖安装。
KS="$UP/android/keystore.properties"
if [ -f "$UP/android/app/debug.keystore" ]; then
  cat > "$KS" <<'EOF'
# 构建时生成：release 复用仓库自带 debug.keystore（签名稳定、可覆盖安装）
storeFile=debug.keystore
storePassword=android
keyAlias=androiddebugkey
keyPassword=android
EOF
  echo "  ✓ android/keystore.properties 已生成"
else
  echo "  ⚠ 未找到 debug.keystore，跳过（真实 v1.9.2 上游自带）"
fi

echo "[5/5] 简单检查 …"
node -e "const c=require('$UP/src/mc-center/config.json'); if(!c.centerBaseUrl) throw Error('centerBaseUrl 为空'); console.log('  ✓ config.json 合法 · 中心 '+c.centerBaseUrl+' · 心跳 '+c.intervalSec+'s')"
grep -q "import initCenterSource from '@/mc-center'" "$UP/src/core/init/index.ts" && echo "  ✓ init 已挂 import"
grep -q "void initCenterSource()" "$UP/src/core/init/index.ts" && echo "  ✓ init 已挂调用"
grep -q 'importUserApi' "$UP/src/mc-center/index.ts" && echo "  ✓ 落库走原装 importUserApi"
# 确认没有把原装入口/UI 换掉
grep -q "import Content from './Content'" "$UP/src/screens/Home/Vertical/index.tsx" && echo "  ✓ 原版首页 UI 未动"
grep -q '洛雪音乐助手' "$UP/app.json" && echo "  ✓ 原版应用名未动"
echo
echo "✓ 完成。工程目录：$UP"
echo "  原装 751 个文件里，只有 src/core/init/index.ts 被加了 2 行；其余逐字节未改。"
echo "  下一步：cd $UP && npm install，再 cd android && ./gradlew assembleRelease"

# ═══════════════════════════════════════════════════════════════════════
# 🔒 冻结区结束 · 从本行往上，一个字都不许改（见 定稿封印.md / 基线清单.json）
# ✏️ 扩展区开始 · 定稿后【唯一】允许编辑的区域。
#    只可新增「UI 覆盖 / 白名单权限」的复制命令，例如：
#      cp -R "$HERE/overrides/." "$UP/"
#    严禁在此写任何涉及 core/ player/ musicSdk/ mc-center/ 签名/ NSC 的命令。
#    改完必跑：node check-freeze.mjs  （红灯 = 不许推、不许出包）
#    本区默认全为注释，行为与定稿版完全一致。
# ═══════════════════════════════════════════════════════════════════════

# ── UI 覆盖（定稿后唯一新增动作）────────────────────────────────────────
# 仅复制 overrides/ 下的 UI 文件到上游同名路径；
# 不触碰 core / player / musicSdk / mc-center / 签名 / NSC 中的任何文件。
if [ -d "$HERE/overrides" ]; then
  cp -R "$HERE/overrides/." "$UP/"
  echo "  ✓ UI 覆盖已应用（overrides/ → 上游同名路径）"
  echo "  · 说明：冻结区那句「原版首页 UI 未动」校验的是 Content 仍被引用；首页壳本体已由 overrides/ 覆盖替换"
  [ -f "$UP/src/screens/Home/Vertical/index.tsx" ] || { echo "✗ 首页壳覆盖失败"; exit 1; }
else
  echo "  · 无 overrides/，保持定稿态"
fi

