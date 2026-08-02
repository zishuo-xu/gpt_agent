import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigService } from "../config/service.js";
import { createWebApp } from "./app.js";
import type { WebSessionManager } from "./sessions.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-api-"));
  const service = new ConfigService({
    cwd: path.join(root, "project"),
    homeDir: path.join(root, "home"),
  });
  return { app: createWebApp(service), service };
}

test("Web API 暴露 Schema 和脱敏配置", async () => {
  const { app } = await fixture();
  const schemaResponse = await app.request("/api/config/schema");
  assert.equal(schemaResponse.status, 200);
  const schema = await schemaResponse.json();
  assert.deepEqual(
    schema.fields.map((field: { key: string }) => field.key),
    [
      "providers",
      "models",
      "permissions",
      "context",
      "server.host",
      "server.password",
      "notify.webhook",
    ],
  );

  const configResponse = await app.request("/api/config?scope=global");
  assert.equal(configResponse.status, 200);
  const payload = await configResponse.json();
  assert.equal(payload.scope, "global");
  assert.equal(payload.config.providers[0].apiKey, "");
});

test("Web API 保存 OpenAI-compatible 第三方渠道", async () => {
  const { app, service } = await fixture();
  const config = await service.readPublic("global");
  config.providers.push({
    id: "moonshot",
    name: "Moonshot",
    enabled: true,
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: "moonshot-secret",
    hasApiKey: false,
    models: ["kimi-k2"],
  });
  config.models.explore = {
    providerId: "moonshot",
    model: "kimi-k2",
  };

  const response = await app.request("/api/config?scope=global", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.saved, true);
  assert.equal(payload.config.providers[1].hasApiKey, true);
  assert.equal(payload.config.providers[1].apiKey, "");
});

test("Web API 对无效配置返回可读问题列表", async () => {
  const { app, service } = await fixture();
  const config = await service.readPublic("global");
  config.providers[0]!.baseUrl = "bad-url";

  const response = await app.request("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.ok(payload.issues.some((issue: string) => issue.includes("Base URL")));
});

test("连接测试在缺少 API Key 时返回明确结果", async () => {
  const { app } = await fixture();
  const response = await app.request("/api/config/test?scope=global", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
    }),
  });
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.reachable, false);
  assert.match(payload.message, /API Key/);
});

test("记忆 API 列出四类文档并原子保存项目记忆", async () => {
  const { app, service } = await fixture();
  const listResponse = await app.request("/api/memory");
  assert.equal(listResponse.status, 200);
  const initial = await listResponse.json();
  assert.deepEqual(
    initial.documents.map(
      (document: { id: string }) => document.id,
    ),
    ["preferences", "conventions", "pitfalls", "decisions"],
  );

  const saveResponse = await app.request("/api/memory/pitfalls", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "- 测试必须串行运行\n",
    }),
  });
  assert.equal(saveResponse.status, 200);
  assert.equal(
    await readFile(
      path.join(
        service.cwd,
        ".myagent",
        "memory",
        "pitfalls.md",
      ),
      "utf8",
    ),
    "- 测试必须串行运行\n",
  );
});

test("Web /run 预览返回待确认的路径硬边界", async () => {
  const { app } = await fixture();
  const response = await app.request("/api/run/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command:
        '/run 提升覆盖率 --goal "npm test 全过" --bounds "不改 src/api/" --permission trust',
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.task.permission, "trust");
  assert.deepEqual(
    payload.task.hardRules.map(
      (rule: { pattern: string }) => rule.pattern,
    ),
    [
      "Edit(*src/api/*)",
      "MultiEdit(*src/api/*)",
      "Write(*src/api/*)",
    ],
  );
});

test("已有会话发消息兼容 message 字段（与 task 一致）", async () => {
  const { service } = await fixture();
  const fakeSession = {
    id: "sess-test",
    isProcessing: () => false,
    sendInput: async () => undefined,
    startRunTask: () => undefined,
  } as never;
  const fakeManager = {
    get: (id: string) => (id === "sess-test" ? fakeSession : undefined),
  } as unknown as WebSessionManager;
  const app = createWebApp(service, fakeManager);

  const response = await app.request("/api/sessions/sess-test/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "第二条消息" }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accepted, true);

  // 空消息仍被拒绝
  const empty = await app.request("/api/sessions/sess-test/input", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(empty.status, 400);
});

test("fs 浏览列出子目录且忽略隐藏项", async () => {
  const { app } = await fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-fs-"));
  const sub = path.join(root, "alpha");
  await mkdir(sub);
  await mkdir(path.join(root, ".hidden"));
  await writeFile(path.join(root, "file.txt"), "x");

  const response = await app.request(
  `/api/fs/list?path=${encodeURIComponent(root)}`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const names = payload.entries.map((entry: { name: string }) => entry.name);
  assert.deepEqual(names, ["alpha"]);
});

test("打开项目：有效目录成功并返回会话，文件与非目录失败", async () => {
  const { app } = await fixture();
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-open-"));
  const projectDir = path.join(root, "proj");
  await mkdir(projectDir);

  const ok = await app.request("/api/projects/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir }),
  });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.equal(payload.opened, true);
  assert.equal(payload.project.cwd, projectDir);
  assert.equal(payload.project.name, "proj");
  assert.ok(Array.isArray(payload.sessions));

  const notDir = await app.request("/api/projects/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.join(root, "nope") }),
  });
  assert.equal(notDir.status, 400);
});

test("项目列表包含大厅项", async () => {
  const { app } = await fixture();
  const projectsResponse = await app.request("/api/projects");
  const projectsPayload = await projectsResponse.json();
  const lobby = projectsPayload.projects.find(
    (project: { key: string }) => project.key === "lobby",
  );
  assert.ok(lobby, "项目列表应包含大厅项");
  assert.equal(lobby.name, "大厅（不操作文件）");
  assert.equal(lobby.lobby, true);
});
