import { defineConfig } from "@playwright/test";

/**
 * 生产级长任务场景配置：独立服务器实例（3300）+ 生产测试工作区
 * （gpt_agent 源码副本 /tmp/prod-test-workspace + 隔离 HOME）。
 * 与常规 E2E（3100 + gui-test-workspace）互不干扰。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /prod-scenarios\.spec\.ts/,
  timeout: 30 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3300",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command:
      "HOME=/tmp/prod-test-home tsx /Users/xuzishuo/Documents/gpt_agent/src/cli.ts --web --port 3300",
    url: "http://127.0.0.1:3300/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    cwd: "/tmp/prod-test-workspace",
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
