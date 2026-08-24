import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// 仓库根目录动态解析：主目录与 worktree 均可运行本配置
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const browserChannel = process.env.MYAGENT_E2E_CHANNEL === "chrome"
  ? "chrome" as const
  : undefined;

export default defineConfig({
  testDir: "./e2e",
  testIgnore: /prod-scenarios\.spec\.ts/,
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {}),
  },
  projects: [
    {
      name: "desktop",
      testMatch: /e2e\/(?!mobile\.).*\.spec\.ts/,
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      testMatch: /e2e\/mobile\.spec\.ts/,
      use: { viewport: { width: 375, height: 812 } },
    },
  ],
  // 测试自管理服务器生命周期（globalSetup 在 worker 中启动）
  webServer: {
    command: `HOME=/tmp/myagent-gui-test-home ${repoRoot}node_modules/.bin/tsx ${repoRoot}src/cli.ts --web --port 3100`,
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    cwd: "/tmp/myagent-gui-test-workspace",
    // SIGTERM 走优雅关闭（flush + 释放单实例写锁），避免 kill 残留锁文件
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
