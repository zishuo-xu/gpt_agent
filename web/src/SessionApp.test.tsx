import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  buildDisplayItems,
  toolResultDiffText,
} from "./session-display";
import type { SessionEvent } from "./SessionApp";

/**
 * web/src 行为层测试：
 * - buildDisplayItems（会话回放的核心事件流转换）纯函数直测；
 * - SessionListSidebar（会话列表）用 happy-dom 轻量 DOM 渲染交互。
 * 渲染相关依赖在注册 DOM 全局后再动态加载，避免 react-dom 抢先初始化。
 */

const ts = "2026-08-01T10:00:00.000Z";

function ev(seq: number, event: Record<string, unknown> & { type: string }): SessionEvent {
  return { seq, ts, event } as SessionEvent;
}

/**
 * 模拟真实用户输入：经原型 setter 写值（绕过 React 19 实例级 value 追踪器——
 * 直接赋值会同步 tracker，导致 onChange 的 change-detection 判定无变化），
 * 再派发 input 事件触发 React 合成 onChange。
 */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("toolResultDiffText（P0-3 diff 渲染取数）", () => {
  it("优先取 details.diff，其次回退 output", () => {
    assert.equal(
      toolResultDiffText({ output: "旧输出", details: { diff: "新 diff" } }),
      "新 diff",
    );
    assert.equal(toolResultDiffText({ output: "旧 trace 输出" }), "旧 trace 输出");
    assert.equal(toolResultDiffText({ details: { diff: 42 } }), undefined);
    assert.equal(toolResultDiffText(undefined), undefined);
    assert.equal(toolResultDiffText({}), undefined);
  });
});

