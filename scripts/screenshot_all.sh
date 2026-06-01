#!/bin/bash
# 使用 Chrome headless 截取所有页面

SCREENSHOT_DIR="/home/xdu/LLM/llm_train_platform_miniv2/screenshots"
mkdir -p "$SCREENSHOT_DIR"

BASE_URL="http://localhost:5173"
CHROME="/usr/bin/google-chrome"

echo "🚀 开始截图，保存到: $SCREENSHOT_DIR"
echo ""

declare -A pages=(
    ["01_platform_overview"]="/"
    ["01_services"]="/services"
    ["01_observability"]="/observability"
    ["02_models"]="/models"
    ["03_config_center"]="/config-center"
    ["03_knowledge"]="/knowledge"
    ["04_kubernetes"]="/kubernetes"
    ["04_aiops"]="/ai-ops"
    ["05_pipelines"]="/pipelines"
    ["06_benchmarks"]="/benchmarks"
    ["demo_apps"]="/demo-apps"
    ["settings"]="/settings"
)

for filename in "${!pages[@]}"; do
    route="${pages[$filename]}"
    url="${BASE_URL}${route}"
    output="${SCREENSHOT_DIR}/${filename}.png"

    echo "📸 正在截取: $filename ($route)"

    $CHROME \
        --headless \
        --disable-gpu \
        --no-sandbox \
        --window-size=1920,1200 \
        --screenshot="$output" \
        "$url" \
        2>/dev/null

    if [ $? -eq 0 ]; then
        echo "  ✅ 已保存: $output"
    else
        echo "  ❌ 失败"
    fi

    sleep 2
done

echo ""
echo "✅ 完成！共截取 ${#pages[@]} 个页面"
echo "📁 截图目录: $SCREENSHOT_DIR"
ls -lh "$SCREENSHOT_DIR"/*.png 2>/dev/null | awk '{print "  - " $9 " (" $5 ")"}'
