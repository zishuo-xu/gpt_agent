import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseRunCommand } from "../core/run-task.js";
import {
  BUDGET_RETRY_MS,
  FAIL_RETRY_MINUTES,
  MAX_ATTEMPTS,
  SchedulerHub,
} from "./scheduler-hub.js";

const BASE_AT = "2026-08-09T09:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-hub-"));
  const hub = new SchedulerHub(root);
  const scheduler = await hub.ensureLoaded("proj-key");
  const options = parseRunCommand("/run 巡检");
  const task = await scheduler.add({
    command: "/run 巡检",
    options,
    at: BASE_AT,
  });
  return { hub, scheduler, task };
}

test("tick：onDue 成功 → confirm（一次性任务移除 + 记录会话）", async () => {
  const { hub, scheduler, task } = await fixture();
  let started = 0;
  await hub.tick(new Date("2026-08-09T09:00:30.000Z"), async () => {
    started += 1;
    return "sess-abc";
  });
  assert.equal(started, 1);
  assert.equal(scheduler.list().length, 0);
  assert.equal(task.id.length, 8);
  // lastRun 记录在 confirm 后已随任务移除而消失（一次性），改由周期用例验证
});

test("tick：onDue 成功 → 周期任务记录 lastRun 并重排", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-hub-"));
  const hub = new SchedulerHub(root);
  const scheduler = await hub.ensureLoaded("proj-key");
  const options = parseRunCommand("/run 巡检 --every 60");
  await scheduler.add({
    command: "/run 巡检 --every 60",
    options,
    at: BASE_AT,
    everyMinutes: 60,
  });
  const now = new Date("2026-08-09T09:30:00.000Z");
  await hub.tick(now, async () => "sess-123");
  const current = scheduler.list()[0];
  assert.equal(current?.at, "2026-08-09T10:00:00.000Z");
  assert.equal(current?.lastRunStatus, "started");
  assert.equal(current?.lastRunAt, now.toISOString());
  assert.equal(current?.lastRunSessionId, "sess-123");
});

test("tick：onDue 抛错 → retry 顺延，第 4 次失败丢弃", async () => {
  const { hub, scheduler, task } = await fixture();
  // 每次失败后推进一个重试周期，任务重新到期
  let now = new Date("2026-08-09T09:00:30.000Z");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await hub.tick(now, async () => {
      throw new Error(`启动失败 ${attempt}`);
    });
    const current = scheduler.list().find((item) => item.id === task.id);
    assert.ok(current, `第 ${attempt} 次重试后任务应仍在`);
    assert.equal(current.attempts, attempt);
    assert.equal(
      current.at,
      new Date(now.getTime() + FAIL_RETRY_MINUTES * 60_000).toISOString(),
    );
    now = new Date(now.getTime() + FAIL_RETRY_MINUTES * 60_000);
  }

  // 第 4 次失败：丢弃
  await hub.tick(now, async () => {
    throw new Error("final");
  });
  assert.equal(scheduler.list().length, 0);
});

test("tick：onDue 返回 false（预算护栏）→ postpone 顺延 24h 不重试", async () => {
  const { hub, scheduler, task } = await fixture();
  const now = new Date("2026-08-09T09:00:30.000Z");
  await hub.tick(now, async () => false);
  const current = scheduler.list().find((item) => item.id === task.id);
  assert.ok(current);
  assert.equal(current.attempts, undefined, "预算顺延不计入失败次数");
  assert.equal(
    current.at,
    new Date(now.getTime() + BUDGET_RETRY_MS).toISOString(),
  );
});

test("tick：周期任务 confirm 后按原时刻重排", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-hub-"));
  const hub = new SchedulerHub(root);
  const scheduler = await hub.ensureLoaded("proj-key");
  const options = parseRunCommand("/run 巡检 --every 60");
  await scheduler.add({
    command: "/run 巡检 --every 60",
    options,
    at: BASE_AT,
    everyMinutes: 60,
  });
  await hub.tick(new Date("2026-08-09T09:30:00.000Z"), async () => "sess-1");
  assert.equal(scheduler.list()[0]?.at, "2026-08-09T10:00:00.000Z");
});
