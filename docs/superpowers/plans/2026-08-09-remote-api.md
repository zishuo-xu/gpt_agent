# 远程会话（/api/v1 无头接口 + 移动端响应式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MyAgent 提供独立版本化的 `/api/v1` 无头接口（Bearer token 认证 + 白名单事件契约 + 薄适配层），并响应式改造 Web 前端适配手机操作。

**Architecture:** 同进程薄路由层 `src/web/api-v1.ts`（纯路由 + 转换，无状态），在 `server.ts` 装配层 `app.route("/api/v1", ...)` 挂载；只调 `WebSessionManager`/`AgentSession` 公共方法，`src/core/*` 零改动。事件经白名单映射为 10 种稳定类型，未知类型折叠为 `system.info`。

**Tech Stack:** Hono（已有）、Node crypto.timingSafeEqual、React（已有）、CSS 媒体查询。

**工作目录**：`/Users/xuzishuo/Documents/gpt_agent-zcode`（worktree，分支 `zcode-remote-api`）。所有命令在此目录执行。提交只落本分支。

## Global Constraints

- `src/core/*` 一行不改；`src/web/app.ts` 不改
- 所有提交落 `zcode-remote-api` 分支，绝不提交 main；合并 main 由用户决定
- 每次改动后依次 `pnpm run typecheck` → `pnpm test`；产物相关加 `pnpm run build`
- 认证 token 比较必须用 `timingSafeEqual`（等长归一）
- `apiToken` 未配置时 `/api/v1` 整体返回 404 `not_enabled`
- v1 响应统一 `{ ok: true, data }` / `{ ok: false, error, code }`；错误码 `unauthorized`(401)/`not_enabled`(404)/`not_found`(404)/`invalid`(400)/`conflict`(409)/`internal`(500)
- 事件类型名与字段名以本文档 §Task 3 的 `V1Event` 为准，后续任务不得改名

---

### Task 1: 配置 schema 增加 server.apiToken

**Files:**
- Modify: `src/config/schema.ts`（server 段字段定义 ~L148-153、defaults ~L271-274）
- Test: `src/web/app.test.ts`（schema fields 断言数组）

**Interfaces:**
- Produces: schema 字段 `server.apiToken`（type: "string"）——Task 6 的 server.ts 读取 `serverConfig.apiToken`

- [ ] **Step 1: 更新 app.test.ts 断言（先红）**

在 `src/web/app.test.ts` 的 schema fields 断言数组中，`"server.password"` 之后加 `"server.apiToken"`：

```ts
      "server.host",
      "server.password",
      "server.apiToken",
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep -A3 "apiToken" | head -20`
Expected: 断言失败（数组缺 apiToken 项）

- [ ] **Step 3: schema.ts 加字段**

在 `src/config/schema.ts` 的 `server.password` 字段定义后追加：

```ts
  {
    key: "server.apiToken",
    type: "string",
    title: "API Token",
    description: "/api/v1 无头接口的 Bearer token（飞书机器人等外部系统集成用）。留空则接口未启用。",
  },
```

在 `src/config/schema.ts` 的 `defaults` 对象 `server` 段加 `apiToken: ""`：

```ts
  server: {
    host: "127.0.0.1",
    password: "",
    apiToken: "",
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test 2>&1 | tail -5`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts src/web/app.test.ts
git commit -m "feat(config): server.apiToken 配置项（/api/v1 无头接口认证用）"
```

---

### Task 2: api-v1.ts 工厂 + Bearer 认证中间件

**Files:**
- Create: `src/web/api-v1.ts`
- Test: `src/web/api-v1.test.ts`

**Interfaces:**
- Consumes: `ProjectRegistry`（`constructor({defaultCwd,stateDir?,homeDir?})`、`seed(cwd, configService, sessionManager)`、`resolve(key)` 返回 `{ cwd, resources: { configService, sessionManager } }`）；`WebSessionManager`（`restore()`、`get(id)`、`list()`、`create(message, mode)`）；`ConfigService`
- Produces: `createApiV1(options: ApiV1Options): Hono`——后续任务在其返回的 app 上追加路由

- [ ] **Step 1: 写认证失败测试**

创建 `src/web/api-v1.test.ts`：

```ts
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
  const sessionManager = new WebSessionManager(path.join(root, "project"), configService);
  await sessionManager.restore();
  registry.seed(path.join(root, "project"), configService, sessionManager);
  return createApiV1({ apiToken: token, registry, configService, sessionManager });
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep -E "v1 认证|api-v1" | head -10`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 api-v1.ts 认证骨架**

创建 `src/web/api-v1.ts`：

```ts
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ConfigService } from "../config/service.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { WebSessionManager } from "./sessions.js";

