import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * RichText（助手消息 markdown 轻量渲染）测试：
 * 标题 / 无序有序列表 / 引用 / 分隔线 / 行内 code / 粗体 / 链接（含危险协议拦截）。
 */

const mountedRoots: Array<{ unmount: () => void }> = [];

describe("RichText（markdown 渲染）", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount();
    }
  });

  async function render(text: string) {
    const [{ act }, { createRoot }, { RichText }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-rich-text"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<RichText text={text} />);
    });
    return container;
  }

  it("## 标题渲染为 h2（不再原样显示 # 前缀）", async () => {
    const container = await render("## 🛠 代码相关\n\n普通段落");
    const headings = container.querySelectorAll(".rich-text h2");
    assert.equal(headings.length, 1);
    assert.equal(headings[0]?.textContent, "🛠 代码相关");
    assert.ok(container.querySelector(".rich-text p"));
    assert.ok(
      !container.textContent?.includes("##"),
      "标题行不应残留 ## 前缀",
    );
  });

  it("无序/有序列表与引用、分隔线", async () => {
    const container = await render(
      [
        "- 第一项",
        "- 第二项",
        "1. 步骤一",
        "2. 步骤二",
        "> 引用文本",
        "---",
      ].join("\n"),
    );
    const text = container.textContent ?? "";
    assert.match(text, /• 第一项/);
    assert.match(text, /• 第二项/);
    assert.match(text, /1\. 步骤一/);
    assert.match(text, /2\. 步骤二/);
    assert.equal(container.querySelectorAll(".rich-text blockquote").length, 1);
    assert.equal(container.querySelectorAll(".rich-text hr").length, 1);
    assert.equal(container.querySelectorAll(".rich-text blockquote")[0]?.textContent, "引用文本");
  });

  it("行内 code / 粗体 / 链接（危险协议不放行）", async () => {
    const container = await render(
      "用 `pnpm test` 跑测试，**务必**通过。链接 [GitHub](https://github.com) 与 [危险](javascript:alert(1))",
    );
    assert.ok(container.querySelector(".rich-text code"));
    assert.equal(container.querySelector(".rich-text code")?.textContent, "pnpm test");
    assert.ok(container.querySelector(".rich-text strong"));
    assert.equal(container.querySelector(".rich-text strong")?.textContent, "务必");
    const links = container.querySelectorAll(".rich-text a");
    assert.equal(links.length, 1, "javascript: 链接不应渲染为可点击 a");
    assert.equal(links[0]?.getAttribute("href"), "https://github.com");
    assert.equal(links[0]?.textContent, "GitHub");
  });

  it("fenced code block 渲染为 pre.code-block（语言标记 + 多行 + 空行保留 + 后续内容不吞）", async () => {
    const container = await render(
      "说明：\n```ts\nconst a = 1;\n\nconsole.log(a);\n```\n之后正常段落",
    );
    const pre = container.querySelector(".rich-text pre.code-block");
    assert.ok(pre, "代码块应渲染为 pre.code-block");
    assert.equal(pre!.getAttribute("data-lang"), "ts");
    assert.match(pre!.textContent ?? "", /const a = 1/);
    assert.match(pre!.textContent ?? "", /console\.log\(a\)/);
    // 代码块之后的内容正常渲染（未吞掉后续行）
    assert.match(container.textContent ?? "", /之后正常段落/);
  });
});

