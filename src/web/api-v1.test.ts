import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigService } from "../config/service.js";
import { ProjectRegistry } from "./project-registry.js";
import { WebSessionManager } from "./sessions.js";
import { createApiV1 } from "./api-v1.js";

async function fixture(token: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-v1-"));
  const configService = new ConfigService({
    cwd: path.join(root, "project"),
    homeDir: path.join(root, "home"),
  });
  const registry = new ProjectRegistry({
    defaultCwd: path.join(root, "project"),
    homeDir: path.join(root, "home"),
  });
  const sessionManager = new WebSessionManager(
    path.join(root, "project"),
    configService,
  );
  await sessionManager.restore();
  registry.seed(path.join(root, "project"), configService, sessionManager);
  return createApiV1({
    apiToken: token,
    registry,
    configService,
    sessionManager,
  });
}

test("v1 认证：apiToken 未配置返回 404 not_enabled", async () => {
  const app = await fixture("");
  const response = await app.request("/api/v1/sessions");
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "not_enabled");
});

test("v1 认证：无/错 token 返回 401 unauthorized", async () => {
  const app = await fixture("secret-token");
  const noAuth = await app.request("/api/v1/sessions");
  assert.equal(noAuth.status, 401);
  const wrong = await app.request("/api/v1/sessions", {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(wrong.status, 401);
  const body = await wrong.json();
  assert.equal(body.code, "unauthorized");
});

test("v1 认证：正确 token 不返回 401（完整 200 断言在只读端点任务补全）", async () => {
  const app = await fixture("secret-token");
  const response = await app.request("/api/v1/sessions", {
    headers: { authorization: "Bearer secret-token" },
  });
  // 路由尚未实现（只读端点任务补全），此时认证放行的标志是 404 而非 401
  assert.notEqual(response.status, 401);
});