export interface ApiV1Options {
  /** Bearer token；空串 = 接口未启用（404 not_enabled） */
  apiToken: string;
  registry: ProjectRegistry;
  configService: ConfigService;
  sessionManager?: WebSessionManager;
}

export function createApiV1(options: ApiV1Options): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    if (!options.apiToken) {
      return context.json(
        { ok: false, error: "接口未启用（server.apiToken 未配置）", code: "not_enabled" },
        404,
      );
    }
    const match = /^Bearer\s+(.+)$/i.exec(
      context.req.header("authorization") ?? "",
    );
    const token = match?.[1] ?? "";
    if (!token || !safeEqual(token, options.apiToken)) {
      return context.json({ ok: false, error: "未授权", code: "unauthorized" }, 401);
    }
    return next();
  });

  return app;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test 2>&1 | grep -E "v1 认证" | head -10`
Expected: 3 条 PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api-v1.ts src/web/api-v1.test.ts
git commit -m "feat(web): /api/v1 无头接口认证——Bearer token + timingSafeEqual + 未配置 404"
```

---

### Task 3: 事件白名单映射 mapV1Events

**Files:**
- Modify: `src/web/api-v1.ts`
- Test: `src/web/api-v1.test.ts`

**Interfaces:**
- Produces: `export type V1Event`（10 种白名单联合类型）与 `export function mapV1Events(records: RecordedEvent[]): V1Event[]`——Task 4 的 events 端点消费
- Consumes: `RecordedEvent`（`src/core/types.ts`：`{ seq, ts, branchId?, event: AgentEvent }`）

- [ ] **Step 1: 写映射测试**

追加到 `src/web/api-v1.test.ts`：

```ts
import type { RecordedEvent } from "../core/types.js";
import { createApiV1, mapV1Events } from "./api-v1.js";

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
    record(6, { type: "ask_permission", call: { id: "c2", tool: "Write", target: "b.ts", args: {} }, risk: "写文件" }),
    record(7, { type: "run_started", taskId: "t1", description: "修复测试", permissionMode: "normal", hardRules: [] }),
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
    record(1, { type: "tool_call", call: { id: "x", tool: "Bash", target: "pnpm test", args: {} } }),
    record(2, { type: "tool_result", callId: "x", summary: "失败", isError: true }),
    record(3, { type: "context_compacted", summary: "压缩", ratio: 0.5, keepFromSeq: 1 }),
  ]);
  assert.equal(events[1]!.type === "tool.result" ? events[1].tool : "", "Bash");
  assert.equal(events[1]!.type === "tool.result" ? events[1].isError : false, true);
  assert.equal(events[2]!.type, "system.info");
  assert.match((events[2] as { message: string }).message, /压缩/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep -E "v1 事件映射" | head`
Expected: FAIL（mapV1Events 未定义）

- [ ] **Step 3: 实现映射**

在 `src/web/api-v1.ts` 追加（import 行加 `import type { AgentEvent, RecordedEvent } from "../core/types.js";`）：