describe("buildDisplayItems（会话回放事件流转换）", () => {
  it("用户消息渲染为 user message，带 queueId 的 user 事件不单独展示", () => {
    const items = buildDisplayItems([
      ev(1, { type: "user", text: "你好" }),
      ev(2, { type: "user", text: "排队消息", queueId: "q1" }),
    ]);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      kind: "message",
      seq: 1,
      ts,
      author: "user",
      text: "你好",
    });
  });

  it("连续的 text_delta 合并为一条 assistant 消息", () => {
    const items = buildDisplayItems([
      ev(1, { type: "text_delta", text: "Hel" }),
      ev(2, { type: "text_delta", text: "lo " }),
      ev(3, { type: "text_delta", text: "世界" }),
      ev(4, { type: "user", text: "下一轮" }),
    ]);
    assert.equal(items.length, 2);
    const message = items[0]!;
    assert.equal(message.kind, "message");
    if (message.kind === "message") {
      assert.equal(message.author, "assistant");
      assert.equal(message.text, "Hello 世界");
      assert.equal(message.seq, 1);
    }
  });

  it("tool_call 与后续 tool_result 按 callId 配对", () => {
    const result = { type: "tool_result", callId: "c1", summary: "done" };
    const items = buildDisplayItems([
      ev(1, { type: "tool_call", call: { id: "c1", tool: "Read", target: "a.ts" } }),
      ev(2, result),
    ]);
    assert.equal(items.length, 1);
    const tool = items[0]!;
    assert.equal(tool.kind, "tool");
    if (tool.kind === "tool") {
      assert.equal(tool.call.id, "c1");
      assert.deepEqual(tool.result, result);
    }
  });

  it("尚无 tool_result 的 tool_call 保持运行中状态（result 为 undefined）", () => {
    const items = buildDisplayItems([
      ev(1, { type: "tool_call", call: { id: "c1", tool: "Bash", target: "ls" } }),
    ]);
    const tool = items[0]!;
    assert.equal(tool.kind, "tool");
    if (tool.kind === "tool") {
      assert.equal(tool.result, undefined);
    }
  });

  it("ask_permission 在对应结果事件出现后标记为已解决，permission_denied 也计入配对", () => {
    const items = buildDisplayItems([
      ev(1, {
        type: "ask_permission",
        call: { id: "c1", tool: "Bash", target: "rm x" },
        risk: "删除文件",
      }),
      ev(2, {
        type: "ask_permission",
        call: { id: "c2", tool: "Bash", target: "mv y" },
        risk: "移动文件",
      }),
      ev(3, { type: "tool_result", callId: "c1", summary: "ok" }),
      ev(4, {
        type: "permission_denied",
        call: { id: "c2", tool: "Bash", target: "mv y" },
      }),
    ]);
    const approvals = items.filter((item) => item.kind === "approval");
    assert.equal(approvals.length, 2);
    if (approvals[0]?.kind === "approval") {
      assert.equal(approvals[0].resolvedByEvent, true);
    }
    if (approvals[1]?.kind === "approval") {
      assert.equal(approvals[1].resolvedByEvent, true);
    }
  });

  it("user_queued 消息根据同 queueId 的 user 事件判定是否已开始处理", () => {
    const items = buildDisplayItems([
      ev(1, { type: "user_queued", text: "先排队", queueId: "q1" }),
      ev(2, { type: "user_queued", text: "还在排队", queueId: "q2" }),
      ev(3, { type: "user", text: "已开始", queueId: "q1" }),
    ]);
    assert.equal(items.length, 2);
    const [started, waiting] = items;
    assert.equal(started?.kind, "message");
    if (started?.kind === "message") {
      assert.equal(started.queued, true);
      assert.equal(started.started, true);
    }
    if (waiting?.kind === "message") {
      assert.equal(waiting.queued, true);
      assert.equal(waiting.started, false);
    }
  });

  it("user_queued 带 steer 标记的消息保留 steer 标志供 UI 展示", () => {
    const items = buildDisplayItems([
      ev(1, {
        type: "user_queued",
        text: "改主意了",
        queueId: "q1",
        steer: true,
      }),
      ev(2, { type: "user_queued", text: "普通排队", queueId: "q2" }),
    ]);
    assert.equal(items.length, 2);
    const [steered, normal] = items;
    if (steered?.kind === "message") {
      assert.equal(steered.steer, true);
      assert.equal(steered.queued, true);
    }
    if (normal?.kind === "message") {
      assert.equal(normal.steer, false);
    }
  });

  it("task_start 与 task_end 按 taskId 配对为 subtask", () => {
    const end = { type: "task_end", taskId: "t1", status: "done" };
    const items = buildDisplayItems([
      ev(1, { type: "task_start", taskId: "t1", title: "子任务" }),
      ev(2, end),
    ]);
    assert.equal(items.length, 1);
    const subtask = items[0]!;
    assert.equal(subtask.kind, "subtask");
    if (subtask.kind === "subtask") {
      assert.deepEqual(subtask.end, end);
    }
  });

  it("系统事件转换为 system 条目（done / error / branch_switch / context_compacted / model_fallback）", () => {
    const items = buildDisplayItems([
      ev(1, { type: "done" }),
      ev(2, { type: "error", message: "超时" }),
      ev(3, { type: "branch_switch", branchId: 2, forkSeq: 5 }),
      ev(4, { type: "context_compacted", ratio: 0.35 }),
      ev(5, { type: "model_fallback", role: "main", from: "a", to: "b" }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["system", "system", "system", "system", "system"],
    );
    if (items[0]?.kind === "system") assert.equal(items[0].tone, "done");
    if (items[1]?.kind === "system") {
      assert.match(items[1].text, /超时/);
      assert.equal(items[1].tone, "error");
    }
    if (items[2]?.kind === "system") assert.match(items[2].text, /#2/);
    if (items[3]?.kind === "system") assert.match(items[3].text, /35\.0%/);
    if (items[4]?.kind === "system") {
      assert.match(items[4].text, /a → b/);
      assert.equal(items[4].tone, "warning");
    }
  });

  it("回放裁剪：events.slice(0, cursor) 前缀流产生对应前缀的显示条目", () => {
    const events: SessionEvent[] = [
      ev(1, { type: "user", text: "开始" }),
      ev(2, { type: "text_delta", text: "回答" }),
      ev(3, { type: "tool_call", call: { id: "c1", tool: "Read", target: "x" } }),
      ev(4, { type: "tool_result", callId: "c1", summary: "ok" }),
    ];
    const full = buildDisplayItems(events);
    assert.equal(full.length, 3);

    // 回放游标停在 tool_result 之前：工具卡应处于运行中
    const mid = buildDisplayItems(events.slice(0, 3));
    assert.equal(mid.length, 3);
    const tool = mid[2]!;
    assert.equal(tool.kind, "tool");
    if (tool.kind === "tool") assert.equal(tool.result, undefined);

    // 回放游标为 1：只剩首条用户消息
    const head = buildDisplayItems(events.slice(0, 1));
    assert.equal(head.length, 1);
    assert.equal(head[0]?.kind, "message");
  });

  it("空事件流返回空列表", () => {
    assert.deepEqual(buildDisplayItems([]), []);
  });
});

describe("SessionListSidebar（会话列表交互）", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  async function setup(props: {
    sessions: Array<Record<string, unknown>>;
    selectedId: string;
  }) {
    const [{ act }, { createRoot }, { SessionListSidebar }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./SessionApp"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const calls = { select: [] as string[], create: 0 };
    await act(async () => {
      root.render(
        <SessionListSidebar
          sessions={props.sessions as never}
          selectedId={props.selectedId}
          onSelect={(id) => calls.select.push(id)}
          onNew={() => {
            calls.create += 1;
          }}
        />,
      );
    });
    return { container, root, act, calls };
  }

  function makeSession(id: string, title: string, firstMessage?: string): Record<string, unknown> {
    return {
      id,
      title,
      status: "running",
      permissionMode: "normal",
      createdAt: ts,
      updatedAt: ts,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostCny: 0,
      todos: [],
      toolCallCount: 0,
      kind: "interactive",
      ...(firstMessage ? { firstMessage } : {}),
    };
  }

  it("渲染全部会话，选中项带 active 样式", async () => {
    const { container, root, act } = await setup({
      sessions: [makeSession("s1", "第一个会话"), makeSession("s2", "第二个会话")],
      selectedId: "s2",
    });
    const buttons = Array.from(container.querySelectorAll("button.sidebar-session"));
    assert.equal(buttons.length, 2);
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ["第一个会话", "第二个会话"],
    );
    assert.equal(buttons[0]!.classList.contains("active"), false);
    assert.equal(buttons[1]!.classList.contains("active"), true);
    await act(async () => root.unmount());
  });

  it("点击会话触发 onSelect 并传入该会话 id", async () => {
    const { container, root, act, calls } = await setup({
      sessions: [makeSession("s1", "甲"), makeSession("s2", "乙")],
      selectedId: "s1",
    });
    const target = Array.from(container.querySelectorAll("button.sidebar-session")).find(
      (button) => button.textContent === "乙",
    );
    assert.ok(target, "应找到标题为「乙」的会话按钮");
    await act(async () => {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.deepEqual(calls.select, ["s2"]);
    await act(async () => root.unmount());
  });

  it("点击「新会话」触发 onNew", async () => {
    const { container, root, act, calls } = await setup({
      sessions: [makeSession("s1", "会话")],
      selectedId: "s1",
    });
    const newButton = container.querySelector("button.sidebar-new");
    assert.ok(newButton, "应存在新会话按钮");
    await act(async () => {
      newButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.equal(calls.create, 1);
    await act(async () => root.unmount());
  });

  it("无会话时展示空状态提示", async () => {
    const { container, root, act } = await setup({ sessions: [], selectedId: "" });
    assert.equal(container.querySelector("button.sidebar-session"), null);
    assert.match(container.querySelector(".sidebar-empty")?.textContent ?? "", /还没有会话/);
    await act(async () => root.unmount());
  });

  it("按标题或首条消息过滤会话，无匹配时提示", async () => {
    const s1 = makeSession("s1", "缓存优化", "修复登录超时问题");
    const s2 = makeSession("s2", "权限修复");
    const { container, root, act } = await setup({
      sessions: [s1, s2],
      selectedId: "",
    });
    const input = container.querySelector(
      "input.sidebar-search",
    ) as HTMLInputElement;
    assert.ok(input, "应渲染搜索框");

    await act(async () => {
      typeInto(input, "缓存");
    });
    let buttons = Array.from(
      container.querySelectorAll("button.sidebar-session"),
    );
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]?.textContent, "缓存优化");

    // firstMessage 匹配
    await act(async () => {
      typeInto(input, "登录超时");
    });
    buttons = Array.from(
      container.querySelectorAll("button.sidebar-session"),
    );
    assert.equal(buttons.length, 1, "应命中 firstMessage 匹配的会话");
    assert.equal(buttons[0]?.textContent, "缓存优化");

    // 无匹配提示
    await act(async () => {
      typeInto(input, "不存在的关键词");
    });
    assert.match(
      container.querySelector(".sidebar-empty")?.textContent ?? "",
      /无匹配/,
    );
    await act(async () => root.unmount());
  });

  it("清空搜索词恢复完整列表", async () => {
    const { container, root, act } = await setup({
      sessions: [makeSession("s1", "甲"), makeSession("s2", "乙")],
      selectedId: "",
    });
    const input = container.querySelector(
      "input.sidebar-search",
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(input, "甲");
    });
    assert.equal(
      container.querySelectorAll("button.sidebar-session").length,
      1,
    );
    await act(async () => {
      typeInto(input, "");
    });
    assert.equal(
      container.querySelectorAll("button.sidebar-session").length,
      2,
      "清空搜索后应恢复全部会话",
    );
    await act(async () => root.unmount());
  });
});


describe("ProjectPicker（打开其他项目选择器）", () => {
  before(() => {
    // 同文件其他 describe 可能已注册（全局单例），幂等处理
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  async function setup(props: {
    roots?: Array<{ name: string; path: string }>;
    path?: string;
    entries?: Array<{ name: string; path: string; isDirectory: boolean }>;
    error?: string;
    opening?: boolean;
  }) {
    const [{ act }, { createRoot }, { ProjectPicker }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./ProjectPicker"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const calls = { navigate: [] as string[], open: 0, close: 0 };
    await act(async () => {
      root.render(
        <ProjectPicker
          roots={
            props.roots ?? [
              { name: "/Users/x", path: "/Users/x" },
              { name: "/tmp", path: "/tmp" },
            ]
          }
          path={props.path ?? "/Users/x/proj"}
          entries={
            props.entries ?? [
              { name: "demo", path: "/Users/x/proj/demo", isDirectory: true },
            ]
          }
          error={props.error ?? ""}
          opening={props.opening ?? false}
          onNavigate={(dir) => calls.navigate.push(dir)}
          onOpen={() => {
            calls.open += 1;
          }}
          onClose={() => {
            calls.close += 1;
          }}
        />,
      );
    });
    return { container, root, act, calls };
  }

  it("渲染标题、根入口、面包屑、目录列表与打开按钮", async () => {
    const { container, root, act } = await setup({});
    assert.ok(container.querySelector("h2")?.textContent?.includes("打开其他项目"));
    const crumbs = container.querySelectorAll(".project-picker-breadcrumbs button");
    assert.equal(crumbs.length, 5, "两个根入口 + 三段路径面包屑（/Users/x/proj）");
    const entries = container.querySelectorAll(".project-picker-entry");
    assert.equal(entries.length, 1);
    assert.ok(entries[0]?.textContent?.includes("demo"));
    const openBtn = container.querySelector(".project-picker-open") as HTMLButtonElement;
    assert.equal(openBtn.textContent, "打开此目录");
    assert.equal(openBtn.disabled, false);
    await act(async () => root.unmount());
  });

  it("点击目录项与根入口触发 onNavigate", async () => {
    const { container, root, act, calls } = await setup({});
    await act(async () => {
      (container.querySelector(".project-picker-entry") as HTMLButtonElement).click();
    });
    assert.deepEqual(calls.navigate, ["/Users/x/proj/demo"]);
    await act(async () => {
      (container.querySelectorAll(".project-picker-breadcrumbs button")[0] as HTMLButtonElement).click();
    });
    assert.deepEqual(calls.navigate, ["/Users/x/proj/demo", "/Users/x"]);
    await act(async () => root.unmount());
  });

  it("点击「打开此目录」触发 onOpen；opening 时禁用并显示打开中", async () => {
    const { container, root, act, calls } = await setup({});
    await act(async () => {
      (container.querySelector(".project-picker-open") as HTMLButtonElement).click();
    });
    assert.equal(calls.open, 1);
    await act(async () => root.unmount());

    const { container: c2, root: r2, act: a2 } = await setup({ opening: true });
    const openBtn = c2.querySelector(".project-picker-open") as HTMLButtonElement;
    assert.equal(openBtn.disabled, true);
    assert.ok(openBtn.textContent?.includes("打开中"));
    await a2(async () => r2.unmount());
  });

  it("关闭按钮与遮罩点击触发 onClose", async () => {
    const { container, root, act, calls } = await setup({});
    await act(async () => {
      (container.querySelector(".project-picker-close") as HTMLButtonElement).click();
    });
    assert.equal(calls.close, 1);
    await act(async () => {
      (container.querySelector(".project-picker-overlay") as HTMLDivElement).click();
    });
    assert.equal(calls.close, 2);
    await act(async () => root.unmount());
  });

  it("错误信息与空目录提示渲染", async () => {
    const { container, root, act } = await setup({
      error: "无法读取目录列表",
      entries: [],
    });
    assert.ok(container.querySelector(".project-picker-error")?.textContent?.includes("无法读取目录列表"));
    assert.ok(container.querySelector(".project-picker-empty")?.textContent?.includes("没有可打开的子目录"));
    await act(async () => root.unmount());
  });
});

describe("TaskScopeTemplates（新建面板范围建议）", () => {
  before(() => {
    // 同文件其他 describe 可能已注册（全局单例），幂等处理
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("渲染 4 个模板按钮，点击填入对应模板文本", async () => {
    const [{ act }, { createRoot }, { TaskScopeTemplates, TASK_SCOPE_TEMPLATES }] =
      await Promise.all([
        import("react"),
        import("react-dom/client"),
        import("./SessionApp"),
      ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const picked: string[] = [];
    await act(async () => {
      root.render(
        <TaskScopeTemplates
          onPick={(text) => {
            picked.push(text);
          }}
        />,
      );
    });

    const buttons = Array.from(
      container.querySelectorAll("button.task-scope-button"),
    );
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      TASK_SCOPE_TEMPLATES.map((template) => template.label),
      "应渲染全部 4 个模板按钮",
    );
    assert.equal(
      container.querySelector(".task-scope-label")?.textContent,
      "范围建议（点击填入，可再编辑）",
    );

    // 模拟真实用户点击「修复缺陷」
    const target = buttons.find(
      (button) => button.textContent === "修复缺陷",
    );
    assert.ok(target, "应找到「修复缺陷」按钮");
    await act(async () => {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(
      picked,
      [
        "先运行相关测试复现失败（<测试文件>），定位并修复实现中的问题。只修改实现文件，不要修改测试文件。",
      ],
      "点击后应把模板文本交给上层填入输入框",
    );
    await act(async () => root.unmount());
  });
});

describe("ItemCard（subtask 卡片）", () => {
  before(() => {
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("reason=timeout 的子代理卡片显示超时标记与耗时", async () => {
    const [{ act }, { createRoot }, { ItemCard }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-render"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const item = {
      kind: "subtask",
      seq: 3,
      start: {
        type: "task_start",
        taskId: "t1",
        description: "无界探索",
        ts: "2026-08-01T10:00:00.000Z",
      },
      end: {
        type: "task_end",
        taskId: "t1",
        status: "interrupted",
        reason: "timeout",
        toolCalls: 2,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 0,
        summary: "部分结论：文件在 src/a.ts",
        ts: "2026-08-01T10:15:00.000Z",
      },
    };
    await act(async () => {
      root.render(
        <ItemCard
          item={item as never}
          showCacheMissNotices={false}
          locallyResolved={new Set()}
          feedback=""
          onFeedback={() => {}}
          onPermission={async () => {}}
        />,
      );
    });

    const summary = container.querySelector(".subtask-card summary");
    assert.ok(summary, "应渲染子代理卡片");
    assert.match(String(summary?.textContent), /无界探索/);
    assert.match(String(summary?.textContent), /（超时）/);
    assert.match(String(summary?.textContent), /15\.0 分/);
    assert.match(String(summary?.textContent), /已中止/);
    assert.ok(
      container.querySelector(".subtask-body")?.textContent?.includes("src/a.ts"),
      "超时保留的部分结论应展示",
    );
    await act(async () => root.unmount());
  });
});
