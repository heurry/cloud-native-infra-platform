#!/usr/bin/env node
/**
 * 截取所有前端页面的屏幕截图
 * 需要安装: npm install -g puppeteer
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'screenshots');

const PAGES = [
  { route: '/', filename: '01_platform_overview', name: '平台总览' },
  { route: '/services', filename: '01_services', name: '模型服务' },
  { route: '/observability', filename: '01_observability', name: '可观测性' },
  { route: '/models', filename: '02_models', name: '模型管理' },
  { route: '/config-center', filename: '03_config_center', name: '配置中心' },
  { route: '/knowledge', filename: '03_knowledge', name: '知识库' },
  { route: '/kubernetes', filename: '04_kubernetes', name: 'Kubernetes' },
  { route: '/ai-ops', filename: '04_aiops', name: 'AI Ops' },
  { route: '/pipelines', filename: '05_pipelines', name: '发布流水线' },
  { route: '/benchmarks', filename: '06_benchmarks', name: '压测验证' },
  { route: '/demo-apps', filename: 'demo_apps', name: 'Demo应用' },
  { route: '/settings', filename: 'settings', name: '设置' }
];

async function captureScreenshots() {
  // 创建截图目录
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  console.log(`🚀 开始截图，保存到: ${SCREENSHOT_DIR}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });

  for (const { route, filename, name } of PAGES) {
    try {
      console.log(`📸 正在截取: ${name} (${route})`);

      await page.goto(`${BASE_URL}${route}`, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // 等待页面渲染
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 滚动到顶部
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(resolve => setTimeout(resolve, 500));

      // 保存截图
      const screenshotPath = path.join(SCREENSHOT_DIR, `${filename}.png`);
      await page.screenshot({
        path: screenshotPath,
        fullPage: false
      });

      console.log(`  ✅ 已保存: ${screenshotPath}`);

    } catch (error) {
      console.log(`  ❌ 失败: ${error.message}`);
    }
  }

  await browser.close();

  console.log(`\n✅ 完成！共截取 ${PAGES.length} 个页面`);
  console.log(`📁 截图目录: ${SCREENSHOT_DIR}`);
}

captureScreenshots().catch(console.error);
