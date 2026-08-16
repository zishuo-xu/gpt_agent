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
    costByModel: [],
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
  byModel: [
    { providerId: "opencode", model: "claude-sonnet", costCny: 0.6, tokens: 1500 },
    { providerId: "opencode", model: "deepseek", costCny: 0.24, tokens: 500 },
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

  async function setup() {
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
    const { container } = await setup();
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

  it("渲染按模型成本维度表（费用占比条 + tokens）", async () => {
    const fetch = stubFetch(baseRoutes());
    const { container } = await setup();
    const text = container.textContent ?? "";
    assert.match(text, /按模型成本/);
    assert.equal(container.querySelectorAll(".stats-model-row").length, 2);
    assert.match(text, /claude-sonnet/);
    assert.match(text, /deepseek/);
    assert.match(text, /¥0\.6/);
    fetch.restore();
  });

  it("run 会话行有「查看」，交互会话行显示「—」", async () => {
    const fetch = stubFetch(baseRoutes());
    const { container } = await setup();
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
    const { container, act } = await setup();

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

  it("收尾总结空态：API 无 run 数据时显示提示文案（不渲染总结内容）", async () => {
    const fetch = stubFetch({
      ...baseRoutes(),
      "/api/sessions/s-run/summary?project=proj-a": () => ({
        // 无 run 字段（run 事件不完整或中断于进程崩溃）
        totals: {
          totalCostCny: 0.42,
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          status: "done",
        },
      }),
    });
    const { container, act } = await setup();

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
    assert.match(modalText, /该会话没有可展示的收尾总结/);
    assert.doesNotMatch(modalText, /巡检任务：/);
    fetch.restore();
  });

  it("点「轨迹」→ 打开轨迹模态（aria-label 区分）并渲染事件", async () => {
    const fetch = stubFetch({
      ...baseRoutes(),
      "/api/sessions/s-run/events?project=proj-a": () => ({
        events: [
          {
            seq: 1,
            ts: "2026-08-14T10:00:00.000Z",
            event: { type: "user", text: "巡检一下" },
          },
          {
            seq: 2,
            ts: "2026-08-14T10:00:01.000Z",
            event: {
              type: "tool_call",
              call: { id: "c1", tool: "Glob", target: "**/*.ts", args: {} },
            },
          },
        ],
      }),
    });
    const { container, act } = await setup();

    const runRow = Array.from(
      container.querySelectorAll(".stats-table tbody tr"),
    ).find((row) => row.textContent?.includes("巡检任务"));
    const trajectoryButton = runRow?.querySelectorAll(
      "button.stats-summary-button",
    )[1] as HTMLButtonElement | null;
    assert.ok(trajectoryButton, "轨迹按钮存在");
    await act(async () => {
      trajectoryButton.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const trajectoryModal = container.querySelector(
      '.stats-modal[aria-label^="轨迹"]',
    );
    assert.ok(trajectoryModal, "应打开轨迹模态");
    const modalText = trajectoryModal.textContent ?? "";
    assert.match(modalText, /巡检一下/);
    assert.match(modalText, /Glob/);
    // 轨迹模态与收尾总结模态互斥（不同 aria-label）
    assert.ok(
      !container.querySelector('.stats-modal[aria-label="收尾总结"]'),
      "不应同时打开收尾总结模态",
    );
    fetch.restore();
  });

  it("默认项目取 defaultKey（服务器默认项目）而非大厅", async () => {
    window.localStorage.removeItem("stats.project");
    const requested: string[] = [];
    const fetch = stubFetch({
      "/api/projects": () => ({
        projects: [
          { key: "lobby", name: "大厅（不操作文件）", lobby: true },
          { key: "proj-a", name: "项目A" },
        ],
        defaultKey: "proj-a",
      }),
      "/api/stats?project=proj-a": () => {
        requested.push("proj-a");
        return { totals: {}, byDay: [], byModel: [], sessions: [] };
      },
      "/api/stats?project=lobby": () => {
        requested.push("lobby");
        return { totals: {}, byDay: [], byModel: [], sessions: [] };
      },
    });
    const { container } = await setup();
    assert.deepEqual(
      requested,
      ["proj-a"],
      "默认应请求 defaultKey 项目而非大厅（lobby 恒排列表第一）",
    );
    assert.ok(container.textContent?.includes("项目A"));
    fetch.restore();
  });
});
