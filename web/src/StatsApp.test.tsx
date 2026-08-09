import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * StatsApp（任务统计面板）行为测试（happy-dom 轻量 DOM 渲染）：
 * - 渲染：总量卡数值 / 图表列数 / 明细表行数
 * - run 会话行有「查看」按钮，交互会话显示「—」
 * - 点「查看」→ 拉取收尾总结 → 模态渲染；关闭后移除
 * 依赖 fetch 均在注册 DOM 全局后动态加载。
 */

type FetchHandler = (init?: RequestInit) => unknown;

function stubFetch(routes: Record<string, FetchHandler>) {
  const calls: Array<{ url: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => handler(init),
        } as unknown as Response;
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const PROJECTS = [{ key: "proj-a", name: "项目A" }];

function makeSummary(
  id: string,
  title: string,
  kind: "run" | "interactive",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    status: "done",
    permissionMode: "normal",
    createdAt: "2026-08-09T02:00:00.000Z",
    updatedAt: "2026-08-09T03:00:00.000Z",
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCachedTokens: 0,
    totalCostCny: 0.42,
    totalMissedTokens: 0,
    totalMissedCostCny: 0,
    todos: [],
    toolCallCount: 5,
    kind,
    ...overrides,
  };
}

const STATS = {
  totals: {
    sessions: 2,
    running: 0,
    completed: 2,
    failed: 0,
    interrupted: 0,
    tokens: 2000,
    costCny: 0.84,
    runSessions: 1,
  },
  byDay: [
    { day: "2026-08-08", sessions: 1, completed: 1, failed: 0, tokens: 500, costCny: 0.1 },
    { day: "2026-08-09", sessions: 1, completed: 1, failed: 0, tokens: 1500, costCny: 0.74 },
  ],
  sessions: [
    makeSummary("s-run", "巡检任务", "run"),
    makeSummary("s-chat", "普通对话", "interactive"),
  ],
};

const mountedRoots: Array<{ unmount: () => void }> = [];

describe("StatsApp（任务统计面板）", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount();
    }
  });

  async function setup(routes: Record<string, FetchHandler>) {
    const [{ act }, { createRoot }, { StatsApp }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./StatsApp"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<StatsApp />);
    });
    // 排空 mount 后的异步加载（/api/projects → /api/stats）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    return { container, act };
  }

  function baseRoutes(): Record<string, FetchHandler> {
    return {
      "/api/projects": () => ({ projects: PROJECTS }),
      "/api/stats?project=proj-a": () => STATS,
    };
  }

  it("渲染总量卡、图表列与会话明细行", async () => {
    const fetch = stubFetch(baseRoutes());
    const { container } = await setup(baseRoutes());
    const text = container.textContent ?? "";
    // 总量卡
    assert.match(text, /会话总数/);
    assert.match(text, /2/);
    assert.match(text, /¥0\.84/);
    // 图表列数（每列一个标签 MM-DD）
    assert.equal(container.querySelectorAll(".stats-chart-col").length, 2);
    // 明细表：2 行数据 + 表头
    assert.equal(container.querySelectorAll(".stats-table tbody tr").length, 2);
    // 类型标识
    assert.match(text, /无人值守/);
    assert.match(text, /交互/);
    fetch.restore();
  });

  it("run 会话行有「查看」，交互会话行显示「—」", async () => {
    const fetch = stubFetch(baseRoutes());
    const { container } = await setup(baseRoutes());
    const runRow = Array.from(
      container.querySelectorAll(".stats-table tbody tr"),
    ).find((row) => row.textContent?.includes("巡检任务"));
    const chatRow = Array.from(
      container.querySelectorAll(".stats-table tbody tr"),
    ).find((row) => row.textContent?.includes("普通对话"));
    assert.ok(runRow?.textContent?.includes("查看"));
    assert.ok(chatRow?.textContent?.includes("—"));
    assert.ok(!chatRow?.textContent?.includes("查看"));
    fetch.restore();
  });

  it("点「查看」→ 模态展示收尾总结与 todo 快照，可关闭", async () => {
    const fetch = stubFetch({
      ...baseRoutes(),
      "/api/sessions/s-run/summary?project=proj-a": () => ({
        run: {
          taskId: "task-1",
          description: "巡检任务",
          status: "completed",
          reason: "done",
          startedAt: "2026-08-09T02:00:00.000Z",
          finishedAt: "2026-08-09T03:00:00.000Z",
          durationMs: 3600_000,
          summary: "全部检查通过，改动见上。",
          todos: [
            { id: "a", text: "跑测试", status: "done" },
            { id: "b", text: "写收尾", status: "done" },
          ],
        },
        totals: { totalCostCny: 0.42, totalInputTokens: 1000, totalOutputTokens: 500, status: "done" },
      }),
    });
    const { container, act } = await setup({
      ...baseRoutes(),
      "/api/sessions/s-run/summary?project=proj-a": () => ({
        run: {
          taskId: "task-1",
          description: "巡检任务",
          status: "completed",
          reason: "done",
          startedAt: "2026-08-09T02:00:00.000Z",
          finishedAt: "2026-08-09T03:00:00.000Z",
          durationMs: 3600_000,
          summary: "全部检查通过，改动见上。",
          todos: [
            { id: "a", text: "跑测试", status: "done" },
            { id: "b", text: "写收尾", status: "done" },
          ],
        },
        totals: { totalCostCny: 0.42, totalInputTokens: 1000, totalOutputTokens: 500, status: "done" },
      }),
    });

    const runRow = Array.from(
      container.querySelectorAll(".stats-table tbody tr"),
    ).find((row) => row.textContent?.includes("巡检任务"));
    const viewButton = runRow?.querySelector(
      "button.stats-summary-button",
    ) as HTMLButtonElement | null;
    assert.ok(viewButton);
    await act(async () => {
      viewButton.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const modal = container.querySelector(".stats-modal");
    assert.ok(modal, "应弹出收尾总结模态");
    const modalText = modal.textContent ?? "";
    assert.match(modalText, /全部检查通过，改动见上。/);
    assert.match(modalText, /跑测试/);
    assert.match(modalText, /已完成/);
    assert.match(modalText, /耗时 60 分钟/);

    // 关闭模态
    const close = modal.querySelector("button.stats-modal-close") as
      | HTMLButtonElement
      | null;
    assert.ok(close);
    await act(async () => {
      close.click();
    });
    assert.ok(!container.querySelector(".stats-modal"), "关闭后模态应移除");
    fetch.restore();
  });
});
