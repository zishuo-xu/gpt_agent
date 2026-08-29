import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";

const E2E_CONFIG = "/tmp/myagent-gui-test-home/.myagent/config.jsonc";
let fakeModel: Server;
let fakeBaseUrl = "";
let originalConfigText: string | undefined;

function writeSse(
  response: import("node:http").ServerResponse,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" = "stop",
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-plan-e2e",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 80, completion_tokens: 20 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function configureFakeModel(request: APIRequestContext): Promise<void> {
  const current = await (await request.get("/api/config?scope=global")).json() as {
    config: Record<string, unknown> & { behavior: Record<string, unknown> };
  };
  const configured = structuredClone(current.config) as Record<string, unknown> & {
    behavior: Record<string, unknown>;
  };
  configured.providers = [{
    id: "plan-e2e",
    name: "Plan E2E",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: fakeBaseUrl,
    apiKey: "provider-free-plan-key",
    models: ["scripted"],
    thinking: false,
  }];
  configured.models = {
    main: { providerId: "plan-e2e", model: "scripted" },
    cheap: { providerId: "plan-e2e", model: "scripted" },
    explore: { providerId: "plan-e2e", model: "scripted" },
  };
  configured.behavior = { ...configured.behavior, completionReview: false };
  expect((await request.put("/api/config?scope=global", { data: configured })).ok()).toBeTruthy();
}

test.describe.serial("provider-free 计划批准门", () => {
  test.beforeAll(async ({ request }) => {
    originalConfigText = await readFile(E2E_CONFIG, "utf8").catch(() => undefined);
    fakeModel = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const messages = body.messages ?? [];
        const conversation = messages
          .map((message) => message.content ?? "")
          .join("\n");
        if (conversation.includes("只读规划阶段")) {
          const revised = conversation.includes("不要修改公开 API");
          writeSse(
            response,
            {
              content: `## 目标\n${revised ? "在不修改公开 API 的前提下完成" : "完成计划门演示"}\n## 执行步骤\n1. 检查现状\n2. 实施最小修改\n## 预计修改文件\n- 无（演示任务）\n## 验证方式\n- \`true\`\n## 风险与待确认\n- 无`,
            },
          );
          return;
        }
        if (messages.some((message) => message.role === "tool")) {
          writeSse(response, { content: "已按批准计划执行。" });
          return;
        }
        writeSse(
          response,
          {
            tool_calls: [{
              index: 0,
              id: "plan-e2e-todos",
              type: "function",
              function: {
                name: "TodoWrite",
                arguments: JSON.stringify({
                  todos: [
                    { id: "plan-step-1", content: "检查现状", status: "completed" },
                    { id: "plan-step-2", content: "实施最小修改", status: "completed" },
                  ],
                }),
              },
            }],
          },
          "tool_calls",
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel.once("error", reject);
      fakeModel.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fakeModel.address();
    if (!address || typeof address === "string") throw new Error("无法获取 fake model 端口");
    fakeBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    await configureFakeModel(request);
  });

  test.afterAll(async () => {
    if (originalConfigText !== undefined) {
      await writeFile(E2E_CONFIG, originalConfigText, "utf8");
    }
    await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
  });

  test("只读规划 → 反馈修订 → 弹窗批准 → 同会话执行", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("main").getByRole("button", { name: "＋ 新会话" }).click();
    await page.getByPlaceholder("例如：检查这个项目，修复当前失败的测试").fill("完成计划门演示");
    const smartStart = page.locator(".new-task-panel .plan-mode-toggle input");
    await expect(smartStart).not.toBeChecked();
    await smartStart.check();
    await page.locator(".new-task-panel button.save-button").click();

    let dialog = page.getByRole("dialog", { name: "任务契约已就绪，请选择下一步" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("完成计划门演示", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    const analysisBox = await dialog.getByRole("button", { name: "仅保留分析" }).boundingBox();
    const approveBox = await dialog.getByRole("button", { name: "批准并开始执行" }).boundingBox();
    expect(analysisBox?.width ?? 0).toBeGreaterThan(300);
    expect(Math.abs((analysisBox?.x ?? 0) - (approveBox?.x ?? 0))).toBeLessThan(2);
    await dialog.getByPlaceholder(/公开 API/).fill("不要修改公开 API");
    await dialog.getByRole("button", { name: "修改计划" }).click();

    dialog = page.getByRole("dialog", { name: "任务契约已就绪，请选择下一步" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(/在不修改公开 API 的前提下完成/)).toBeVisible();
    await dialog.getByRole("button", { name: "批准并开始执行" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText("计划已批准，开始执行")).toBeVisible({ timeout: 30_000 });
    const result = page.getByText("已按批准计划执行。");
    await expect(result).toBeAttached({ timeout: 30_000 });
    await expect(page.getByText(/验收通过/).first()).toBeAttached({ timeout: 30_000 });
    await result.scrollIntoViewIfNeeded();
    await expect(result).toBeVisible();
    const ledger = page.locator(".ledger-card");
    await expect(ledger).toContainText("检查现状");
    await expect(ledger).toContainText("实施最小修改");
    await expect(ledger.getByText("已完成", { exact: true })).toHaveCount(2);
    const done = page.getByText("✓ 本轮任务已完成");
    await done.scrollIntoViewIfNeeded();
    await expect(done).toBeVisible();
  });
});
