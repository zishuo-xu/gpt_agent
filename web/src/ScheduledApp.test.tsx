import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * ScheduledApp（定时任务面板）行为测试（happy-dom 轻量 DOM 渲染）：
 * - 渲染：项目下拉 + 空态
 * - 注册：输入命令 → 提交 → POST 落库 → 列表出现新任务
 * - 删除：确认框 → DELETE → 列表移除
 * 依赖 fetch 均在注册 DOM 全局后动态加载。
 * 组件自带 30s 自动刷新 interval，root 统一在 after 钩子卸载，
 * 否则 happy-dom 的定时器会让测试进程无法退出。
 */

type FetchHandler = (init?: RequestInit) => unknown;

function stubFetch(routes: Record<string, FetchHandler>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const body = handler(init);
        return {
          ok: true,
          status: 200,
          json: async () => body,
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

/** 所有已挂载 root 的卸载队列：断言失败也要保证 interval 清理，进程才能退出 */
const mountedRoots: Array<{
  unmount: () => void;
}> = [];

describe("ScheduledApp（定时任务面板）", () => {
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
    const [{ act }, { createRoot }, { ScheduledApp }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./ScheduledApp"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<ScheduledApp />);
    });
    // 排空 mount 后的异步加载（/api/projects → /api/scheduled）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    return { container, root, act };
  }

  function typeInto(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("渲染项目下拉与空态提示", async () => {
    const fetch = stubFetch({
      "/api/projects": () => ({ projects: PROJECTS }),
      "/api/scheduled?project=proj-a": () => ({ tasks: [] }),
    });
    const { container } = await setup();
    assert.ok(container.textContent?.includes("项目A"));
    assert.ok(
      container.textContent?.includes("当前项目暂无定时任务"),
    );
    fetch.restore();
  });

  it("注册任务：提交命令 → POST → 列表出现新任务", async () => {
    const fetch = stubFetch({
      "/api/projects": () => ({ projects: PROJECTS }),
      "/api/scheduled?project=proj-a": (init) =>
        init?.method === "POST"
          ? {
              task: {
                id: "newtask",
                command: "/run 巡检 --permission normal",
                at: "2026-08-10T01:00:00.000Z",
                everyMinutes: 60,
                createdAt: "2026-08-09T00:00:00.000Z",
                options: {
                  description: "巡检",
                  hardRules: [],
                  semanticBounds: [],
                },
              },
            }
          : { tasks: [] },
    });
    const { container, act } = await setup();

    const input = container.querySelector(
      "input.scheduler-input",
    ) as HTMLInputElement | null;
    assert.ok(input);
    typeInto(input, "/run 巡检 --every 60 --permission normal");
    const submit = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("注册定时任务"));
    assert.ok(submit);
    await act(async () => {
      submit.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const post = fetch.calls.find((call) => call.init?.method === "POST");
    assert.ok(post, "应发起 POST 注册请求");
    assert.ok(post.url.includes("/api/scheduled?project=proj-a"));
    const body = JSON.parse(String(post.init?.body)) as { command: string };
    assert.equal(body.command, "/run 巡检 --every 60 --permission normal");
    assert.ok(container.textContent?.includes("/run 巡检 --permission normal"));
    assert.ok(container.textContent?.includes("每 60 分钟"));
    fetch.restore();
  });

  it("删除任务：确认后发起 DELETE 并移除列表项", async () => {
    (globalThis as { confirm?: unknown }).confirm = () => true;
    const fetch = stubFetch({
      "/api/projects": () => ({ projects: PROJECTS }),
      "/api/scheduled?project=proj-a": () => ({
        tasks: [
          {
            id: "t1",
            command: "/run 巡检",
            at: "2026-08-10T01:00:00.000Z",
            createdAt: "2026-08-09T00:00:00.000Z",
            options: { description: "巡检", hardRules: [], semanticBounds: [] },
          },
        ],
      }),
      "/api/scheduled/t1?project=": () => ({ removed: true }),
    });
    const { container, act } = await setup();

    assert.ok(container.textContent?.includes("/run 巡检"));
    const remove = container.querySelector("button.scheduler-remove") as
      | HTMLButtonElement
      | null;
    assert.ok(remove);
    await act(async () => {
      remove.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const del = fetch.calls.find((call) => call.init?.method === "DELETE");
    assert.ok(del, "应发起 DELETE 请求");
    assert.ok(del.url.includes("/api/scheduled/t1"));
    assert.ok(container.textContent?.includes("当前项目暂无定时任务"));
    fetch.restore();
  });
});
