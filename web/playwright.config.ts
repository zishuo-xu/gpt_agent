import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  // 测试自管理服务器生命周期（globalSetup 在 worker 中启动）
  webServer: {
    command:
      "HOME=/tmp/myagent-gui-test-home tsx /Users/xuzishuo/Documents/gpt_agent/src/cli.ts --web --port 3100",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    cwd: "/tmp/myagent-gui-test-workspace",
  },
});
