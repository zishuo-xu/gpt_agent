import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hono } from "hono";
import type { RecordedEvent } from "../core/types.js";
import { ConfigService } from "../config/service.js";
import { ProjectRegistry } from "./project-registry.js";
import { WebSessionManager } from "./sessions.js";
import { createApiV1, mapV1Events } from "./api-v1.js";

/** 模拟生产挂载：app.route("/api/v1", v1App)——v1 内部路由不带前缀 */
function mounted(app: Hono): Hono {
  const server = new Hono();
  server.route("/api/v1", app);
  return server;
}

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
  return mounted(
    createApiV1({
      apiToken: token,
      registry,
      configService,
      sessionManager,
    }),
  );
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

test("v1 认证：正确 token 通过（sessions 空列表）", async () => {
  const app = await fixture("secret-token");
  const response = await app.request("/api/v1/sessions", {
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, []);
});

function record(seq: number, event: RecordedEvent["event"]): RecordedEvent {
  return { seq, ts: "2026-08-09T10:00:00.000Z", branchId: "main", event };
}

test("v1 事件映射：白名单类型多对一折叠", () => {
  const events = mapV1Events([
    record(1, { type: "user", text: "你好" }),
    record(2, { type: "text_delta", text: "完成" }),
    record(3, { type: "thinking_delta", text: "思考中" }),
    record(4, {
      type: "tool_call",
      call: { id: "c1", tool: "Read", target: "src/a.ts", args: { file_path: "src/a.ts" } },
    }),
    record(5, { type: "tool_result", callId: "c1", summary: "读取成功" }),
    record(6, {
      type: "ask_permission",
      call: { id: "c2", tool: "Write", target: "b.ts", args: {} },
      risk: "写文件",
    }),
    record(7, {
      type: "run_started",
      taskId: "t1",
      description: "修复测试",
      permissionMode: "normal",
      hardRules: [],
    }),
    record(8, { type: "run_finished", taskId: "t1", status: "completed", reason: "done" }),
    record(9, { type: "error", message: "模型超时" }),
    record(10, { type: "done" }),
  ]);
  assert.deepEqual(events, [
    { seq: 1, ts: "2026-08-09T10:00:00.000Z", type: "user.text", text: "你好" },
    { seq: 2, ts: "2026-08-09T10:00:00.000Z", type: "assistant.text", text: "完成" },
    { seq: 3, ts: "2026-08-09T10:00:00.000Z", type: "assistant.thinking", text: "思考中" },
    { seq: 4, ts: "2026-08-09T10:00:00.000Z", type: "tool.call", tool: "Read", target: "src/a.ts", args: { file_path: "src/a.ts" } },
    { seq: 5, ts: "2026-08-09T10:00:00.000Z", type: "tool.result", tool: "Read", summary: "读取成功", isError: false },
    { seq: 6, ts: "2026-08-09T10:00:00.000Z", type: "approval.request", callId: "c2", tool: "Write", risk: "写文件" },
    { seq: 7, ts: "2026-08-09T10:00:00.000Z", type: "run.started", description: "修复测试" },
    { seq: 8, ts: "2026-08-09T10:00:00.000Z", type: "run.finished", status: "completed", reason: "done" },
    { seq: 9, ts: "2026-08-09T10:00:00.000Z", type: "system.error", message: "模型超时" },
    { seq: 10, ts: "2026-08-09T10:00:00.000Z", type: "system.info", message: "任务完成" },
  ]);
});

test("v1 事件映射：tool_result 跨事件补 tool 名；未知类型折叠 system.info", () => {
  const events = mapV1Events([
    record(1, {
      type: "tool_call",
      call: { id: "x", tool: "Bash", target: "pnpm test", args: {} },
    }),
    record(2, { type: "tool_result", callId: "x", summary: "失败", isError: true }),
    record(3, {
      type: "context_compacted",
      summary: "压缩",
      ratio: 0.5,
      keepFromSeq: 1,
    }),
  ]);
  assert.equal(events[1]!.type === "tool.result" ? events[1].tool : "", "Bash");
  assert.equal(events[1]!.type === "tool.result" ? events[1].isError : false, true);
  assert.equal(events[2]!.type, "system.info");
  assert.match((events[2] as { message: string }).message, /压缩/);
});

function bearer(token = "secret-token") {
  return { headers: { authorization: `Bearer ${token}` } };
}

test("v1 只读：创建会话后列表/详情/事件增量/导出", async () => {
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
  const app = mounted(
    createApiV1({
      apiToken: "secret-token",
      registry,
      configService,
      sessionManager,
    }),
  );

  const session = await sessionManager.create("你好", "normal");
  const summary = session.summary();

  const listResponse = await app.request("/api/v1/sessions", bearer());
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()).data as Array<{ id: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, session.id);

  const detailResponse = await app.request(
    `/api/v1/sessions/${session.id}`,
    bearer(),
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()).data as { title: string };
  assert.equal(detail.title, summary.title);

  const eventsResponse = await app.request(
    `/api/v1/sessions/${session.id}/events`,
    bearer(),
  );
  assert.equal(eventsResponse.status, 200);
  const eventsBody = await eventsResponse.json();
  assert.equal(eventsBody.data.events.length, 1);
  assert.equal(eventsBody.data.events[0].type, "user.text");
  assert.equal(eventsBody.data.latestSeq, 1);

  // 增量：after=1 不再返回旧事件
  const deltaResponse = await app.request(
    `/api/v1/sessions/${session.id}/events?after=1`,
    bearer(),
  );
  const deltaBody = await deltaResponse.json();
  assert.deepEqual(deltaBody.data.events, []);
  assert.equal(deltaBody.data.latestSeq, 1);

  const exportResponse = await app.request(
    `/api/v1/sessions/${session.id}/export`,
    bearer(),
  );
  assert.equal(exportResponse.status, 200);
  assert.match(await exportResponse.text(), /<!DOCTYPE html>/);
});