describe("ItemCard（会话展示组件全分支）", () => {
  async function renderItem(item: never, extra: Record<string, unknown> = {}) {
    const [{ act }, { createRoot }, { ItemCard }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-render"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <ItemCard
          item={item}
          showCacheMissNotices={false}
          locallyResolved={new Set()}
          feedback=""
          onFeedback={() => undefined}
          onPermission={async () => undefined}
          {...extra}
        />,
      );
    });
    return container;
  }

  const ts = "2026-08-09T10:00:00.000Z";
  function messageItem(author: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) {
    return { kind: "message", seq: 1, ts, author, text, ...extra } as never;
  }

  it("user / assistant 消息与排队标记", async () => {
    const user = await renderItem(messageItem("user", "你好"));
    assert.ok(user.querySelector(".user-message"));
    assert.ok(user.textContent?.includes("你好"));
    const assistant = await renderItem(
      messageItem("assistant", "## 标题\n- 列表项"),
    );
    assert.ok(assistant.querySelector(".assistant-message"));
    assert.ok(assistant.querySelector(".rich-text h2"));
    const queued = await renderItem(
      messageItem("user", "排队中", { queued: true, started: false, steer: false }),
    );
    assert.ok(queued.querySelector(".queued-message"));
    assert.match(queued.textContent ?? "", /已排队/);
  });

  it("tool 卡四态：运行中 / 完成（details 网格 + diff）/ 失败 / 拒绝", async () => {
    const toolCall = { id: "c1", tool: "Bash", target: "pnpm test", args: {} };
    const running = await renderItem({
      kind: "tool",
      seq: 2,
      ts,
      call: toolCall,
      result: undefined,
    } as never);
    assert.ok(running.querySelector(".tool-running"));
    assert.match(running.textContent ?? "", /运行中/);

    const done = await renderItem({
      kind: "tool",
      seq: 2,
      ts,
      call: toolCall,
      result: {
        summary: "全部通过",
        details: {
          code: 0,
          durationMs: 1234,
          diff: "diff --git a/x b/x\n+新行",
          nested: { a: 1 },
        },
      },
    } as never);
    assert.ok(done.querySelector(".tool-ok"));
    assert.match(done.textContent ?? "", /全部通过/);
    assert.ok(done.querySelector(".diff-output"), "details.diff 应渲染为 diff 块");
    assert.match(done.textContent ?? "", /新行/);
    assert.ok(done.textContent?.includes("durationMs"), "耗时字段应展示");

    const failed = await renderItem({
      kind: "tool",
      seq: 2,
      ts,
      call: toolCall,
      result: { isError: true, summary: "退出码 1" },
    } as never);
    assert.ok(failed.querySelector(".tool-error"));
    assert.match(failed.textContent ?? "", /失败/);

    const denied = await renderItem({
      kind: "tool",
      seq: 2,
      ts,
      call: toolCall,
      result: { type: "permission_denied", summary: "命中 deny 规则" },
    } as never);
    assert.ok(denied.querySelector(".tool-denied"));
    assert.match(denied.textContent ?? "", /已拒绝/);
  });

  it("审批卡：未决渲染操作按钮并可回调；已决展示处理标签", async () => {
    const calls: string[] = [];
    const container = await renderItem(
      {
        kind: "approval",
        seq: 3,
        ts,
        event: {
          call: { id: "c2", tool: "Write", target: "a.md" },
          risk: "将写入项目文件",
          detail: "内容预览",
        },
        resolvedByEvent: false,
      } as never,
      {
        onPermission: async (callId: string, granted: boolean) => {
          calls.push(`${callId}:${granted}`);
        },
      },
    );
    assert.ok(container.querySelector(".web-approval-card"));
    assert.match(container.textContent ?? "", /⚠ 审批请求/);
    const buttons = Array.from(container.querySelectorAll("button"));
    assert.ok(buttons.length >= 5, "未决审批应有 5 个操作按钮");
    await (buttons[0] as HTMLButtonElement).click();
    assert.deepEqual(calls, ["c2:true"]);

    const resolved = await renderItem({
      kind: "approval",
      seq: 3,
      ts,
      event: {
        call: { id: "c3", tool: "Bash", target: "rm -rf x" },
        risk: "危险操作",
      },
      resolvedByEvent: true,
      deniedReason: "用户拒绝：太危险",
    } as never);
    assert.match(resolved.textContent ?? "", /已拒绝：用户拒绝：太危险/);
    assert.equal(resolved.querySelectorAll(".approval-actions button").length, 0);
  });

  it("澄清卡显示推荐选项、支持显式回答并在回答后只读", async () => {
    const answers: string[] = [];
    const item = {
      kind: "clarification",
      seq: 30,
      ts,
      event: {
        type: "need_user",
        questionId: "q1",
        question: "旧 API 怎么处理？",
        context: "两种方案会影响兼容性。",
        options: [
          { id: "keep", label: "保持兼容", description: "保留旧入口" },
          { id: "break", label: "直接升级" },
        ],
        recommendedOptionId: "keep",
      },
    };
    const pending = await renderItem(item as never, {
      onClarification: async (_questionId: string, answer: string) => {
        answers.push(answer);
      },
    });
    assert.ok(pending.querySelector(".clarification-card"));
    assert.match(pending.textContent ?? "", /两种方案会影响兼容性/);
    assert.match(pending.querySelector("button.recommended")?.textContent ?? "", /推荐/);
    (pending.querySelector("button.recommended") as HTMLButtonElement).click();
    await Promise.resolve();
    assert.deepEqual(answers, ["保持兼容"]);

    const resolved = await renderItem(
      { ...item, resolvedAnswer: "保持兼容" } as never,
    );
    assert.match(resolved.textContent ?? "", /已回答/);
    assert.equal(resolved.querySelectorAll(".clarification-options button").length, 0);
  });

  it("thinking / system / cost / subtask 渲染", async () => {
    const thinking = await renderItem({
      kind: "thinking",
      seq: 4,
      text: "先分析再动手",
    } as never);
    assert.ok(thinking.querySelector(".web-thinking"));

    const system = await renderItem({
      kind: "system",
      seq: 5,
      text: "任务边界确认",
      tone: "warn",
    } as never);
    assert.ok(system.textContent?.includes("任务边界确认"));

    const cost = await renderItem({
      kind: "cost",
      seq: 6,
      event: { input: 1000, output: 200, totalTokens: 1200 },
    } as never);
    assert.ok(cost.textContent);

    const subtask = await renderItem({
      kind: "subtask",
      seq: 7,
      ts,
      start: { ts, description: "探索任务" },
      end: {
        ts: "2026-08-09T10:05:00.000Z",
        toolCalls: 5,
        inputTokens: 100,
        outputTokens: 20,
        status: "done",
        summary: "探索完成",
      },
    } as never);
    assert.ok(subtask.textContent?.includes("探索任务"));
    assert.ok(subtask.textContent?.includes("探索完成"));
  });

  it("账本卡：标题/计数/文件清单 + 各状态徽标", async () => {
    const ts2 = "2026-08-09T10:00:00.000Z";
    const container = await renderItem({
      kind: "ledger",
      seq: 8,
      ts: ts2,
      taskId: "run1",
      description: "重构 session.ts",
      units: [
        {
          id: "src/a.ts",
          kind: "file",
          label: "src/a.ts",
          status: "done",
          updatedAt: ts2,
        },
        {
          id: "src/b.ts",
          kind: "file",
          label: "src/b.ts",
          status: "in_progress",
          note: "待验证",
          updatedAt: ts2,
        },
        {
          id: "src/c.ts",
          kind: "task",
          label: "补充回归测试",
          status: "done",
          evidence: "pnpm test 通过",
          updatedAt: ts2,
        },
      ],
    } as never);
    assert.ok(container.querySelector(".ledger-card"), "账本卡应渲染");
    assert.ok(container.textContent?.includes("任务账本：重构 session.ts"));
    assert.match(container.textContent ?? "", /已完成 2\/3/);
    const statuses = Array.from(
      container.querySelectorAll(".ledger-status"),
    ).map((el) => el.textContent);
    assert.deepEqual(statuses, ["已修改", "进行中", "已完成"]);
    assert.ok(container.querySelector(".ledger-unit.ledger-done"));
    assert.ok(container.querySelector(".ledger-unit.ledger-in-progress"));
    assert.equal(container.querySelectorAll(".ledger-unit.ledger-done").length, 2);
    assert.match(container.textContent ?? "", /待验证/, "note 应展示");
    assert.match(container.textContent ?? "", /证据：pnpm test 通过/, "evidence 应展示");
  });

  it("账本卡：无记录时显示占位计数，空 units 不渲染清单", async () => {
    const container = await renderItem({
      kind: "ledger",
      seq: 9,
      ts,
      taskId: "run2",
      units: [],
    } as never);
    assert.ok(container.textContent?.includes("任务账本 #run2"));
    assert.match(container.textContent ?? "", /暂无记录/);
    assert.equal(container.querySelectorAll(".ledger-units li").length, 0);
  });

  it("StatusTag 与格式化纯函数", async () => {
    const [{ act }, { createRoot }, { StatusTag }, format] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-render"),
      import("./session-format"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(<StatusTag status="running" />);
    });
    assert.match(container.textContent ?? "", /运行中/);
    assert.equal(format.formatTokens(1234), "1.2k");
    assert.equal(format.formatTokens(2_500_000), "2.5m");
    assert.equal(format.formatTokens(999), "999");
    assert.equal(format.formatDuration(90_000), "1.5 分");
    assert.ok(format.formatTime("2026-08-09T10:00:00.000Z").length > 0);
  });
});



