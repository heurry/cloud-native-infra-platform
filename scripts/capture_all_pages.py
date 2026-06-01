#!/usr/bin/env python3
"""截取所有前端页面的屏幕截图"""
import time
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

BASE_URL = "http://localhost:5173"
SCREENSHOT_DIR = Path(__file__).parent.parent / "screenshots"
SCREENSHOT_DIR.mkdir(exist_ok=True)

PAGES = [
    ("01_platform_overview", "平台总览"),
    ("01_services", "模型服务"),
    ("01_observability", "可观测性"),
    ("02_models", "模型管理"),
    ("03_config_center", "配置中心"),
    ("03_knowledge", "知识库"),
    ("04_kubernetes", "Kubernetes"),
    ("04_aiops", "AI Ops"),
    ("05_pipelines", "发布流水线"),
    ("06_benchmarks", "压测验证"),
    ("demo_apps", "Demo应用"),
    ("settings", "设置")
]

def setup_driver():
    """配置无头浏览器"""
    options = Options()
    options.add_argument("--headless")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--window-size=1920,1200")
    options.add_argument("--disable-gpu")
    return webdriver.Chrome(options=options)

def capture_page(driver, page_id: str, page_name: str):
    """截取单个页面"""
    try:
        print(f"📸 正在截取: {page_name} ({page_id})")

        # 点击导航项
        nav_item = WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, f'[data-nav-id="{page_id}"]'))
        )
        nav_item.click()

        # 等待页面加载
        time.sleep(2)

        # 滚动到顶部
        driver.execute_script("window.scrollTo(0, 0);")
        time.sleep(0.5)

        # 保存截图
        screenshot_path = SCREENSHOT_DIR / f"{page_id}.png"
        driver.save_screenshot(str(screenshot_path))
        print(f"  ✅ 已保存: {screenshot_path}")

    except Exception as e:
        print(f"  ❌ 失败: {e}")

def main():
    """主函数"""
    print(f"🚀 开始截图，保存到: {SCREENSHOT_DIR}")
    print(f"📍 目标地址: {BASE_URL}\n")

    driver = setup_driver()

    try:
        # 打开首页
        driver.get(BASE_URL)
        time.sleep(3)

        # 截取所有页面
        for page_id, page_name in PAGES:
            capture_page(driver, page_id, page_name)

        print(f"\n✅ 完成！共截取 {len(PAGES)} 个页面")
        print(f"📁 截图目录: {SCREENSHOT_DIR}")

    finally:
        driver.quit()

if __name__ == "__main__":
    main()
