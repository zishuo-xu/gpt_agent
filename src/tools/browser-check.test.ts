import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { chromium } from "playwright";
import { runBrowserCheck } from "./browser-check.js";

// chromium 可用性检测：CI 未安装浏览器时跳过真实页面用例，
// 仅跑"缺失引导"用例（两个环境互斥互补，各自全绿）。
let browserAvailable = false;
try {
  browserAvailable = existsSync(chromium.executablePath());
} catch {
  browserAvailable = false;
}

const skipNoBrowser = { skip: !browserAvailable } as const;

function startPageServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/boom") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><meta charset=\"utf-8\"><title>错误页</title><script>console.error('boom');</script><body>错误页面</body>",
      );
      return;
    }
    if (url.pathname !== "/ok") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><meta charset=\"utf-8\"><title>检查测试页</title><body><h1>Hello BrowserCheck</h1><p>渲染文本</p></body>",
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test(
  "正常页面：HTTP 200 + 标题 + 渲染后文本 + 无 console 错误",
  skipNoBrowser,
  async () => {
    const page = await startPageServer();
    try {
      const result = await runBrowserCheck(
        `http://127.0.0.1:${page.port}/ok`,
        10_000,
      );
      assert.equal(result.isError, undefined);
      assert.match(result.summary, /HTTP 200/);
      const parsed = JSON.parse(String(result.output ?? "")) as {
        status: number;
        title: string;
        consoleErrors: string[];
        bodyText: string;
      };
      assert.equal(parsed.status, 200);
      assert.equal(parsed.title, "检查测试页");
      assert.match(parsed.bodyText, /Hello BrowserCheck/);
      assert.match(parsed.bodyText, /渲染文本/);
      assert.deepEqual(parsed.consoleErrors, []);
    } finally {
      await page.close();
    }
  },
);

test("页面 console.error 被捕获并回传", skipNoBrowser, async () => {
  const page = await startPageServer();
  try {
    const result = await runBrowserCheck(
      `http://127.0.0.1:${page.port}/boom`,
      10_000,
    );
    const parsed = JSON.parse(String(result.output ?? "")) as {
      consoleErrors: string[];
    };
    assert.ok(
      parsed.consoleErrors.some((item) => item.includes("boom")),
      `consoleErrors 应包含 boom，实际：${parsed.consoleErrors.join(" | ")}`,
    );
  } finally {
    await page.close();
  }
});

test("HTTP 404 页面返回真实状态码", skipNoBrowser, async () => {
  const page = await startPageServer();
  try {
    const result = await runBrowserCheck(
      `http://127.0.0.1:${page.port}/missing`,
      10_000,
    );
    const parsed = JSON.parse(String(result.output ?? "")) as { status: number };
    assert.equal(parsed.status, 404);
    assert.match(result.summary, /HTTP 404/);
  } finally {
    await page.close();
  }
});

test("不可达地址返回 isError 失败结果", skipNoBrowser, async () => {
  // 端口停用后立即连接拒绝（浏览器导航失败路径，无需等待 15s 默认超时）
  const result = await runBrowserCheck("http://127.0.0.1:1/", 2_000);
  assert.equal(result.isError, true);
  assert.match(result.summary, /页面检查失败/);
});

test(
  "浏览器二进制缺失时返回安装指引",
  { skip: browserAvailable },
  async () => {
    // 构造不可达地址触发 launch 后的导航失败不适用——缺失场景需真实缺失；
    // 本用例仅在无 chromium 环境运行，直接断言失败结果带安装指引（任意失败路径）。
    const result = await runBrowserCheck("http://127.0.0.1:1/", 2_000);
    assert.equal(result.isError, true);
    assert.match(String(result.output ?? ""), /playwright install chromium/);
  },
);