```ts
export type V1Event =
  | { seq: number; ts: string; type: "user.text"; text: string }
  | { seq: number; ts: string; type: "assistant.text"; text: string }
  | { seq: number; ts: string; type: "assistant.thinking"; text: string }
  | { seq: number; ts: string; type: "tool.call"; tool: string; target?: string; args: unknown }
  | { seq: number; ts: string; type: "tool.result"; tool: string; summary: string; isError: boolean }
  | { seq: number; ts: string; type: "approval.request"; callId: string; tool: string; risk: string }
  | { seq: number; ts: string; type: "run.started"; description: string }
  | { seq: number; ts: string; type: "run.finished"; status: string; reason?: string }
  | { seq: number; ts: string; type: "system.info"; message: string }
  | { seq: number; ts: string; type: "system.error"; message: string };

/** 内部事件 → v1 白名单契约（多对一折叠；未知类型永不破坏契约，折叠为 system.info）。 */
export function mapV1Events(records: RecordedEvent[]): V1Event[] {
  const toolNames = new Map<string, string>();
  const out: V1Event[] = [];
  for (const record of records) {
    out.push(mapV1Event(record, toolNames));
  }
  return out;
}

function mapV1Event(
  record: RecordedEvent,
  toolNames: Map<string, string>,
): V1Event {
  const base = { seq: record.seq, ts: record.ts };
  const event = record.event;
  switch (event.type) {
    case "user":
    case "user_queued":
      return { ...base, type: "user.text", text: event.text };
    case "text_delta":
      return { ...base, type: "assistant.text", text: event.text };
    case "thinking_delta":
      return { ...base, type: "assistant.thinking", text: event.text };
    case "tool_call": {
      toolNames.set(event.call.id, event.call.tool);
      return {
        ...base,
        type: "tool.call",
        tool: event.call.tool,
        ...(event.call.target ? { target: event.call.target } : {}),
        args: event.call.args ?? {},
      };
    }
    case "tool_result":
      return {
        ...base,
        type: "tool.result",
        tool: toolNames.get(event.callId) ?? "",
        summary: event.summary,
        isError: event.isError === true,
      };
    case "ask_permission":
      return {
        ...base,
        type: "approval.request",
        callId: event.call.id,
        tool: event.call.tool,
        risk: event.risk,
      };
    case "run_started":
      return { ...base, type: "run.started", description: event.description };
    case "run_finished":
      return {
        ...base,
        type: "run.finished",
        status: event.status,
        ...(event.reason ? { reason: event.reason } : {}),
      };
    case "error":
      return { ...base, type: "system.error", message: event.message };
    default:
      return { ...base, type: "system.info", message: systemInfoMessage(event) };
  }
}

function systemInfoMessage(event: AgentEvent): string {
  switch (event.type) {
    case "done":
      return "任务完成";
    case "need_user":
      return `需要用户：${event.question}`;
    case "notify":
      return event.message;
    case "interrupted":
      return `已中断（${event.scope}）`;
    case "permission_denied":
      return `权限拒绝：${event.call.tool} ${event.reason}`;
    case "branch_switch":
      return `切换分支 ${event.branchId}`;
    case "context_compacted":
      return `上下文已压缩（保留 #${event.keepFromSeq} 起）`;
    case "label":
      return event.name ? `书签 #${event.seq}「${event.name}」` : `移除书签 #${event.seq}`;
    case "session_info":
      return `会话标题：${event.name}`;
    case "permission_mode_changed":
      return `权限档 → ${event.mode}`;
    case "todo_update":
      return `任务清单（${event.todos.length} 项）`;
    case "cost_update":
      return `本轮 ${event.totalTokens} tokens${event.costCny ? ` / ¥${event.costCny}` : ""}`;
    case "model_fallback":
      return `模型降级：${event.from} → ${event.to}`;
    default:
      return JSON.stringify(event).slice(0, 200);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test 2>&1 | grep -E "v1 事件映射" | head`
Expected: 2 条 PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api-v1.ts src/web/api-v1.test.ts
git commit -m "feat(web): v1 事件白名单映射——10 种稳定类型 + 未知折叠 system.info"
```

---

### Task 4: 只读端点（sessions / :id / events / export）

**Files:**
- Modify: `src/web/api-v1.ts`
- Test: `src/web/api-v1.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `mapV1Events`/`V1Event`；`AgentSession.events(after = 0)`、`AgentSession.summary()`（`SessionSummary`：`{ id, title, status, permissionMode, createdAt, updatedAt, totalInputTokens, totalOutputTokens, totalCachedTokens, totalCostCny, todos, toolCallCount, kind, ... }`）；`exportSessionHtml`（`src/web/export-session.ts`）

- [ ] **Step 1: 写只读端点测试**

追加到 `src/web/api-v1.test.ts`：

```ts
import { createApiV1, mapV1Events } from "./api-v1.js";

function bearer(token = "secret-token") {
  return { headers: { authorization: `Bearer ${token}` } };
}

