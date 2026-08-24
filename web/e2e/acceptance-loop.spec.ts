import { createServer, type Server } from "node:http";
import { readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";

const E2E_WORKSPACE = "/tmp/myagent-gui-test-workspace";
const MARKER = `${E2E_WORKSPACE}/acceptance-e2e-marker.txt`;
const E2E_CONFIG = "/tmp/myagent-gui-test-home/.myagent/config.jsonc";

let fakeModel: Server;
let fakeBaseUrl = "";
let originalConfigText: string | undefined;

function writeSse(
  response: import("node:http").ServerResponse,
  delta: Record<string, unknown>,
  finishReason: string,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-acceptance-e2e",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function configureFakeModel(request: APIRequestContext): Promise<void> {
  const currentResponse = await request.get("/api/config?scope=global");
  expect(currentResponse.ok()).toBeTruthy();
  const current = await currentResponse.json() as {
    config: Record<string, unknown> & {
      behavior: Record<string, unknown>;
    };
  };
  const configured = structuredClone(current.config) as Record<string, unknown> & {
    behavior: Record<string, unknown>;
  };
  configured.providers = [{
    id: "acceptance-e2e",
    name: "Acceptance E2E",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: fakeBaseUrl,
    apiKey: "provider-free-test-key",
    models: ["scripted"],
    thinking: false,
  }];
  configured.models = {
    main: { providerId: "acceptance-e2e", model: "scripted" },
    cheap: { providerId: "acceptance-e2e", model: "scripted" },
    explore: { providerId: "acceptance-e2e", model: "scripted" },
  };
  configured.behavior = {
    ...configured.behavior,
    completionReview: false,
  };
  const saved = await request.put("/api/config?scope=global", {
    data: configured,
  });
  expect(saved.ok()).toBeTruthy();
}

test.describe.serial("provider-free 可信完成闭环", () => {
  test.beforeAll(async ({ request }) => {
    originalConfigText = await readFile(E2E_CONFIG, "utf8").catch(() => undefined);
    await rm(MARKER, { force: true });
    fakeModel = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const messages = body.messages ?? [];
        const conversation = messages.map((message) => message.content ?? "").join("\n");
        if (conversation.includes("[完成审查]")) {
          writeSse(response, {
            content: "Verdict: PASS\nIssues:（无）\nUnconfirmed: 无",
          }, "stop");
          return;
        }
        if (messages.some((message) => message.role === "tool")) {
          writeSse(response, { content: "修复完成。" }, "stop");
          return;
        }
        if (conversation.includes("机器验收未通过")) {
          writeSse(response, {
            tool_calls: [{
              index: 0,
              id: "acceptance-e2e-write",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({
                  file_path: MARKER,
                  content: "verified\n",
                }),
              },
            }],
          }, "tool_calls");
          return;
        }
        writeSse(response, { content: "任务已经完成。" }, "stop");
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel.once("error", reject);
      fakeModel.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fakeModel.address();
    if (!address || typeof address === "string") {
      throw new Error("无法获取 fake model 端口");
    }
    fakeBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    await configureFakeModel(request);
  });

  test.afterAll(async () => {
    if (originalConfigText !== undefined) {
      await writeFile(E2E_CONFIG, originalConfigText, "utf8");
    }
    await rm(MARKER, { force: true });
    await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
  });

  test("UI 驱动失败、修复、复验、Review 与证据交付", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("main")
      .getByRole("button", { name: "＋ 新会话" })
      .click();
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill(
      `/run 创建验收标记 --check "test -f ${MARKER}" --check-timeout 10 --permission trust`,
    );
    await page.getByRole("button", { name: "启动任务" }).click();

    const confirmation = page.getByRole("region", { name: "确认任务边界" });
    await expect(confirmation.getByText(`check · test -f ${MARKER}`)).toBeVisible();
    await expect(confirmation.getByText("单项超时：10 秒")).toBeVisible();
    await confirmation.getByRole("button", { name: "确认并启动" }).click();

    await expect(page.getByText(/机器验收 failed/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/机器验收第 2 轮已开始/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/机器验收 passed/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("[完成审查] 创建验收标记")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/无人值守任务已完成|无人值守任务 已完成/)).toBeVisible({ timeout: 30_000 });
  });
});
