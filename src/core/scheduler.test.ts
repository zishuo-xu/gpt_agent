import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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

test("add/list/persist：新实例 load 后能看到落盘任务", async () => {
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
  const { writeFile } = await import("node:fs/promises");
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

test("due：一次性任务到期即出队并移除", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const scheduler = new RunScheduler(path.join(dir, "scheduled.jsonl"));
  await scheduler.load();
  const added = await makeTask(scheduler);

  // 未到期：不触发
  assert.equal(scheduler.due(new Date("2026-08-09T08:59:59.000Z")).length, 0);
  // 到期：触发一次并删除
  const fired = scheduler.due(new Date("2026-08-09T09:00:01.000Z"));
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.id, added.id);
  assert.equal(scheduler.list().length, 0);
  // 再触发：已删除，不再触发
  assert.equal(scheduler.due(new Date("2026-08-09T10:00:00.000Z")).length, 0);
});

test("due：周期任务到期后按原时刻重排（不累积漂移）", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const scheduler = new RunScheduler(path.join(dir, "scheduled.jsonl"));
  await scheduler.load();
  await makeTask(scheduler, { everyMinutes: 30 });

  // 原定 09:00，now = 10:05（错过 09:30 / 10:00 两个周期）→ 触发一次，重排到 10:30
  const fired = scheduler.due(new Date("2026-08-09T10:05:00.000Z"));
  assert.equal(fired.length, 1);
  const remaining = scheduler.list();
  assert.equal(remaining.length, 1);
  assert.equal(
    remaining[0]?.at,
    "2026-08-09T10:30:00.000Z",
  );
  // 重排后的任务在新时刻之前不再触发
  assert.equal(scheduler.due(new Date("2026-08-09T10:29:59.000Z")).length, 0);
});

test("remove：删除存在的任务并持久化；不存在的返回 false", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "myagent-sched-"));
  const file = path.join(dir, "scheduled.jsonl");
  const scheduler = new RunScheduler(file);
  await scheduler.load();
  const added = await makeTask(scheduler);

  assert.equal(await scheduler.remove("nope"), false);
  assert.equal(await scheduler.remove(added.id), true);
  assert.equal(scheduler.list().length, 0);

  const reloaded = new RunScheduler(file);
  await reloaded.load();
  assert.equal(reloaded.list().length, 0);
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