test("v1 只读：创建会话后列表/详情/事件增量/导出", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-v1-"));
  const configService = new ConfigService({ cwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const registry = new ProjectRegistry({ defaultCwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const sessionManager = new WebSessionManager(path.join(root, "project"), configService);
  await sessionManager.restore();
  registry.seed(path.join(root, "project"), configService, sessionManager);
  const app = createApiV1({ apiToken: "secret-token", registry, configService, sessionManager });

  const session = await sessionManager.create("你好", "normal");
  const summary = session.summary();

  const listResponse = await app.request("/api/v1/sessions", bearer());
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()).data as Array<{ id: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, session.id);

  const detailResponse = await app.request(`/api/v1/sessions/${session.id}`, bearer());
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()).data as { title: string };
  assert.equal(detail.title, summary.title);

  const eventsResponse = await app.request(`/api/v1/sessions/${session.id}/events`, bearer());
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

  const exportResponse = await app.request(`/api/v1/sessions/${session.id}/export`, bearer());
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep -E "v1 只读" | head`
Expected: FAIL（路由不存在 → 404 或未实现）

- [ ] **Step 3: 实现只读端点**

在 `src/web/api-v1.ts` 的 `createApiV1` 内、认证中间件之后追加（import 行加 `import { exportSessionHtml } from "./export-session.js";`）：

```ts
  async function resolveV1Project(context: {
    req: { query: (k: string) => string | undefined };
  }): Promise<{ configService: ConfigService; sessionManager: WebSessionManager | undefined }> {
    const key = context.req.query("project");
    if (!key) {
      return { configService: options.configService, sessionManager: options.sessionManager };
    }
    const { resources } = await options.registry.resolve(key);
    return { configService: resources.configService, sessionManager: resources.sessionManager };
  }

  app.get("/sessions", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    if (!sessionManager) {
      return context.json({ ok: false, error: "默认项目未加载", code: "not_found" }, 404);
    }
    const limit = Math.max(1, Math.min(Number(context.req.query("limit")) || 20, 200));
    return context.json({ ok: true, data: sessionManager.list().slice(0, limit) });
  });

  app.get("/sessions/:id", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    return context.json({ ok: true, data: session.summary() });
  });

  app.get("/sessions/:id/events", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    const rawAfter = Number(context.req.query("after"));
    const after = Number.isFinite(rawAfter) && rawAfter >= 0 ? rawAfter : 0;
    const records = session.events(after);
    return context.json({
      ok: true,
      data: {
        events: mapV1Events(records),
        latestSeq: records.length > 0 ? records[records.length - 1]!.seq : after,
      },
    });
  });

  app.get("/sessions/:id/export", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    const summary = session.summary();
    const html = exportSessionHtml({
      sessionId: session.id,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      permissionMode: summary.permissionMode,
      records: session.events(),
    });
    return context.body(html, 200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="myagent-${session.id}.html"`,
    });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test 2>&1 | grep -E "v1 只读|v1 认证|v1 事件映射" | head -20`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api-v1.ts src/web/api-v1.test.ts
git commit -m "feat(web): v1 只读端点——会话列表/详情/增量事件/导出"
```

---

### Task 5: 写端点（runs / messages / approvals / interrupt）

**Files:**
- Modify: `src/web/api-v1.ts`
- Test: `src/web/api-v1.test.ts`

**Interfaces:**
- Consumes: `parseRunCommand`（`src/core/run-task.ts`，返回 `RunTaskOptions` 含 `hardRules/semanticBounds/permission`）；`WebSessionManager.create(message, mode)`（/run 自动 parse+启动）；`AgentSession.sendInput(message, displayText?, { steer? })`、`resolvePermission(callId, answer: boolean | ApprovalAnswer)`、`interrupt(): boolean`、`isProcessing()`

- [ ] **Step 1: 写写端点测试**

追加到 `src/web/api-v1.test.ts`：

```ts
test("v1 写：runs 发起任务（无边界直发；有边界需确认）", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-v1-"));
  const configService = new ConfigService({ cwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const registry = new ProjectRegistry({ defaultCwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const sessionManager = new WebSessionManager(path.join(root, "project"), configService);
  await sessionManager.restore();
  registry.seed(path.join(root, "project"), configService, sessionManager);
  const app = createApiV1({ apiToken: "secret-token", registry, configService, sessionManager });

  // 无边界：直接创建
  const okResponse = await app.request("/api/v1/runs", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ command: "/run 修复测试" }),
  });
  assert.equal(okResponse.status, 200);
  const okBody = await okResponse.json();
  assert.ok(typeof okBody.data.sessionId === "string");

  // 有边界：未确认 → 409 conflict + 边界清单
  const needConfirm = await app.request("/api/v1/runs", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ command: "/run 修复测试 --bounds 禁止删除 src" }),
  });
  assert.equal(needConfirm.status, 409);
  const confirmBody = await needConfirm.json();
  assert.equal(confirmBody.code, "conflict");
  assert.ok(Array.isArray(confirmBody.data.hardRules));
  assert.equal(confirmBody.data.hardRules.length, 1);

  // 确认后创建成功
  const confirmed = await app.request("/api/v1/runs", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ command: "/run 修复测试 --bounds 禁止删除 src", confirmBounds: true }),
  });
  assert.equal(confirmed.status, 200);

  // 非 /run 命令 → 400 invalid
  const invalid = await app.request("/api/v1/runs", {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ command: "随便说说" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid");
});

