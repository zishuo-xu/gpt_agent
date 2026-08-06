import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "./types.js";
import { DesktopNotifier } from "./notifier.js";

function listenerSpy() {
  const listeners: Array<(event: AgentEvent) => void> = [];
  return {
    listeners,
    subscribe: (listener: (event: AgentEvent) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

test("DesktopNotifier：done/error/notify(warn|error) 触发通知，其他事件不触发", () => {
  // 限速为同会话每小时 2 条：这里发 3 个推送事件验证事件筛选（第 3 条被限速丢弃，
  // 断言消息内容验证前两条正确筛选；限速本身有独立测试）
  const spy = listenerSpy();
  const pushes: Array<[string, string]> = [];
  const notifier = new DesktopNotifier(spy.subscribe, {
    enabled: true,
    sessionTitle: "测试会话",
    platform: "darwin",
    notify: (title, body) => pushes.push([title, body]),
  });

  spy.emit({ type: "done" });
  spy.emit({ type: "error", message: "模型失败" });
  spy.emit({ type: "notify", level: "warn", message: "审批超时" });
  spy.emit({ type: "notify", level: "info", message: "忽略" });
  spy.emit({ type: "text_delta", text: "不触发" });

  assert.equal(pushes.length, 2, "done/error 推送；warn 因限速被丢弃");
  assert.equal(pushes[0]?.[0], "任务完成");
  assert.ok(pushes[0]?.[1].includes("测试会话"));
  assert.equal(pushes[1]?.[0], "任务出错");
  notifier.dispose();
});

test("DesktopNotifier：非 macOS 平台不订阅（enabled 但平台不符）", () => {
  const spy = listenerSpy();
  const notifier = new DesktopNotifier(spy.subscribe, {
    enabled: true,
    sessionTitle: "t",
    platform: "linux",
    notify: () => undefined,
  });
  spy.emit({ type: "done" });
  assert.equal(spy.listeners.length, 0, "linux 平台不订阅");
  notifier.dispose();
});

test("DesktopNotifier：enabled=false 不订阅", () => {
  const spy = listenerSpy();
  const notifier = new DesktopNotifier(spy.subscribe, {
    enabled: false,
    sessionTitle: "t",
    platform: "darwin",
    notify: () => undefined,
  });
  spy.emit({ type: "done" });
  assert.equal(spy.listeners.length, 0);
  notifier.dispose();
});

test("DesktopNotifier：notify warn/error 分别触发「审批超时/任务出错」", () => {
  const spy = listenerSpy();
  const pushes: Array<[string, string]> = [];
  const notifier = new DesktopNotifier(spy.subscribe, {
    enabled: true,
    sessionTitle: "分类测试",
    platform: "darwin",
    notify: (title, body) => pushes.push([title, body]),
  });
  spy.emit({ type: "notify", level: "warn", message: "审批超时" });
  spy.emit({ type: "notify", level: "error", message: "模型持续失败" });
  spy.emit({ type: "notify", level: "info", message: "忽略" });
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0]?.[0], "审批超时");
  assert.equal(pushes[1]?.[0], "任务出错");
  notifier.dispose();
});

test("DesktopNotifier：同会话每小时最多 2 条", () => {
  const spy = listenerSpy();
  const pushes: Array<[string, string]> = [];
  const notifier = new DesktopNotifier(spy.subscribe, {
    enabled: true,
    sessionTitle: "限速测试",
    platform: "darwin",
    notify: (title, body) => pushes.push([title, body]),
  });
  for (let index = 0; index < 5; index += 1) {
    spy.emit({ type: "done" });
  }
  assert.equal(pushes.length, 2, "限速 2 条/小时");
  notifier.dispose();
});

test("DesktopNotifier：dispose 后不再推送", () => {
  const spy = listenerSpy();
  const pushes: Array<[string, string]> = [];
  const notifier = new DesktopNotifier(spy.subscribe, {
    enabled: true,
    sessionTitle: "t",
    platform: "darwin",
    notify: (title, body) => pushes.push([title, body]),
  });
  notifier.dispose();
  spy.emit({ type: "done" });
  assert.equal(pushes.length, 0);
});
