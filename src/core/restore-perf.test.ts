import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigService } from "../config/service.js";
import { AgentSessionManager } from "./session-manager.js";

function makeEvent(seq: number, round: number): Record<string, unknown> {
  return {
    seq,
    ts: new Date(2026, 0, 1, 0, 0, seq % 60).toISOString(),
    sessionId: "big-1",
    branchId: "main",
    event:
      round % 3 === 0
        ? {
            type: "user",
            text: `第 ${round} 轮：检查并修改 src/lib/math.ts 中的函数实现，确保单元测试全部通过后再收尾。`,
          }
        : round % 3 === 1
          ? {
              type: "tool_call",
              call: {
                id: `call-${round}`,
                tool: "Read",
                target: "src/lib/math.ts",
                args: { file_path: "src/lib/math.ts" },
              },
            }
          : {
              type: "tool_result",
              callId: `call-${round - 1}`,
              summary: `读取 ${round} 行`,
              output: `export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }`,
            },
  };
}

test("restore 性能护栏：2 万事件会话恢复 < 3s 且状态完整", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "myagent-perf-state-"));
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "myagent-perf-home-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-perf-cwd-"));
  const sessionsDir = path.join(
    stateDir,
    "projects",
    Buffer.from(cwd).toString("base64url"),
    "sessions",
  );
  await mkdir(sessionsDir, { recursive: true });
  const total = 20_000;
  const lines: string[] = [];
  for (let seq = 1; seq <= total; seq += 1) {
    lines.push(JSON.stringify(makeEvent(seq, seq)));
  }
  await writeFile(path.join(sessionsDir, "big-1.jsonl"), lines.join("\n") + "\n");

  const configService = new ConfigService({ cwd, homeDir });
  const started = performance.now();
  const manager = new AgentSessionManager({
    cwd,
    configService,
    stateDir,
    homeDir,
    skipLock: true,
  });
  await manager.restore();
  await manager.releaseLock();
  const elapsed = performance.now() - started;

  const restored = manager.get("big-1");
  assert.ok(restored, "会话应恢复");
  assert.equal(
    restored.summary().toolCallCount,
    Math.ceil(total / 3),
    "工具调用计数完整",
  );
  const first = restored.events().find((e) => e.event.type === "user");
  assert.equal(first?.event.type, "user", "首事件为用户消息");
  assert.ok(elapsed < 3_000, `restore ${elapsed.toFixed(0)}ms 应 < 3s`);
});
