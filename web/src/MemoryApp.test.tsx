import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * 记忆面板增强行为测试（happy-dom 轻量 DOM）：
 * - 时间线条目：有 historyPath → 「查看改动」展开 diff；无 → 上线前提示
 * - 「打开会话」→ 跳转 #sessions/<id>
 * fetch 经全局 stub（/api/memory + /api/memory/history）。
 */

const ts = "2026-08-10T10:00:00.000Z";

const TIMELINE_PAYLOAD = {
  documents: [
    {
      id: "preferences",
      label: "preferences（全局）",
      scope: "global",
      path: "/home/.myagent/MEMORY.md",
      content: "",
    },
    {
      id: "pitfalls",
      label: "project / pitfalls",
      scope: "project",
      path: "/proj/.myagent/memory/pitfalls.md",
      content: "after line\n",
    },
  ],
  timeline: [
    {
      ts,
      sessionId: "s1",
      sessionTitle: "写记忆会话",
      documentId: "preferences",
      summary: "已替换 1 块",
      historyPath: "/proj/.myagent/memory/.history/pitfalls-20260810-120000-000-abcd.md",
    },
    {
      ts,
      sessionId: "s2",
      sessionTitle: "旧会话",
      documentId: "preferences",
      summary: "已替换 1 块",
    },
  ],
};

function stubFetch(history: Record<string, unknown>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    url: RequestInfo | URL,
  ) => {
    const u = String(url);
    if (u.includes("/api/memory/history")) {
      return {
        ok: true,
        json: async () => history,
      } as never;
    }
    return { ok: true, json: async () => TIMELINE_PAYLOAD } as never;
  };
}

describe("记忆面板增强：时间线 diff 展开与会话跳转", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof import("react-dom/client").createRoot>;
  let act: typeof import("react").act;
  let createRoot: typeof import("react-dom/client").createRoot;
  let MemoryApp: typeof import("./MemoryApp").MemoryApp;

  before(async () => {
    GlobalRegistrator.register();
    stubFetch({ before: "before line\n", after: "after line\n", diff: "--- a\n-before line\n+after line\n" });
    const [{ act: a }, { createRoot: c }, { MemoryApp: M }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./MemoryApp"),
    ]);
    act = a;
    createRoot = c;
    MemoryApp = M;
  });

  after(() => {
    GlobalRegistrator.unregister();
  });

  async function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryApp />);
    });
  }

  it("有 historyPath 的条目显示「查看改动」并可展开 diff，无 historyPath 显示上线前提示", async () => {
    await render();
    const entries = Array.from(
      container.querySelectorAll(".timeline-entry"),
    );
    assert.equal(entries.length, 2);
    // 第一条（s1）：有留档 → 查看改动按钮
    const firstActions = entries[0]!.querySelectorAll(".timeline-actions button");
    assert.equal(firstActions.length, 2);
    // 第二条（s2）：无留档 → 上线前提示
    const hint = entries[1]!.querySelector(".timeline-hint");
    assert.ok(hint, "无留档条目应有上线前提示");
    assert.match(hint!.textContent ?? "", /上线前/);

    // 展开 diff
    const viewButton = Array.from(
      entries[0]!.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("查看改动"));
    assert.ok(viewButton, "查看改动按钮存在");
    await act(async () => {
      viewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const diffText = container.textContent ?? "";
    assert.match(diffText, /before line/);
    assert.match(diffText, /after line/);
  });

  it("「打开会话」跳转 #sessions/<id>", async () => {
    await render();
    const entries = Array.from(
      container.querySelectorAll(".timeline-entry"),
    );
    const openButton = Array.from(
      entries[0]!.querySelectorAll("button"),
    ).find((button) => button.textContent?.includes("打开会话"));
    assert.ok(openButton, "打开会话按钮存在");
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(window.location.hash, "#sessions/s1");
  });

  it("预览/编辑切换：预览渲染 markdown 且不丢草稿", async () => {
    await render();
    // 找到编辑器 textarea 并输入 markdown 内容
    const textarea = container.querySelector(".memory-textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(textarea, "## 标题\n\n- 列表项\n```ts\nconst a = 1;\n```");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    // 切到预览
    const previewButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "预览");
    assert.ok(previewButton, "预览按钮存在");
    await act(async () => {
      previewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.ok(
      container.querySelector(".memory-preview"),
      "预览容器渲染",
    );
    const previewText = container.querySelector(".memory-preview")?.textContent ?? "";
    assert.match(previewText, /标题/);
    assert.match(previewText, /列表项/);
    assert.ok(
      container.querySelector(".memory-preview pre.code-block"),
      "预览中代码块渲染",
    );
    // 切回编辑：草稿不丢
    const editButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent?.trim() === "编辑");
    assert.ok(editButton, "切回编辑按钮存在");
    await act(async () => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.ok(container.querySelector(".memory-textarea"), "编辑器恢复");
    assert.equal(
      (container.querySelector(".memory-textarea") as HTMLTextAreaElement).value,
      "## 标题\n\n- 列表项\n```ts\nconst a = 1;\n```",
    );
  });
});