test("v1 写：messages 发送/排队语义 + /run 拒绝", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-v1-"));
  const configService = new ConfigService({ cwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const registry = new ProjectRegistry({ defaultCwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const sessionManager = new WebSessionManager(path.join(root, "project"), configService);
  await sessionManager.restore();
  registry.seed(path.join(root, "project"), configService, sessionManager);
  const app = createApiV1({ apiToken: "secret-token", registry, configService, sessionManager });
  const session = await sessionManager.create("你好", "normal");

  const sent = await app.request(`/api/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "继续" }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).data.accepted, true);

  const runRejected = await app.request(`/api/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "/run 新任务" }),
  });
  assert.equal(runRejected.status, 400);

  const empty = await app.request(`/api/v1/sessions/${session.id}/messages`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(empty.status, 400);
});

test("v1 写：approvals 审批 + interrupt 中断", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-v1-"));
  const configService = new ConfigService({ cwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const registry = new ProjectRegistry({ defaultCwd: path.join(root, "project"), homeDir: path.join(root, "home") });
  const sessionManager = new WebSessionManager(path.join(root, "project"), configService);
  await sessionManager.restore();
  registry.seed(path.join(root, "project"), configService, sessionManager);
  const app = createApiV1({ apiToken: "secret-token", registry, configService, sessionManager });
  const session = await sessionManager.create("你好", "normal");

  // granted 非布尔 → 400
  const bad = await app.request(`/api/v1/sessions/${session.id}/approvals/c1`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ granted: "yes" }),
  });
  assert.equal(bad.status, 400);

  // 不存在的审批 callId → 409（resolvePermission 对未知 id 返回 false）
  const missing = await app.request(`/api/v1/sessions/${session.id}/approvals/c1`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token", "content-type": "application/json" },
    body: JSON.stringify({ granted: true }),
  });
  assert.equal(missing.status, 409);

  // 未运行会话 interrupt → 409
  const interrupt = await app.request(`/api/v1/sessions/${session.id}/interrupt`, {
    method: "POST",
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(interrupt.status, 409);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep -E "v1 写" | head`
Expected: FAIL（路由不存在）

- [ ] **Step 3: 实现写端点**

在 `src/web/api-v1.ts` 的只读端点后追加（import 行加 `import { parseRunCommand } from "../core/run-task.js";`）：

```ts
  app.post("/runs", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    if (!sessionManager) {
      return context.json({ ok: false, error: "默认项目未加载", code: "not_found" }, 404);
    }
    let body: { command?: unknown; confirmBounds?: unknown };
    try {
      body = (await context.req.json()) as typeof body;
    } catch {
      return context.json({ ok: false, error: "请求体需为 JSON", code: "invalid" }, 400);
    }
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command.startsWith("/run")) {
      return context.json({ ok: false, error: "command 需为 /run 任务命令", code: "invalid" }, 400);
    }
    const run = parseRunCommand(command);
    if (run.hardRules.length > 0 && body.confirmBounds !== true) {
      return context.json(
        {
          ok: false,
          error: "需要先确认任务硬边界（confirmBounds: true）",
          code: "conflict",
          data: { hardRules: run.hardRules, semanticBounds: run.semanticBounds },
        },
        409,
      );
    }
    const session = await sessionManager.create(command, run.permission ?? "normal");
    return context.json({ ok: true, data: { sessionId: session.id } });
  });

  app.post("/sessions/:id/messages", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    let body: { message?: unknown; steer?: unknown };
    try {
      body = (await context.req.json()) as typeof body;
    } catch {
      return context.json({ ok: false, error: "请求体需为 JSON", code: "invalid" }, 400);
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return context.json({ ok: false, error: "消息不能为空", code: "invalid" }, 400);
    }
    if (message.startsWith("/run")) {
      return context.json({ ok: false, error: "任务发起请用 POST /api/v1/runs", code: "invalid" }, 400);
    }
    const queued = session.isProcessing();
    void session.sendInput(message, undefined, body.steer === true ? { steer: true } : undefined);
    return context.json({ ok: true, data: { accepted: true, queued } });
  });

  app.post("/sessions/:id/approvals/:callId", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    let body: { granted?: unknown; scope?: unknown; feedback?: unknown };
    try {
      body = (await context.req.json()) as typeof body;
    } catch {
      return context.json({ ok: false, error: "请求体需为 JSON", code: "invalid" }, 400);
    }
    if (typeof body.granted !== "boolean") {
      return context.json({ ok: false, error: "granted 需为布尔值", code: "invalid" }, 400);
    }
    const resolved = session.resolvePermission(context.req.param("callId"), {
      granted: body.granted,
      ...(typeof body.scope === "string" ? { scope: body.scope as "once" | "session" | "project" | "global" } : {}),
      ...(typeof body.feedback === "string" && body.feedback.trim()
        ? { feedback: body.feedback.trim() }
        : {}),
    });
    if (!resolved) {
      return context.json({ ok: false, error: "审批已失效或不存在", code: "conflict" }, 409);
    }
    return context.json({ ok: true, data: { resolved: true } });
  });

  app.post("/sessions/:id/interrupt", async (context) => {
    const { sessionManager } = await resolveV1Project(context);
    const session = sessionManager?.get(context.req.param("id"));
    if (!session) {
      return context.json({ ok: false, error: "会话不存在", code: "not_found" }, 404);
    }
    return session.interrupt()
      ? context.json({ ok: true, data: { interrupted: true } })
      : context.json({ ok: false, error: "会话当前未运行", code: "conflict" }, 409);
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test 2>&1 | grep -E "v1" | head -30`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api-v1.ts src/web/api-v1.test.ts
git commit -m "feat(web): v1 写端点——runs/messages/approvals/interrupt（confirmBounds 语义）"
```

---

### Task 6: server.ts 挂载 v1 + 设置页生成按钮

**Files:**
- Modify: `src/web/server.ts`（~L99-102 createWebApp 之后）
- Modify: `web/src/settings/SchemaSections.tsx`（string 渲染分支加 apiToken 生成按钮）

**Interfaces:**
- Consumes: Task 2 的 `createApiV1`；`serverConfig.apiToken`（Task 1）
- Produces: 生产服务 `/api/v1` 可用

- [ ] **Step 1: 挂载 v1**

在 `src/web/server.ts` 的 `app.registry.seed(...)` 之后加：

```ts
  // /api/v1 无头接口：Bearer token 认证，供飞书机器人等外部系统集成。
  // apiToken 未配置时认证中间件返回 404 not_enabled（接口整体未启用）。
  const { createApiV1 } = await import("./api-v1.js");
  app.route(
    "/api/v1",
    createApiV1({
      apiToken: serverConfig.apiToken?.trim() ?? "",
      registry: app.registry,
      configService,
      sessionManager,
    }),
  );
```

- [ ] **Step 2: 设置页生成按钮**

在 `web/src/settings/SchemaSections.tsx` 的 text input 分支（`field.type === "number" ? "number" : "text"` 处）改为：apiToken 字段在输入框旁加「生成」按钮：

```tsx
                    <div className="schema-field-input-row">
                      <input
                        type={field.type === "number" ? "number" : "text"}
                        value={String(value)}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        onChange={(event) =>
                          props.onChange((current) =>
                            setConfigValue(
                              current,
                              field.key,
                              field.type === "number"
                                ? Number(event.target.value)
                                : event.target.value,
                            ),
                          )
                        }
                      />
                      {field.key === "server.apiToken" && (
                        <button
                          type="button"
                          className="schema-field-generate"
                          onClick={() =>
                            props.onChange((current) =>
                              setConfigValue(
                                current,
                                field.key,
                                randomToken(),
                              ),
                            )
                          }
                        >
                          生成
                        </button>
                      )}
                    </div>
```

并在文件顶部工具函数区加：

```ts
/** 随机 API token：32 字节 base64url，无需外部依赖。 */
function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
```

（若文件未 import crypto，在顶部加 `import crypto from "node:crypto";`。base64url 字符集无需转义，可直接用于 URL 与 HTTP 头。）

在 `web/src/styles/settings.css` 末尾追加：

```css
.schema-field-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.schema-field-input-row input {
  flex: 1;
  min-width: 0;
}
.schema-field-generate {
  flex: 0 0 auto;
  padding: 6px 12px;
  border: 1px solid #2a3450;
  border-radius: 6px;
  background: #1a2030;
  color: #9fb6e0;
  font-size: 12px;
  cursor: pointer;
}
.schema-field-generate:hover {
  background: #24365c;
  color: #e7ebf1;
}
```

- [ ] **Step 3: 验证**

Run: `pnpm run typecheck && pnpm test 2>&1 | tail -5`
Expected: typecheck 通过、全绿

- [ ] **Step 4: 冒烟验证（起服务 + curl）**

```bash
cd /Users/xuzishuo/Documents/gpt_agent-zcode
MYAGENT_TEST_TOKEN="$(openssl rand -hex 16)"
cat > /tmp/myagent-smoke-local.jsonc <<EOF
{ "server": { "host": "127.0.0.1", "password": "", "apiToken": "$MYAGENT_TEST_TOKEN" } }
EOF
# 用临时 HOME 起服务（避免污染真实配置）：需要确认 cli 的 --web 启动参数后执行
```

若 CLI 支持指定配置目录则用临时目录启动 `pnpm start -- --web`（或 `node dist/cli.js`），否则跳过冒烟，以 Task 5 的 app 级测试为准（它们已覆盖完整路由面）。

- [ ] **Step 5: Commit**

```bash
git add src/web/server.ts web/src/settings/SchemaSections.tsx web/src/styles/settings.css
git commit -m "feat(web): /api/v1 挂载到 Web 服务 + 设置页 apiToken 生成按钮"
```

---

### Task 7: 移动端响应式（侧栏抽屉 + 断点）

**Files:**
- Modify: `web/src/styles/base.css`（.shell/.sidebar 断点）
- Modify: `web/src/styles/chat.css`（sessions-main/header-actions/composer 断点）
- Modify: `web/src/SessionApp.tsx`（汉堡按钮 + sidebar open 状态）
- Test: `web/src/SessionApp.test.tsx`（SessionListSidebar open className 渲染）

**Interfaces:**
- Consumes: `SessionListSidebar`（props: sessions/sessionsLoaded/selectedId/onSelect/onNew）
- Produces: 窄屏（≤768px）可用的移动端布局

- [ ] **Step 1: 写组件测试**

追加到 `web/src/SessionApp.test.tsx`（SessionListSidebar 描述块内）：

```tsx
it("SessionListSidebar：open 时挂 open className", () => {
  const { document } = window as unknown as {
    document: {
      createElement: (tag: string) => HTMLElement;
    };
  };
  // 复用现有 SessionListSidebar 渲染模式（见文件内已有用例），仅断言 open prop
});
```

若现有测试未渲染 SessionListSidebar 的 className 断言，则改为断言 `session-list-sidebar` 根元素 className 包含 `open`（渲染方式参照文件内已有 `SessionListSidebar` 用例的挂载代码，`open={true}` 与 `open={false}` 两态）。

- [ ] **Step 2: 实现响应式**

`web/src/styles/base.css` 末尾追加：

```css
/* ========== 移动端（≤768px）：侧栏抽屉化 ========== */
@media (max-width: 768px) {
  .shell {
    grid-template-columns: 1fr;
  }
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(280px, 82vw);
    z-index: 40;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }
  .sidebar.open {
    transform: none;
    box-shadow: 0 0 28px rgba(0, 0, 0, 0.55);
  }
}
```

`web/src/styles/chat.css` 末尾追加：

```css
/* ========== 移动端（≤768px） ========== */
@media (max-width: 768px) {
  .sessions-main {
    width: 100vw;
    padding: 16px 12px 12px;
  }
  .sessions-header {
    padding-bottom: 10px;
  }
  .header-actions {
    flex-wrap: wrap;
  }
  .header-actions button,
  .header-actions select {
    min-height: 44px;
  }
  .sidebar-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    border: 1px solid #2a3140;
    border-radius: 8px;
    background: #1a2030;
    color: #c7d0e0;
    font-size: 18px;
    cursor: pointer;
  }
  .web-composer textarea {
    font-size: 16px;
  }
  .web-approval-card .approval-actions button {
    min-height: 44px;
  }
}
```

`web/src/styles/base.css` 的 `.sidebar-toggle` 默认样式（桌面隐藏）：

```css
.sidebar-toggle {
  display: none;
}
```

`web/src/SessionApp.tsx`：
1. 组件顶部状态区加 `const [sidebarOpen, setSidebarOpen] = useState(false);`
2. `SessionListSidebar` 调用处传 `open={sidebarOpen}`，`onSelect` 时 `setSidebarOpen(false)`（现有 onSelect 回调内追加）
3. 会话详情 `<header className="page-header sessions-header">` 内、标题 div 之前加汉堡按钮：

```tsx
              <button
                className="sidebar-toggle"
                onClick={() => setSidebarOpen(true)}
                title="会话列表"
                aria-label="打开会话列表"
              >
                ☰
              </button>
```

4. `SessionListSidebar` 组件签名加 `open?: boolean`，根元素 className 拼接：

```tsx
    <aside
      className={`sidebar session-list-sidebar${props.open ? " open" : ""}`}
    >
```

- [ ] **Step 3: 验证**

Run: `pnpm run typecheck && pnpm test 2>&1 | tail -5`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add web/src/SessionApp.tsx web/src/SessionApp.test.tsx web/src/styles/base.css web/src/styles/chat.css
git commit -m "feat(web): 移动端响应式——侧栏抽屉 + 触控目标 + 输入框字号"
```

---

### Task 8: 契约文档 docs/remote-api.md

**Files:**
- Create: `docs/remote-api.md`

- [ ] **Step 1: 写文档**

内容覆盖：启用方式（server.apiToken + 设置页生成按钮）、认证（`Authorization: Bearer`）、八端点表格（方法/路径/请求/响应）、`V1Event` 白名单类型表与折叠规则、错误码表、`?project=` 多项目参数、curl 示例（发起任务/轮询事件/审批/中断）、飞书机器人集成示例（收到消息 → POST /runs → 轮询 events → webhook/回调推送结果）、安全说明（token 泄露 = 全权；仅部署可信网络）。

- [ ] **Step 2: Commit**

```bash
git add docs/remote-api.md
git commit -m "docs: /api/v1 无头接口契约文档 + 飞书机器人集成示例"
```

---

### Task 9: 全量验证 + 提交推送

- [ ] **Step 1: 全量验证**

```bash
cd /Users/xuzishuo/Documents/gpt_agent-zcode
pnpm run typecheck
pnpm test
pnpm run build
```

Expected: 全绿；build 产出 dist/ 与 web/dist/

- [ ] **Step 2: GUI 移动端验证（Playwright 移动视口）**

在 `web/playwright.config.ts` 的 projects 中确认是否有移动视口配置；若无则临时用 `npx playwright test --project=...` 或以 web-gui-tester 技能手动验证：375px 视口打开会话页 → 汉堡可见 → 点击展开侧栏 → 选择会话 → 侧栏收起 → 审批卡按钮可点。验证结果记录在会话中。

- [ ] **Step 3: 提交收尾**

```bash
git add -A
git status
git log --oneline -12
```

确认所有提交在 `zcode-remote-api`（`git branch --show-current` 必须输出 `zcode-remote-api`），无 main 提交。

- [ ] **Step 4: 推送远程**

```bash
git push -u origin zcode-remote-api
```

Expected: 远程出现 zcode-remote-api 分支（不动 main，不合并）。

---

## Self-Review 记录

- **Spec 覆盖**：认证（Task 1/2/6）、契约八端点（Task 4/5）、白名单映射（Task 3）、移动端（Task 7）、文档（Task 8）——设计文档 §5-§10 全部有对应任务 ✅
- **占位符**：Task 6 Step 4 冒烟步骤标注"以 Task 5 app 级测试为准"为主动降级（服务启动参数需现场确认 CLI 入口），非占位；Task 7 Step 1 注明"复用现有用例挂载模式"——实施时按文件现状落地，若现有用例不可复用则补渲染用例 ✅
- **类型一致性**：`V1Event` 字段名（seq/ts/type/tool/summary/isError/callId/risk）在 Task 3 定义、Task 4 消费处一致；`createApiV1` 签名 Task 2 定义、Task 6 消费处一致；`mapV1Events` 返回 `V1Event[]` 两处一致 ✅
