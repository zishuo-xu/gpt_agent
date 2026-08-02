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

function stubFetch(
  responses: Array<{ status?: number }> = [],
): {
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
  assert.equal(fetch.calls[0].url, "https://example.com/hook");
  assert.deepEqual(fetch.calls[0].body, {
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
  assert.deepEqual(fetch.calls[0].body, {
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
  assert.equal(fetch.calls[0].body.title, "任务出错");
  assert.match(fetch.calls[0].body.body, /模型调用失败/);
  assert.equal(fetch.calls[1].body.title, "审批超时");
  assert.match(fetch.calls[1].body.body, /已自动拒绝：Bash rm -rf/);
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
  assert.deepEqual(fetch.calls[0].body, {
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
