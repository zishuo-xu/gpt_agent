import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionSummary } from "@shared/types.js";

const originalFetch = globalThis.fetch;

function session(experiment = false): SessionSummary {
  return {
    id: experiment ? "child-1" : "parent-1",
    title: experiment ? "实验" : "父会话",
    status: "done",
    permissionMode: "normal",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:01.000Z",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    totalMissedTokens: 0,
    totalMissedCostCny: 0,
    totalCostCny: 0,
    todos: [],
    toolCallCount: 0,
    kind: "interactive",
    costByModel: [],
    ...(experiment
      ? {
          experiment: {
            parentSessionId: "parent-1",
            parentTurnId: "turn-1",
            pinnedModel: { providerId: "test", model: "child" },
            status: "ready" as const,
            createdAt: "2026-08-25T00:00:00.000Z",
            workspacePath: "/tmp/child",
          },
        }
      : {}),
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setTextarea(element: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
    .set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FlightRecorder Web 调试闭环", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    GlobalRegistrator.unregister();
  });

  it("默认脱敏查看 Trace，显式加载原文并展示 Fork 快照警告", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const target = String(input);
      calls.push(`${init?.method ?? "GET"} ${target}`);
      if (target.includes("/forks")) {
        return json({
          session: { id: "child-1" },
          workspace: {
            path: "/tmp/child",
            head: "abc123",
            warnings: ["依赖目录未复制"],
          },
        }, 201);
      }
      if (target.includes("/traces/turn-1")) {
        const raw = target.includes("view=raw");
        return json({
          redacted: !raw,
          trace: {
            version: 2,
            turn: 1,
            turnId: "turn-1",
            request: { system: raw ? "raw-secret" : "[REDACTED]" },
            response: { text: "done" },
            tools: [],
          },
        });
      }
      return json({
        traces: [{
          version: 2,
          turn: 1,
          turnId: "turn-1",
          providerId: "test",
          model: "parent",
          durationMs: 12,
          eventSeqStart: 1,
          eventSeqEnd: 3,
          modelRole: "main",
          usage: { input: 10, output: 2, cached: 0 },
          tools: [],
          canFork: true,
        }],
      });
    }) as typeof fetch;

    const [{ act }, { createRoot }, { FlightRecorder }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./flight-recorder"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const selected: string[] = [];
    await act(async () => {
      root.render(
        <FlightRecorder
          session={session()}
          project="project-key"
          conversation={<div>conversation</div>}
          onSelectSession={(id) => selected.push(id)}
        />,
      );
    });

    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Trace",
      ) as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.textContent ?? "", /Turn 1/);

    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "查看详情",
      ) as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.textContent ?? "", /\[REDACTED\]/);
    assert.match(container.textContent ?? "", /原文可能包含/);

    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "查看原文",
      ) as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.textContent ?? "", /raw-secret/);
    assert.ok(calls.some((call) => call.includes("view=raw")));

    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "从这里 Fork",
      ) as HTMLButtonElement).click();
    });
    assert.match(container.textContent ?? "", /不是历史文件时光机/);
    const continuation = Array.from(container.querySelectorAll("textarea")).at(-1)!;
    await act(async () => setTextarea(continuation, "继续实验"));
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Fork 并运行",
      ) as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.textContent ?? "", /依赖目录未复制/);
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "打开子会话",
      ) as HTMLButtonElement).click();
    });
    assert.deepEqual(selected, ["child-1"]);
    await act(async () => root.unmount());
  });

  it("实验会话对比页读取嵌套 diff 并展示首个行为分歧", async () => {
    globalThis.fetch = (async () => json({
      comparison: {
        parentSessionId: "parent-1",
        childSessionId: "child-1",
        parentTurnId: "turn-1",
        diff: {
          model: { parent: "test/parent", child: "test/child", changed: true },
          overlay: { parent: "", child: "alternate", changed: true },
          turns: { parent: 1, child: 2, delta: 1 },
          durationMs: { parent: 10, child: 25, delta: 15 },
          tools: {
            parent: 1,
            child: 1,
            parentSequence: ["read+a.ts"],
            childSequence: ["bash+pnpm test"],
            firstDivergence: { index: 0 },
          },
          tokens: { parent: { input: 10 }, child: { input: 20 }, delta: { input: 10 } },
          costCny: { parent: 1, child: 2, delta: 1 },
          status: { parent: "done", child: "done", changed: false },
        },
      },
    })) as typeof fetch;
    const [{ act }, { createRoot }, { FlightRecorder }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./flight-recorder"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <FlightRecorder
          session={session(true)}
          project="project-key"
          conversation={<div />}
          onSelectSession={() => undefined}
        />,
      );
    });
    await act(async () => {
      (Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "对比",
      ) as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.match(container.textContent ?? "", /首个分歧：第 1 项/);
    assert.match(container.textContent ?? "", /耗时 ms/);
    assert.match(container.textContent ?? "", /bash\+pnpm test/);
    await act(async () => root.unmount());
  });
});
