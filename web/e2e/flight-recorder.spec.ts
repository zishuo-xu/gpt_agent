import { execFile as execFileCallback } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext } from "@playwright/test";

const execFile = promisify(execFileCallback);
const E2E_WORKSPACE = "/tmp/myagent-gui-test-workspace";
const FIXTURE = path.join(E2E_WORKSPACE, "flight-parent.txt");
const PARENT_MARKER = path.join(E2E_WORKSPACE, "child-marker.txt");
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
    id: "chatcmpl-flight-e2e",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 80, completion_tokens: 10 },
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
    id: "flight-e2e",
    name: "Flight E2E",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: fakeBaseUrl,
    apiKey: "provider-free-flight-key",
    models: ["scripted"],
    thinking: false,
  }];
  configured.models = {
    main: { providerId: "flight-e2e", model: "scripted" },
    cheap: { providerId: "flight-e2e", model: "scripted" },
    explore: { providerId: "flight-e2e", model: "scripted" },
  };
  configured.behavior = { ...configured.behavior, completionReview: false };
  expect((await request.put("/api/config?scope=global", { data: configured })).ok()).toBeTruthy();
}

async function ensureGitWorkspace(): Promise<void> {
  await writeFile(FIXTURE, "parent remains unchanged\n");
  await access(path.join(E2E_WORKSPACE, ".git")).catch(async () => {
    await execFile("git", ["init", "-q"], { cwd: E2E_WORKSPACE });
  });
  await execFile("git", ["config", "user.email", "flight@example.com"], { cwd: E2E_WORKSPACE });
  await execFile("git", ["config", "user.name", "Flight E2E"], { cwd: E2E_WORKSPACE });
  await execFile("git", ["add", "flight-parent.txt"], { cwd: E2E_WORKSPACE });
  await execFile("git", ["commit", "-qm", "flight fixture"], { cwd: E2E_WORKSPACE })
    .catch(async () => {
      await execFile("git", ["rev-parse", "--verify", "HEAD"], { cwd: E2E_WORKSPACE });
    });
}

async function waitFor(
  request: APIRequestContext,
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待 Flight Recorder E2E 状态超时");
}

test.describe.serial("provider-free Flight Recorder", () => {
  test.beforeAll(async ({ request }) => {
    originalConfigText = await readFile(E2E_CONFIG, "utf8").catch(() => undefined);
    await ensureGitWorkspace();
    await access(PARENT_MARKER).then(
      async () => { throw new Error("父工作区存在上次遗留 child-marker.txt"); },
      () => undefined,
    );
    fakeModel = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const messages = body.messages ?? [];
        const system = messages.find((message) => message.role === "system")?.content ?? "";
        const lastUser = messages.findLastIndex((message) => message.role === "user");
        const hasToolAfterUser = messages.slice(lastUser + 1).some((message) => message.role === "tool");
        if (hasToolAfterUser) {
          writeSse(response, { content: "done" }, "stop");
          return;
        }
        const experiment = system.includes("FLIGHT_E2E_OVERLAY");
        const tool = experiment ? "Write" : "Read";
        const args = experiment
          ? { file_path: "child-marker.txt", content: "isolated\n" }
          : { file_path: "flight-parent.txt" };
        writeSse(response, {
          tool_calls: [{
            index: 0,
            id: experiment ? "flight-child-write" : "flight-parent-read",
            type: "function",
            function: { name: tool, arguments: JSON.stringify(args) },
          }],
        }, "tool_calls");
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeModel.once("error", reject);
      fakeModel.listen(0, "127.0.0.1", resolve);
    });
    const address = fakeModel.address();
    if (!address || typeof address === "string") throw new Error("fake model 未监听");
    fakeBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    await configureFakeModel(request);
  });

  test.afterAll(async () => {
    if (originalConfigText !== undefined) {
      await writeFile(E2E_CONFIG, originalConfigText, "utf8");
    }
    await new Promise<void>((resolve) => fakeModel.close(() => resolve()));
  });

  test("从 Turn Fork 隔离实验并定位首个工具分歧", async ({ page, request }) => {
    const created = await request.post("/api/sessions", { data: { task: "flight parent" } });
    expect(created.ok()).toBeTruthy();
    const parentId = (await created.json()).session.id as string;
    await waitFor(request, async () => {
      const response = await request.get(`/api/sessions/${parentId}/traces`);
      return response.ok() && ((await response.json()).traces?.length ?? 0) >= 2;
    });

    await page.goto(`/#sessions/${parentId}`);
    await page.getByRole("button", { name: "Trace" }).click();
    await expect(page.getByText("Turn 1", { exact: true })).toBeVisible();
    await page.locator(".trace-card").first().getByRole("button", { name: "从这里 Fork" }).click();
    const modal = page.getByRole("dialog", { name: "Fork 并运行实验" });
    await modal.getByLabel("System Prompt Overlay").fill("FLIGHT_E2E_OVERLAY");
    await modal.getByLabel("继续指令").fill("/run child experiment --permission trust");
    await modal.getByRole("button", { name: "Fork 并运行" }).click();
    await expect(modal.getByText("实验已启动")).toBeVisible({ timeout: 30_000 });

    const forks = await (await request.get(`/api/sessions/${parentId}/forks`)).json() as {
      forks: Array<{ id: string; workspacePath: string }>;
    };
    const child = forks.forks[0]!;
    await waitFor(request, async () => {
      const sessions = await (await request.get("/api/sessions")).json() as {
        sessions: Array<{ id: string; status: string }>;
      };
      return sessions.sessions.some((session) => session.id === child.id && session.status === "done");
    });
    expect(await readFile(path.join(child.workspacePath, "child-marker.txt"), "utf8")).toBe("isolated\n");
    await expect(access(PARENT_MARKER)).rejects.toThrow();
    expect(await readFile(FIXTURE, "utf8")).toBe("parent remains unchanged\n");
    const childEvents = await (await request.get(`/api/sessions/${child.id}/events`)).json() as {
      events: Array<{ event: { type: string } }>;
    };
    expect(childEvents.events.some((record) => record.event.type === "model_fallback")).toBeFalsy();

    await modal.getByRole("button", { name: "打开子会话" }).click();
    const compare = page.getByRole("button", { name: "对比" });
    await expect(compare).toBeEnabled();
    await compare.click();
    await expect(page.getByText("序列分叉：第 1 项")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("child-marker.txt", { exact: true })).toBeVisible();
  });
});
