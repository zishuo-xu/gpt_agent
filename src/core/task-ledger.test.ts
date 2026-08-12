import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  normalizeLedgerPath,
  TaskLedger,
} from "./task-ledger.js";
import type { LedgerUnit } from "./types.js";

function unit(overrides: Partial<LedgerUnit> = {}): LedgerUnit {
  return {
    id: "src/a.ts",
    kind: "file",
    label: "src/a.ts",
    status: "done",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

test("markFileWritten：未登记文件自动补集（计划漂移不丢信息）", () => {
  const ledger = new TaskLedger("t1");
  const changed = ledger.markFileWritten("src/new-file.ts");
  assert.ok(changed);
  assert.equal(changed.kind, "file");
  assert.equal(changed.status, "done");
  assert.match(changed.note ?? "", /待验证/);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.units.length, 1);
  assert.equal(snapshot.units[0]?.id, "src/new-file.ts");
});

test("markFileWritten：已登记单元（pending）置 done，保留原字段", () => {
  const ledger = new TaskLedger("t1", [unit({ id: "src/a.ts", status: "pending" })]);
  const changed = ledger.markFileWritten("src/a.ts");
  assert.ok(changed);
  assert.equal(changed.status, "done");
  assert.equal(changed.kind, "file");
});

test("markFileWritten：幂等——已 done 的单元重复命中返回 undefined（不重复记账）", () => {
  const ledger = new TaskLedger("t1", [unit({ id: "src/a.ts", status: "done" })]);
  const changed = ledger.markFileWritten("src/a.ts");
  assert.equal(changed, undefined);
  assert.equal(ledger.snapshot().units.length, 1);
});

test("markFileWritten：verified 单元再次修改回退为 done（文件被动过需重新验证）", () => {
  const ledger = new TaskLedger("t1", [unit({ id: "src/a.ts", status: "verified" })]);
  const changed = ledger.markFileWritten("src/a.ts");
  assert.ok(changed);
  assert.equal(changed.status, "done");
});

test("applyUpdate：恢复投影——逐条应用 ledger_update 重建账本", () => {
  const ledger = new TaskLedger("t1");
  ledger.applyUpdate(unit({ id: "src/one.ts", status: "done" }));
  ledger.applyUpdate(unit({ id: "src/two.ts", status: "done" }));
  ledger.applyUpdate(unit({ id: "src/three.ts", status: "blocked" }));
  assert.equal(ledger.unitCount, 3);
  const summary = ledger.toSummary();
  assert.equal(summary.total, 3);
  assert.equal(summary.done, 2);
  assert.equal(summary.remaining.length, 1);
  assert.equal(summary.remaining[0]?.id, "src/three.ts");
});

test("applyUpdate：同 id 覆盖（后写胜出，事件流时序保证）", () => {
  const ledger = new TaskLedger("t1");
  ledger.applyUpdate(unit({ id: "src/a.ts", status: "pending" }));
  ledger.applyUpdate(unit({ id: "src/a.ts", status: "done", note: "系统自动记录" }));
  assert.equal(ledger.unitCount, 1);
  assert.equal(ledger.snapshot().units[0]?.status, "done");
});

test("toSummary：verified 折叠为计数，不进入剩余清单", () => {
  const ledger = new TaskLedger("t1", [
    unit({ id: "a.ts", status: "verified" }),
    unit({ id: "b.ts", status: "done" }),
    unit({ id: "c.ts", status: "pending" }),
    unit({ id: "d.ts", status: "blocked" }),
  ]);
  const summary = ledger.toSummary();
  assert.equal(summary.verified, 1);
  assert.deepEqual(
    summary.remaining.map((item) => item.id),
    ["c.ts", "d.ts"],
  );
});

test("恢复构造：restoredUnits 初始化", () => {
  const ledger = new TaskLedger("t1", [unit({ id: "a.ts" }), unit({ id: "b.ts" })]);
  assert.equal(ledger.unitCount, 2);
});

test("normalizeLedgerPath：相对路径原样 POSIX 化", () => {
  const cwd = "/proj";
  assert.equal(normalizeLedgerPath(cwd, "src/a.ts"), "src/a.ts");
  assert.equal(normalizeLedgerPath(cwd, "./src/a.ts"), "src/a.ts");
});

test("normalizeLedgerPath：绝对路径相对化", () => {
  const cwd = "/proj";
  assert.equal(normalizeLedgerPath(cwd, "/proj/src/a.ts"), "src/a.ts");
});

test("normalizeLedgerPath：反斜杠（Windows 风格）转正斜杠", () => {
  const cwd = path.resolve("/proj");
  const input = path.resolve(cwd, "src\\a.ts");
  assert.equal(normalizeLedgerPath(cwd, input), "src/a.ts");
});

test("normalizeLedgerPath：逃出 cwd 保留绝对形态（不强行相对化）", () => {
  const cwd = "/proj";
  const outside = normalizeLedgerPath(cwd, "/other/place.ts");
  assert.ok(outside.startsWith("/other/"), `实际: ${outside}`);
});

test("normalizeLedgerPath：同 cwd 相对化与账本 markFileWritten 对齐", () => {
  const cwd = "/proj";
  const abs = path.join(cwd, "src", "b.ts");
  const ledger = new TaskLedger("t1");
  const changed = ledger.markFileWritten(normalizeLedgerPath(cwd, abs));
  assert.equal(changed?.id, "src/b.ts");
});
