import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RecordedEvent } from "../core/types.js";
import { ConfigService } from "../config/service.js";
import { ProjectRegistry } from "./project-registry.js";
import { WebSessionManager } from "./sessions.js";
import { createApiV1, mapV1Events } from "./api-v1.js";

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
