import type { ToolExecutionResult } from "../core/types.js";

/**
 * 浏览器页面检查（BrowserCheck）：打开 URL，收集页面状态与渲染后信息。
 * 纯文本输出（标题 / HTTP 状态 / console 错误 / body 文本片段）——
 * 当前模型无视觉输入，截图对模型不可读；文本检查覆盖"页面是否真的渲染成功"。
 * 失败（含浏览器二进制未安装）返回 isError 并附安装指引。
 */
export async function runBrowserCheck(
  url: string,
  timeoutMs = 15_000,
): Promise<ToolExecutionResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message: { type(): string; text(): string }) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text().slice(0, 200));
      }
    });
    page.on("pageerror", (error: Error) => {
      consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`);
    });
    const response = await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: "domcontentloaded",
    });
    // 等前端 JS 渲染（SPA 首屏）
    await page.waitForTimeout(800);
    const title = await page.title();
    const bodyText = (
      (await page.evaluate(() => document.body?.innerText ?? "")) ?? ""
    ).slice(0, 2000);
    const status = response?.status() ?? 0;
    const output = JSON.stringify(
      {
        status,
        title,
        consoleErrors: consoleErrors.slice(0, 5),
        bodyText: bodyText.slice(0, 1500),
      },
      null,
      2,
    );
    return {
      summary: `页面检查完成：HTTP ${status} · ${title || "（无标题）"}`,
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isMissingBrowser = /Executable doesn't exist|browserType\.launch/i.test(
      message,
    );
    const guidance = isMissingBrowser
      ? "\n浏览器二进制未安装：请运行 `npx playwright install chromium` 后重试。"
      : "";
    return {
      summary: `页面检查失败：${message.slice(0, 120)}${guidance}`,
      output: message,
      isError: true,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