describe("SessionRail 任务清单（三态标记）", () => {
  it("completed 显示 ✓、in_progress 显示 →、pending 显示 ○", async () => {
    const [{ act }, { createRoot }, { SessionRail }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-rail"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const selected = {
      id: "s1",
      title: "会话",
      status: "running",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostCny: 0,
      todos: [],
      toolCallCount: 0,
      kind: "interactive",
    };
    const todos = [
      { id: "a", content: "完成项", status: "completed" },
      { id: "b", content: "进行中", status: "in_progress" },
      { id: "c", content: "待办项", status: "pending" },
    ];
    await act(async () => {
      root.render(
        <SessionRail
          latestTodos={todos as never}
          selected={selected as never}
          showDetail
        />,
      );
    });
    const checks = Array.from(container.querySelectorAll(".todo-check"));
    assert.deepEqual(
      checks.map((node) => node.textContent),
      ["✓", "→", "○"],
    );
    await act(async () => root.unmount());
  });

  it("status=done 且有未完成 todo 时警告已移出右栏（改由会话页内联展示）", async () => {
    const [{ act }, { createRoot }, { SessionRail }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-rail"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const selected = {
      id: "s1",
      title: "会话",
      status: "done",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostCny: 0,
      todos: [],
      toolCallCount: 5,
      kind: "interactive",
    };
    await act(async () => {
      root.render(
        <SessionRail
          latestTodos={[
            { id: "a", content: "写核心逻辑", status: "pending" },
          ] as never}
          selected={selected as never}
          showDetail
        />,
      );
    });
    // 矛盾警告改由 SessionApp 会话列内联渲染，右栏不再承担
    assert.equal(container.querySelector(".rail-todo-warning"), null);
    // 计划详情卡本身仍正常渲染
    assert.equal(container.querySelectorAll(".rail-plan-step").length, 1);
    await act(async () => root.unmount());
  });
});

