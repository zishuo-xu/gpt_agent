import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";

const E2E_WORKSPACE = "/tmp/myagent-gui-test-workspace";
const E2E_CONFIG = "/tmp/myagent-gui-test-home/.myagent/config.jsonc";
const SOURCE_MARKER = `${E2E_WORKSPACE}/isolated-e2e-marker.txt`;

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
    id: "chatcmpl-isolated-e2e",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
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
    id: "isolated-e2e",
    name: "Isolated E2E",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: fakeBaseUrl,
    apiKey: "provider-free-isolated-key",
    models: ["scripted"],
    thinking: false,
  }];
  configured.models = {
    main: { providerId: "isolated-e2e", model: "scripted" },
    cheap: { providerId: "isolated-e2e", model: "scripted" },
    explore: { providerId: "isolated-e2e", model: "scripted" },
  };
  configured.behavior = { ...configured.behavior, completionReview: false };
  expect((await request.put("/api/config?scope=global", { data: configured })).ok()).toBeTruthy();
}

test.describe.serial("隔离执行真实用户入口", () => {
  test.beforeAll(async ({ request }) => {
    originalConfigText = await readFile(E2E_CONFIG, "utf8").catch(() => undefined);
    await rm(SOURCE_MARKER, { force: true });
    // The shared Playwright cwd may be fresh on a new checkout; make the fixture
    // a real repository so the isolation entry has the same precondition as users.
    try {
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: E2E_WORKSPACE, stdio: "ignore" });
    } catch {
      await writeFile(`${E2E_WORKSPACE}/isolated-e2e-fixture.txt`, "fixture\n", "utf8");
      execFileSync("git", ["init", "-q"], { cwd: E2E_WORKSPACE });
      execFileSync("git", ["add", "."], { cwd: E2E_WORKSPACE });
      execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", "commit", "-qm", "fixture"], { cwd: E2E_WORKSPACE });
    }
    fakeModel = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const messages = body.messages ?? [];
        if (messages.some((message) => message.role === "tool")) {
          writeSse(response, { content: "隔离工作区写入完成。" });
          return;
        }
        writeSse(response, {
          tool_calls: [{
            index: 0,
            id: "isolated-e2e-write",
            type: "function",
            function: {
              name: "Write",
              arguments: JSON.stringify({
                file_path: "isolated-e2e-marker.txt",
                content: "written-in-worktree\n",
              }),
            },
          }],
        }, "tool_calls");
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
    if (originalConfigText !== undefined) await writeFile(E2E_CONFIG, originalConfigText, "utf8");
    await rm(SOURCE_MARKER, { force: true });
    await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
  });

  test("新建隔离任务写入 worktree 且原项目不变", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("main").getByRole("button", { name: "＋ 新会话" }).click();
    await page.getByRole("checkbox", { name: "隔离执行" }).check();
    await expect(page.getByText(/Agent 只修改独立 Git worktree/)).toBeVisible();
    await page.getByRole("combobox", { name: "权限档" }).selectOption("trust");
    await page.getByPlaceholder("例如：检查这个项目，修复当前失败的测试").fill("写入隔离标记文件");
    await page.getByRole("button", { name: "启动任务" }).click();

    const banner = page.getByRole("region", { name: "隔离工作区" });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("原项目未自动修改");
    await expect(banner).toContainText("不会自动合并、commit 或 push");
    const workspacePath = await banner.locator("code").first().textContent();
    expect(workspacePath).toBeTruthy();
    await expect(page.getByText("隔离工作区写入完成。")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => readFile(`${workspacePath}/isolated-e2e-marker.txt`, "utf8")).toBe("written-in-worktree\n");
    await expect.poll(async () => access(SOURCE_MARKER).then(() => true).catch(() => false)).toBe(false);

    const delivery = page.getByRole("region", { name: "交付验收" });
    await expect(delivery).toBeVisible({ timeout: 30_000 });
    await expect(delivery).toContainText("已完成但未机器验收");
    await expect(delivery).toContainText("isolated-e2e-marker.txt");
    await expect(delivery).toContainText("工作区自创建后已发生变化");
    await expect(delivery).toContainText("改动尚未自动合并");
  });
});
