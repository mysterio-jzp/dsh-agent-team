#!/usr/bin/env bash
# 生成界面正稿的交付截图：每份原型 × 明暗两态 × 桌面/移动两宽度。
# 截图按仓内规范落各工作项目录的 materials/（值得重读的素材）。
# 用法：bash .scratch/active/proto-kit/shoot.sh
set -euo pipefail

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "找不到 Chrome：$CHROME" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"

# 移动档用临时副本注入（查询串在 headless 截图时序里不稳定，实测会被丢掉）：
# 把每个帧改成移动设备、收起控制条，再截图。
shoot() { # <html 绝对或相对路径> <输出图片相对路径> <宽> <高> [查询串]
  local html="$1" out="$2" w="$3" h="$4" query="${5:-}"
  mkdir -p "$(dirname "$out")"
  local target
  if [[ "$html" = /* ]]; then target="file://$html"; else target="file://$REPO/$html"; fi
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars --disable-cache \
    --virtual-time-budget=4000 \
    --force-device-scale-factor=2 \
    --window-size="${w},${h}" \
    --screenshot="$REPO/$out" \
    "${target}${query}" >/dev/null 2>&1
  echo "  $out"
}

emit() { # <工作项目录> <html 名> <图片前缀>
  local dir=".scratch/active/$1" name="$2" prefix="$3"
  echo "$1"
  # ⚠ 两态都要显式钉住主题：不传 theme 时页面跟随系统，headless 里系统可能就是深色
  # ⇒ 不钉会把"浅色"那张也拍成深色（2026-10-14 实际发生过一次）。
  shoot "$dir/prototype/$name" "$dir/materials/$prefix.desktop.light.png" 1440 2100 "?theme=light"
  shoot "$dir/prototype/$name" "$dir/materials/$prefix.desktop.dark.png" 1440 2100 "?theme=dark"
  local mobile="${name%.html}.mobile.html"
  shoot "$dir/prototype/$mobile" "$dir/materials/$prefix.mobile.light.png" 430 1400 "?theme=light"
  shoot "$dir/prototype/$mobile" "$dir/materials/$prefix.mobile.dark.png" 430 1400 "?theme=dark"
}

emit proto-c-artifact-jump artifact-jump.html artifact-jump

emit proto-d-member-boundary member-boundary.html member-boundary
emit proto-e-human-todos human-todos.html human-todos
shoot .scratch/active/proto-e-human-todos/prototype/human-todos.html \
  .scratch/active/proto-e-human-todos/materials/human-todos.claimed.desktop.light.png 1440 2100 "?demo=claimed&theme=light"
emit proto-b-workspace-roots workspace-roots.html workspace-roots

echo "done."
