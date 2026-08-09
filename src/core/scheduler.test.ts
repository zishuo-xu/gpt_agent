import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunScheduler } from "./scheduler.js";
import { parseRunCommand, stripScheduleFlags } from "./run-task.js";

const BASE_AT = "2026-08-09T09:00:00.000Z";

function makeTask(
  scheduler: RunScheduler,
  overrides: Partial<Parameters<RunScheduler["add"]>[0]> = {},
) {
  const options = parseRunCommand("/run 例行巡检 --permission strict");
  return scheduler.add({
    command: "/run 例行巡检 --permission strict",
    options,
    at: BASE_AT,
    ...overrides,
  });
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const scheduler = new RunScheduler(path.join(dir, "scheduled.jsonl"));
  await scheduler.load();
  return scheduler;
}

test("add/list/persist：新实例 load 后能看到落盘任务（含 attempts）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const file = path.join(dir, "scheduled.jsonl");

  const first = new RunScheduler(file);
  await first.load();
  const added = await makeTask(first, { everyMinutes: 60 });
  assert.equal(first.list().length, 1);
  assert.equal(added.id.length, 8);

  // 新实例（模拟服务重启）load 后恢复同一任务
  const second = new RunScheduler(file);
  await second.load();
  const restored = second.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.id, added.id);
  assert.equal(restored[0]?.everyMinutes, 60);
  assert.equal(restored[0]?.options.permission, "strict");
});

test("load 容错：坏行跳过，不阻塞恢复", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const file = path.join(dir, "scheduled.jsonl");
  await writeFile(
    file,
    "not-json\n{\"id\":\"okid1234\",\"command\":\"/run x\",\"at\":\"2026-08-09T09:00:00.000Z\",\"createdAt\":\"2026-08-09T08:00:00.000Z\",\"options\":{\"description\":\"x\",\"hardRules\":[],\"semanticBounds\":[]}}\n",
    "utf8",
  );

  const scheduler = new RunScheduler(file);
  await scheduler.load();
  assert.equal(scheduler.list().length, 1);
  assert.equal(scheduler.list()[0]?.id, "okid1234");
});

test("due：只读返回到期任务，不修改调度状态", async () => {
  const scheduler = await fixture();
  await makeTask(scheduler);

  assert.equal(scheduler.due(new Date("2026-08-09T08:59:59.000Z")).length, 0);
  const fired = scheduler.due(new Date("2026-08-09T09:00:01.000Z"));
  assert.equal(fired.length, 1);
  // due 不消费任务：再次调用仍返回同一任务
  assert.equal(scheduler.list().length, 1);
  assert.equal(scheduler.due(new Date("2026-08-09T10:00:00.000Z")).length, 1);
});

test("confirm：一次性任务移除；周期任务按原时刻重排（不累积漂移）", async () => {
  const scheduler = await fixture();
  const oneShot = await makeTask(scheduler);
  const recurring = await makeTask(scheduler, {
    everyMinutes: 30,
    command: "/run 周期巡检 --every 30",
    options: parseRunCommand("/run 周期巡检 --every 30"),
  });

  const now = new Date("2026-08-09T10:05:00.000Z");
  await scheduler.confirm(oneShot, now);
  assert.equal(scheduler.list().length, 1);

  await scheduler.confirm(recurring, now);
  const remaining = scheduler.list();
  assert.equal(remaining.length, 1);
  // 原定 09:00，错过 09:30 / 10:00 两个周期 → 重排到 10:30
  assert.equal(remaining[0]?.at, "2026-08-09T10:30:00.000Z");
  // 重排后的任务在新时刻之前不再触发
  assert.equal(scheduler.due(new Date("2026-08-09T10:29:59.000Z")).length, 0);
});

