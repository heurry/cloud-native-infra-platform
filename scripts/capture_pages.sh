#!/bin/bash
# 使用 Chromium 截取所有页面

SCREENSHOT_DIR="/home/xdu/LLM/llm_train_platform_miniv2/screenshots"
mkdir -p "$SCREENSHOT_DIR"

echo "🚀 开始截图，保存到: $SCREENSHOT_DIR"
echo ""

# 检查是否安装了截图工具
if ! command -v chromium &> /dev/null && ! command -v google-chrome &> /dev/null; then
    echo "❌ 未找到 Chromium 或 Chrome，尝试使用 Firefox..."

    if command -v firefox &> /dev/null; then
        echo "使用 Firefox 截图..."

        pages=(
            "dashboard:01_platform_overview"
            "services:01_services"
            "observability:01_observability"
            "models:02_models"
            "config-center:03_config_center"
            "knowledge:03_knowledge"
            "kubernetes:04_kubernetes"
            "ai-ops:04_aiops"
            "pipelines:05_pipelines"
            "benchmarks:06_benchmarks"
            "demo-apps:demo_apps"
            "settings:settings"
        )

        for page in "${pages[@]}"; do
            IFS=':' read -r route filename <<< "$page"
            echo "📸 正在截取: $route -> $filename.png"
            firefox --headless --screenshot="$SCREENSHOT_DIR/$filename.png" "http://localhost:5173/#/$route" 2>/dev/null &
            FIREFOX_PID=$!
            sleep 5
            kill $FIREFOX_PID 2>/dev/null || true
        done
    else
        echo "❌ 未找到可用的浏览器，请手动截图"
        exit 1
    fi
else
    echo "❌ 未找到自动化工具，请安装 playwright 或手动截图"
    echo "手动截图步骤："
    echo "1. 打开浏览器访问 http://localhost:5173"
    echo "2. 依次访问以下页面并截图保存到 $SCREENSHOT_DIR"
    echo ""
    echo "页面列表："
    echo "  - 平台总览 -> 01_platform_overview.png"
    echo "  - 模型服务 -> 01_services.png"
    echo "  - 可观测性 -> 01_observability.png"
    echo "  - 模型管理 -> 02_models.png"
    echo "  - 配置中心 -> 03_config_center.png"
    echo "  - 知识库 -> 03_knowledge.png"
    echo "  - Kubernetes -> 04_kubernetes.png"
    echo "  - AI Ops -> 04_aiops.png"
    echo "  - 发布流水线 -> 05_pipelines.png"
    echo "  - 压测验证 -> 06_benchmarks.png"
    echo "  - Demo应用 -> demo_apps.png"
    echo "  - 设置 -> settings.png"
fi

echo ""
echo "✅ 完成！"
echo "📁 截图目录: $SCREENSHOT_DIR"