describe("SessionRail 0 工具调用完成警告（已移出右栏）", () => {
  it("无人值守任务完成且未调用工具时右栏不再渲染警告", async () => {
    const [{ act }, { createRoot }, { SessionRail }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-rail"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const selected = {
      id: "s1",
      title: "会话",
      status: "done",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostCny: 0,
      todos: [],
      toolCallCount: 0,
      kind: "run",
    };
    await act(async () => {
      root.render(
        <SessionRail
          latestTodos={[]}
          selected={selected as never}
          showDetail
        />,
      );
    });
    const warning = container.querySelector(".rail-todo-warning");
    assert.equal(warning, null, "0 工具调用警告已移至会话列内联渲染，右栏不再显示");
    // 仅详情卡（消耗/会话）仍渲染
    assert.ok(container.querySelector(".session-rail"), "右栏本体仍渲染");
    await act(async () => root.unmount());
  });

  it("交互问答完成且未调用工具时不显示警告", async () => {
    const [{ act }, { createRoot }, { SessionRail }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-rail"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        <SessionRail
          latestTodos={[]}
          selected={{
            id: "s1",
            title: "会话",
            status: "done",
            permissionMode: "normal",
            createdAt: "2026-08-09T10:00:00.000Z",
            updatedAt: "2026-08-09T10:00:00.000Z",
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedTokens: 0,
            totalCostCny: 0,
            todos: [],
            toolCallCount: 0,
            kind: "interactive",
          } as never}
          showDetail
        />,
      );
    });
    assert.equal(container.querySelector(".rail-todo-warning"), null);
    await act(async () => root.unmount());
  });

  it("toolCallCount>0 时不显示 0 工具警告", async () => {
    const [{ act }, { createRoot }, { SessionRail }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-rail"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    const selected = {
      id: "s1",
      title: "会话",
      status: "done",
      permissionMode: "normal",
      createdAt: "2026-08-09T10:00:00.000Z",
      updatedAt: "2026-08-09T10:00:00.000Z",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedTokens: 0,
      totalCostCny: 0,
      todos: [],
      toolCallCount: 5,
      kind: "interactive",
    };
    await act(async () => {
      root.render(
        <SessionRail
          latestTodos={[]}
          selected={selected as never}
          showDetail
        />,
      );
    });
    assert.equal(container.querySelector(".rail-todo-warning"), null);
    await act(async () => root.unmount());
  });
});
