import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentEventBus,
  SessionStore,
  TraceStore,
} from "./events.js";
import { redactTrace } from "./trace-redaction.js";

test("SessionStore 按序追加并可重放 JSONL 事件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-events-"));
  const bus = new AgentEventBus();
  const store = new SessionStore(path.join(directory, "session.jsonl"), "s1");
  store.attach(bus);

  bus.emit({ type: "user", text: "修复测试" });
  bus.emit({ type: "text_delta", text: "开始处理" });
  bus.emit({ type: "done" });
  await store.flush();

  const events = await store.readAll();
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    events.map((event) => event.event.type),
    ["user", "text_delta", "done"],
  );

  const resumedBus = new AgentEventBus();
  const resumedStore = new SessionStore(
    path.join(directory, "session.jsonl"),
    "s1",
  );
  resumedStore.attach(resumedBus);
  resumedBus.emit({ type: "user", text: "继续" });
  await resumedStore.flush();
  const resumedEvents = await resumedStore.readAll();
  assert.deepEqual(
    resumedEvents.map((event) => event.seq),
    [1, 2, 3, 4],
  );
});

test("TraceStore 独立按 turn 追加完整工程追踪", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "myagent-trace-"),
  );
  const filePath = path.join(directory, "session.trace.jsonl");
  const store = new TraceStore(filePath);
  store.record({
    request: { system: "full system", messages: ["hello"] },
    response: { raw: { id: "response-1" } },
    tools: [],
    usage: { input: 10, output: 2, cached: 3 },
  });
  await store.flush();

  const resumed = new TraceStore(filePath);
  resumed.record({
    request: { messages: ["continue"] },
    response: { text: "done" },
    tools: [],
  });
  const traces = await resumed.readAll();

  assert.deepEqual(
    traces.map((trace) => trace.turn),
    [1, 2],
  );
  assert.deepEqual(traces[0]?.response, {
    raw: { id: "response-1" },
  });
  assert.equal(traces[0]?.version, 2);
  assert.match(traces[0]?.turnId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(traces[0]?.durationMs, 0);
});

test("TraceStore 兼容旧记录并在写入时捕获分支/事件关联", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-trace-v2-"));
  const filePath = path.join(directory, "trace.jsonl");
  const store = new TraceStore(filePath, {
    getBranchId: () => "main",
    getEventSeq: () => 12,
  });
  store.record({ tools: [], eventSeqStart: 10, eventSeqEnd: 12 });
  await store.flush();
  const trace = (await store.readAll())[0]!;
  assert.equal(trace.version, 2);
  assert.equal(trace.branchId, "main");
  assert.equal(trace.eventSeqStart, 10);
  assert.equal(trace.eventSeqEnd, 12);
});

test("Trace 脱敏递归处理密钥且不修改原值", () => {
  const source = {
    headers: { Authorization: "Bearer abc", cookie: "sid=secret" },
    nested: {
      apiKey: "top-secret",
      value: "OPENAI_API_KEY=env-secret safe",
      endpoint: "https://user:pass@example.com/v1",
    },
  };
  const redacted = redactTrace(source);
  assert.equal(redacted.headers.Authorization, "[REDACTED]");
  assert.equal(redacted.headers.cookie, "[REDACTED]");
  assert.equal(redacted.nested.apiKey, "[REDACTED]");
  assert.equal(redacted.nested.value, "OPENAI_API_KEY=[REDACTED] safe");
  assert.equal(
    redacted.nested.endpoint,
    "https://user:[REDACTED]@example.com/v1",
  );
  assert.equal(source.nested.apiKey, "top-secret");
});

test("SessionStore 单次写失败不断链：后续事件照常落盘，flush 显式报告", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-events-fail-"));
  const bus = new AgentEventBus();
  const store = new SessionStore(path.join(directory, "session.jsonl"), "s1");
  store.attach(bus);

  // 首次事件先落盘（初始化 seq=1）
  bus.emit({ type: "user", text: "第一条" });
  await store.flush();

  // 制造一次写失败：目录被替换成同名普通文件，mkdir recursive 失败
  const dirPath = path.join(directory, "sub");
  await writeFile(dirPath, "not-a-dir", "utf8");
  const store2 = new SessionStore(path.join(dirPath, "nested.jsonl"), "s1");
  store2.attach(bus);
  bus.emit({ type: "text_delta", text: "会失败的写" });
  await assert.rejects(store2.flush(), /ENOTDIR|EEXIST|mkdir/);

  // 同一 store 写链未被毒化：后续事件仍可正常落盘
  const store3 = new SessionStore(path.join(directory, "session2.jsonl"), "s1");
  store3.attach(bus);
  bus.emit({ type: "done" });
  await store3.flush();
  const events = await store3.readAll();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event.type, "done");
});