test("v1 只读：会话不存在返回 404 not_found", async () => {
  const app = await fixture("secret-token");
  const response = await app.request("/api/v1/sessions/nope", bearer());
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "not_found");
});

async function v1Fixture() {
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
  const app = mounted(
    createApiV1({
      apiToken: "secret-token",
      registry,
      configService,
      sessionManager,
    }),
  );
  return { app, sessionManager };
}

const jsonHeaders = {
  authorization: "Bearer secret-token",
  "content-type": "application/json",
};

test("v1 写：runs 发起任务（无边界直发；有边界需确认）", async () => {
  const { app, sessionManager } = await v1Fixture();

  // 无边界：直接创建
  const okResponse = await app.request("/api/v1/runs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ command: "/run 修复测试" }),
  });
  assert.equal(okResponse.status, 200);
  const okBody = await okResponse.json();
  assert.ok(typeof okBody.data.sessionId === "string");
  assert.equal(sessionManager.list().length, 1);

  // 有边界（路径规则 → hardRules）：未确认 → 409 conflict + 边界清单
  const needConfirm = await app.request("/api/v1/runs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ command: '/run 修复测试 --bounds "不改 src/**"' }),
  });
  assert.equal(needConfirm.status, 409);
  const confirmBody = await needConfirm.json();
  assert.equal(confirmBody.code, "conflict");
  assert.ok(Array.isArray(confirmBody.data.hardRules));
  assert.equal(confirmBody.data.hardRules.length, 3);
  assert.equal(sessionManager.list().length, 1, "未确认不创建会话");

  // 自然语言边界（无路径规则 → 仅 semanticBounds）不要求确认
  const softBounds = await app.request("/api/v1/runs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ command: "/run 修复测试 --bounds 禁止删除 src" }),
  });
  assert.equal(softBounds.status, 200);
  assert.equal(sessionManager.list().length, 2);

  // 确认后创建成功
  const confirmed = await app.request("/api/v1/runs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      command: '/run 修复测试 --bounds "不改 src/**"',
      confirmBounds: true,
    }),
  });
  assert.equal(confirmed.status, 200);
  assert.equal(sessionManager.list().length, 3);

  // 非 /run 命令 → 400 invalid
  const invalid = await app.request("/api/v1/runs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ command: "随便说说" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid");
});

test("v1 写：messages 发送/排队语义 + /run 拒绝", async () => {
  const { app, sessionManager } = await v1Fixture();
  const session = await sessionManager.create("你好", "normal");

  const sent = await app.request(`/api/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ message: "继续" }),
  });
  assert.equal(sent.status, 200);
  const sentBody = await sent.json();
  assert.equal(sentBody.data.accepted, true);
  // 会话创建后立即进入处理，排队与否由核心状态决定（测试环境恒为处理中）
  assert.equal(typeof sentBody.data.queued, "boolean");

  const runRejected = await app.request(
    `/api/v1/sessions/${session.id}/messages`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ message: "/run 新任务" }),
    },
  );
  assert.equal(runRejected.status, 400);

  const empty = await app.request(`/api/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(empty.status, 400);
});

test("v1 写：approvals 审批 + interrupt 中断", async () => {
  const { app, sessionManager } = await v1Fixture();
  const session = await sessionManager.create("你好", "normal");

  // granted 非布尔 → 400
  const bad = await app.request(
    `/api/v1/sessions/${session.id}/approvals/c1`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ granted: "yes" }),
    },
  );
  assert.equal(bad.status, 400);

  // 不存在的审批 callId → 409（resolvePermission 对未知 id 返回 false）
  const missing = await app.request(
    `/api/v1/sessions/${session.id}/approvals/c1`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ granted: true }),
    },
  );
  assert.equal(missing.status, 409);

  // 运行中会话 interrupt → 200 interrupted:true（测试环境会话创建即处理）
  const interrupt = await app.request(
    `/api/v1/sessions/${session.id}/interrupt`,
    { method: "POST", headers: jsonHeaders },
  );
  assert.equal(interrupt.status, 200);
  const interruptBody = await interrupt.json();
  assert.equal(interruptBody.data.interrupted, true);
});
