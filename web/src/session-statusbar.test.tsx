import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const mountedRoots: Array<{ unmount: () => void }> = [];

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1", title: "测试任务", status: "running", kind: "chat",
    permissionMode: "normal", createdAt: Date.now(), updatedAt: Date.now(),
    todos: [], toolCallCount: 3,
    totalInputTokens: 1000, totalOutputTokens: 200, totalCachedTokens: 0,
    totalCostCny: 0.12, ...overrides,
  } as never; // SessionSummary 字段多，测试只覆盖本组件读取的字段
}

describe("SessionStatusBar", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });
  after(() => { for (const r of mountedRoots.splice(0)) r.unmount(); });

  async function render(props: Record<string, unknown>) {
    const [{ act }, { createRoot }, { SessionStatusBar }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-statusbar"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <SessionStatusBar {...(props as Parameters<typeof SessionStatusBar>[0])} />,
      );
    });
    return container;
  }

  it("计划/改动/花费三分段都渲染", async () => {
    const container = await render({
      latestTodos: [
        { id: "1", content: "定位问题", status: "completed" },
        { id: "2", content: "修复逻辑", status: "in_progress" },
      ],
      fileChanges: [{ path: "a.ts", added: 12, removed: 4 }],
      selected: makeSummary(),
      onOpen: () => undefined,
    });
    const text = container.textContent ?? "";
    assert.ok(text.includes("1/2"), "应显示计划进度");
    assert.ok(text.includes("1 文件"), "应显示文件数");
    assert.ok(text.includes("+12"), "应显示增行");
    assert.ok(text.includes("¥0.12"), "应显示费用");
  });

  it("无数据时整条不渲染", async () => {
    const container = await render({
      latestTodos: [], fileChanges: [],
      selected: makeSummary({ totalCostCny: 0, status: "idle" }),
      onOpen: () => undefined,
    });
    assert.equal(container.querySelector(".statusbar"), null);
  });

  it("点击状态条触发 onOpen", async () => {
    let opened = 0;
    const container = await render({
      latestTodos: [{ id: "1", content: "x", status: "in_progress" }],
      fileChanges: [], selected: makeSummary({ totalCostCny: 0 }),
      onOpen: () => { opened += 1; },
    });
    const bar = container.querySelector(".statusbar") as HTMLElement;
    const { act } = await import("react");
    await act(async () => { bar.click(); });
    assert.equal(opened, 1);
  });
});
