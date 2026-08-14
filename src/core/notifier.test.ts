import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AgentEvent } from "./types.js";
import { WebhookNotifier } from "./notifier.js";

function createBus() {
  const emitter = new EventEmitter();
  return {
    emit: (event: AgentEvent) => emitter.emit("event", event),
    subscribe: (listener: (event: AgentEvent) => void) => {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
}

function stubFetch(): {
  calls: Array<{ url: string; body: unknown }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("任务完成时推送通用 JSON", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "测试会话",
  });
  bus.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0]!.url, "https://example.com/hook");
  assert.deepEqual(fetch.calls[0]!.body, {
    title: "任务完成",
    body: "会话「测试会话」已完成。",
  });
  notifier.dispose();
  fetch.restore();
});

test("企业微信机器人使用 msgtype 格式", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl:
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
    sessionTitle: "会话A",
  });
  bus.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fetch.calls[0]!.body, {
    msgtype: "text",
    text: { content: "[MyAgent] 任务完成\n会话「会话A」已完成。" },
  });
  notifier.dispose();
  fetch.restore();
});

test("出错与审批超时均推送", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "会话B",
  });
  bus.emit({ type: "error", message: "模型调用失败" });
  bus.emit({
    type: "notify",
    level: "warn",
    message: "审批超时（60s 无人响应），已自动拒绝：Bash rm -rf /",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 2);
  assert.equal((fetch.calls[0]!.body as { title: string }).title, "任务出错");
  assert.match((fetch.calls[0]!.body as { body: string }).body, /模型调用失败/);
  assert.equal((fetch.calls[1]!.body as { title: string }).title, "审批超时");
  assert.match((fetch.calls[1]!.body as { body: string }).body, /已自动拒绝：Bash rm -rf/);
  notifier.dispose();
  fetch.restore();
});

test("同一会话每小时最多推送 2 条（限频）", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "会话C",
  });
  bus.emit({ type: "done" });
  bus.emit({ type: "error", message: "e1" });
  bus.emit({ type: "done" });
  bus.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 2, "超过每小时上限的推送应被丢弃");
  notifier.dispose();
  fetch.restore();
});

test("飞书自定义机器人使用 msg_type 格式", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl:
      "https://open.feishu.cn/open-apis/bot/v2/hook/abc-def",
    sessionTitle: "会话A",
  });
  bus.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fetch.calls[0]!.body, {
    msg_type: "text",
    content: { text: "[MyAgent] 任务完成\n会话「会话A」已完成。" },
  });
  notifier.dispose();
  fetch.restore();
});

test("未配置 webhook 时不推送", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "",
    sessionTitle: "会话D",
  });
  bus.emit({ type: "done" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 0);
  notifier.dispose();
  fetch.restore();
});

test("run_finished 终态推送：completed 附带耗时/费用摘要", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "巡检任务",
    getSummary: () => ({
      id: "s1",
      title: "巡检任务",
      status: "done",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:35:00.000Z",
      totalInputTokens: 12345,
      totalOutputTokens: 600,
      totalCachedTokens: 0,
      totalCostCny: 0.42,
      totalMissedTokens: 0,
      totalMissedCostCny: 0,
      todos: [],
      toolCallCount: 8,
      costByModel: [],
      kind: "run",
    }),
  });
  bus.emit({
    type: "run_finished",
    taskId: "t1",
    status: "completed",
    reason: "done",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 1);
  assert.equal((fetch.calls[0]!.body as { title: string }).title, "任务已完成");
  assert.match((fetch.calls[0]!.body as { body: string }).body, /「巡检任务」的无人值守任务已完成/);
  assert.match((fetch.calls[0]!.body as { body: string }).body, /耗时 35 分钟/);
  assert.match((fetch.calls[0]!.body as { body: string }).body, /费用 ¥0\.42/);
  assert.match((fetch.calls[0]!.body as { body: string }).body, /输入 12345 tokens/);
  notifier.dispose();
  fetch.restore();
});

test("run_finished failed/interrupted 推送对应终态", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "任务B",
  });
  bus.emit({ type: "run_finished", taskId: "t1", status: "failed", reason: "error" });
  bus.emit({ type: "run_finished", taskId: "t2", status: "interrupted" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 2);
  assert.equal((fetch.calls[0]!.body as { title: string }).title, "任务已失败");
  assert.match((fetch.calls[0]!.body as { body: string }).body, /（error）/);
  assert.equal((fetch.calls[1]!.body as { title: string }).title, "任务已中断");
  notifier.dispose();
  fetch.restore();
});

test("run 会话的 done 不双推（由 run_finished 覆盖）；交互会话照常", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "任务C",
    getSummary: () => ({
      id: "s1",
      title: "任务C",
      status: "done",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:03.000Z",
      totalInputTokens: 3893,
      totalOutputTokens: 37,
      totalCachedTokens: 0,
      totalCostCny: 0.001,
      totalMissedTokens: 0,
      totalMissedCostCny: 0,
      todos: [],
      toolCallCount: 0,
      costByModel: [],
      kind: "run",
    }),
  });
  bus.emit({ type: "done" });
  bus.emit({ type: "run_finished", taskId: "t1", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 1, "run 会话只推 run_finished，不推 done");
  assert.equal((fetch.calls[0]!.body as { title: string }).title, "任务已完成");
  notifier.dispose();
  fetch.restore();
});

test("通用网关推送附带结构化字段（status/cost/tokens/sessionId/durationMs）", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl: "https://example.com/hook",
    sessionTitle: "任务D",
    getSummary: () => ({
      id: "sess-9",
      title: "任务D",
      status: "error",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:40:00.000Z",
      totalInputTokens: 8000,
      totalOutputTokens: 300,
      totalCachedTokens: 0,
      totalCostCny: 0.66,
      totalMissedTokens: 0,
      totalMissedCostCny: 0,
      todos: [],
      toolCallCount: 2,
      costByModel: [],
      kind: "run",
    }),
  });
  bus.emit({
    type: "run_finished",
    taskId: "t1",
    status: "failed",
    reason: "error",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(fetch.calls[0]!.body, {
    title: "任务已失败",
    body: "会话「任务D」的无人值守任务已失败（error）。耗时 40 分钟 · 费用 ¥0.66 · 输入 8000 tokens",
    status: "failed",
    sessionId: "sess-9",
    costCny: 0.66,
    tokens: 8000,
    durationMs: 40 * 60_000,
  });
  notifier.dispose();
  fetch.restore();
});

test("企业微信/飞书机器人格式不携带结构化字段（文本格式不变）", async () => {
  const bus = createBus();
  const fetch = stubFetch();
  const notifier = new WebhookNotifier(bus.subscribe, {
    webhookUrl:
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
    sessionTitle: "会话E",
    getSummary: () => ({
      id: "sess-9",
      title: "会话E",
      status: "done",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:03.000Z",
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalCachedTokens: 0,
      totalCostCny: 0.01,
      totalMissedTokens: 0,
      totalMissedCostCny: 0,
      todos: [],
      toolCallCount: 0,
      costByModel: [],
      kind: "run",
    }),
  });
  bus.emit({ type: "run_finished", taskId: "t1", status: "completed" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fetch.calls[0]!.body, {
    msgtype: "text",
    text: {
      content:
        "[MyAgent] 任务已完成\n会话「会话E」的无人值守任务已完成。耗时 0 分钟 · 费用 ¥0.01 · 输入 100 tokens",
    },
  });
  assert.equal((fetch.calls[0]!.body as { status?: unknown }).status, undefined);
  notifier.dispose();
  fetch.restore();
});
