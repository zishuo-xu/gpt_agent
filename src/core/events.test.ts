import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentEventBus,
  SessionStore,
  TraceStore,
} from "./events.js";

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
});
