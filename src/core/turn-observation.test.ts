import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnTrace } from "./events.js";
import { observeTurn } from "./turn-observation.js";

const trace = (overrides: Partial<AgentTurnTrace> = {}): AgentTurnTrace => ({
  version: 2,
  turn: 1,
  ts: "2026-01-01T00:00:00.000Z",
  tools: [],
  ...overrides,
});

test("observeTurn reads saw / decided / did from an existing trace", () => {
  const observation = observeTurn(
    trace({
      request: {
        messages: [
          { role: "user", content: "先读 math.ts 再改加法" },
          { role: "assistant", content: "ok", toolCalls: [] },
        ],
      },
      response: {
        text: "我先读文件",
        toolCalls: [{ id: "c1", tool: "Read", target: "math.ts", args: {} }],
      },
      tools: [
        {
          call: { id: "c1", tool: "Read", target: "math.ts", args: {} },
          permission: "allow",
          result: { summary: "ok", isError: false },
          ms: 4,
        },
      ],
      workspace: { head: "abc", dirty: "def" },
    }),
  );
  assert.equal(observation.saw.messages, 2);
  assert.equal(observation.saw.lastUser, "先读 math.ts 再改加法");
  assert.deepEqual(observation.decided.tools, ["Read"]);
  assert.equal(observation.decided.text, "我先读文件");
  assert.deepEqual(observation.did, [
    { tool: "Read", target: "math.ts", permission: "allow", outcome: "success" },
  ]);
  assert.deepEqual(observation.workspace, { head: "abc", dirty: "def" });
});

test("observeTurn stays tolerant when request/response are missing", () => {
  const observation = observeTurn(
    trace({
      tools: [
        {
          call: { id: "c1", tool: "Bash", target: "pnpm test", args: {} },
          permission: "ask",
          ms: 1,
        },
      ],
    }),
  );
  assert.equal(observation.saw.messages, 0);
  assert.deepEqual(observation.decided.tools, ["Bash"]);
  assert.equal(observation.did[0]?.tool, "Bash");
  assert.equal(observation.did[0]?.outcome, "unknown");
});

test("observeTurn exposes tool outcomes without inferring causality", () => {
  const observation = observeTurn(trace({
    tools: [
      { call: { id: "a", tool: "Bash", target: "bad", args: {} }, permission: "allow", result: { isError: true }, ms: 1 },
      { call: { id: "b", tool: "Write", target: "x", args: {} }, permission: "deny", ms: 1 },
      { call: { id: "c", tool: "Read", target: "x", args: {} }, permission: "allow", result: { aborted: true }, ms: 1 },
      { call: { id: "d", tool: "Read", target: "x", args: {} }, permission: "user_denied", result: { error: "denied" }, ms: 1 },
    ],
  }));
  assert.deepEqual(observation.did.map((item) => item.outcome), ["error", "denied", "aborted", "denied"]);
});