test("postpone：一次性任务 +delayMs；周期任务保相位重排", async () => {
  const scheduler = await fixture();
  const oneShot = await makeTask(scheduler);
  const recurring = await makeTask(scheduler, {
    everyMinutes: 60,
    command: "/run 周期巡检 --every 60",
    options: parseRunCommand("/run 周期巡检 --every 60"),
  });

  const now = new Date("2026-08-09T09:10:00.000Z");
  await scheduler.postpone(oneShot, 24 * 3600_000, now);
  assert.equal(
    scheduler.list().find((task) => task.id === oneShot.id)?.at,
    "2026-08-10T09:10:00.000Z",
  );

  await scheduler.postpone(recurring, 24 * 3600_000, now);
  // 周期任务保相位：原定 09:00 每 60 分钟 → 下一次 10:00
  assert.equal(
    scheduler.list().find((task) => task.id === recurring.id)?.at,
    "2026-08-09T10:00:00.000Z",
  );
});

test("retry：attempts 递增并顺延；超上限丢弃返回 false", async () => {
  const scheduler = await fixture();
  const task = await makeTask(scheduler);
  const now = new Date("2026-08-09T09:00:00.000Z");

  assert.equal(await scheduler.retry(task, 300_000, 3, now), true);
  let current = scheduler.list().find((item) => item.id === task.id);
  assert.equal(current?.attempts, 1);
  assert.equal(current?.at, "2026-08-09T09:05:00.000Z");

  assert.equal(await scheduler.retry(task, 300_000, 3, new Date("2026-08-09T09:05:00.000Z")), true);
  current = scheduler.list().find((item) => item.id === task.id);
  assert.equal(current?.attempts, 2);
  assert.equal(current?.at, "2026-08-09T09:10:00.000Z");

  assert.equal(await scheduler.retry(task, 300_000, 3, new Date("2026-08-09T09:10:00.000Z")), true);
  current = scheduler.list().find((item) => item.id === task.id);
  assert.equal(current?.attempts, 3);

  // 第 4 次失败：超出上限，丢弃
  assert.equal(await scheduler.retry(task, 300_000, 3, new Date("2026-08-09T09:15:00.000Z")), false);
  assert.equal(scheduler.list().length, 0);
});

test("attempts 持久化：重载后保留失败次数", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const file = path.join(dir, "scheduled.jsonl");
  const first = new RunScheduler(file);
  await first.load();
  const task = await makeTask(first);
  await first.retry(task, 300_000, 3, new Date("2026-08-09T09:00:00.000Z"));

  const second = new RunScheduler(file);
  await second.load();
  assert.equal(second.list()[0]?.attempts, 1);
});

test("remove：删除存在的任务并持久化；不存在的返回 false", async () => {
  const scheduler = await fixture();
  const added = await makeTask(scheduler);

  assert.equal(await scheduler.remove("nope"), false);
  assert.equal(await scheduler.remove(added.id), true);
  assert.equal(scheduler.list().length, 0);
});

test("stripScheduleFlags：剥离 --at/--every 及其值，保留其余参数", () => {
  assert.equal(
    stripScheduleFlags(
      "/run 巡检 --at 09:30 --every 60 --permission strict",
    ),
    "/run 巡检 --permission strict",
  );
  assert.equal(
    stripScheduleFlags("/run 巡检 --budget 5 --at 23:00"),
    "/run 巡检 --budget 5",
  );
  assert.equal(stripScheduleFlags("/run 巡检"), "/run 巡检");
});

test("parseRunCommand --at/--every：校验与顺延语义", () => {
  const now = new Date("2026-08-09T10:00:00.000Z");
  // 期望值按与 parseAtTime 相同的本地时钟语义推导（避免机器时区影响断言）
  function localAt(hour: number, minute: number): string {
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.toISOString();
  }
  // 今天 09:00 已过 → 顺延明天 09:00
  const past = parseRunCommand("/run x --at 09:00", now);
  assert.equal(past.at, localAt(9, 0));
  // 今天 11:00 未过 → 今天 11:00
  const future = parseRunCommand("/run x --at 11:00", now);
  assert.equal(future.at, localAt(11, 0));
  // 周期与非法值
  const every = parseRunCommand("/run x --every 30", now);
  assert.equal(every.everyMinutes, 30);
  assert.throws(() => parseRunCommand("/run x --every 0", now), /--every/);
  assert.throws(() => parseRunCommand("/run x --at 25:00", now), /--at/);
});
