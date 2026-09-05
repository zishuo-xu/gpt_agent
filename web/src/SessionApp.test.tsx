import { after, before, describe, it } from "node:test";
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

  it("thinking_delta 合并为独立 thinking 展示项", () => {
    const items = buildDisplayItems([
      ev(1, { type: "thinking_delta", text: "先" }),
      ev(2, { type: "thinking_delta", text: "思考" }),
      ev(3, { type: "text_delta", text: "答案" }),
    ]);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      kind: "thinking",
      seq: 1,
      text: "先思考",
    });
    assert.equal(items[1]?.kind, "message");
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
    if (items[0]?.kind === "system") assert.equal(items[0].tone, undefined);
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

  it("Flight Recorder 来源事件显示父 Turn 与固定模型", () => {
    const [item] = buildDisplayItems([
      ev(1, {
        type: "experiment_created",
        parentSessionId: "parent-1",
        parentTurnId: "turn-2",
        parentEventSeq: 9,
        providerId: "provider",
        model: "model",
      }),
    ]);
    assert.equal(item?.kind, "system");
    if (item?.kind === "system") {
      assert.match(item.text, /parent-1/);
      assert.match(item.text, /turn-2/);
      assert.match(item.text, /provider\/model/);
    }
  });

  it("规划事件在时间线展示开始、待决定、批准与失败", () => {
    const items = buildDisplayItems([
      ev(1, { type: "plan_started", planId: "p1", task: "实现功能", revision: 1 }),
      ev(2, { type: "plan_proposed", planId: "p1", task: "实现功能", revision: 1, content: "## 目标\n完成" }),
      ev(3, { type: "plan_decision", planId: "p1", decision: "approved" }),
      ev(4, { type: "plan_failed", planId: "p2", revision: 1, message: "模型不可用" }),
    ]);
    assert.equal(items.length, 4);
    assert.ok(items.every((item) => item.kind === "system"));
    if (items[0]?.kind === "system") assert.match(items[0].text, /只读规划/);
    if (items[1]?.kind === "system") assert.match(items[1].text, /等待你的决定/);
    if (items[2]?.kind === "system") assert.match(items[2].text, /开始执行/);
    if (items[3]?.kind === "system") assert.match(items[3].text, /模型不可用/);
  });

  it("run_started 后同 taskId 的 ledger_update 合并为一张账本卡（随事件流刷新）", () => {
    const unitA = {
      type: "ledger_update",
      taskId: "t1",
      unit: {
        id: "src/a.ts",
        kind: "file",
        label: "src/a.ts",
        status: "done",
        updatedAt: ts,
      },
    };
    const unitB = {
      type: "ledger_update",
      taskId: "t1",
      unit: {
        id: "src/b.ts",
        kind: "file",
        label: "src/b.ts",
        status: "in_progress",
        note: "待验证",
        updatedAt: ts,
      },
    };
    // 事件流到达一半：卡只含已到的单元
    const partial = buildDisplayItems([
      ev(1, { type: "run_started", taskId: "t1", description: "写两个文件", permissionMode: "trust" }),
      ev(2, unitA),
    ]);
    assert.deepEqual(
      partial.map((item) => item.kind),
      ["system", "ledger"],
    );
    const card = partial[1]!;
    assert.equal(card.kind, "ledger");
    if (card.kind === "ledger") {
      assert.equal(card.taskId, "t1");
      assert.equal(card.description, "写两个文件");
      assert.equal(card.units.length, 1);
      assert.equal(card.units[0]?.id, "src/a.ts");
    }

    // 完整事件流：同一 taskId 仍只有一张卡，含全部单元
    const full = buildDisplayItems([
      ev(1, { type: "run_started", taskId: "t1", description: "写两个文件", permissionMode: "trust" }),
      ev(2, unitA),
      ev(3, unitB),
      ev(4, { type: "run_finished", taskId: "t1", status: "completed", reason: "done" }),
    ]);
    const ledgerItems = full.filter((item) => item.kind === "ledger");
    assert.equal(ledgerItems.length, 1);
    const finalCard = ledgerItems[0]!;
    assert.equal(finalCard.kind, "ledger");
    if (finalCard.kind === "ledger") {
      assert.equal(finalCard.units.length, 2);
      assert.deepEqual(
        finalCard.units.map((unit) => unit.id),
        ["src/a.ts", "src/b.ts"],
      );
    }
  });

  it("普通批准任务的账本沿用计划任务标题，不暴露内部 plan id", () => {
    const items = buildDisplayItems([
      ev(1, {
        type: "plan_proposed",
        planId: "p1",
        task: "实现登录功能",
        revision: 1,
        content: "## 目标\n实现登录",
      }),
      ev(2, {
        type: "ledger_update",
        taskId: "plan:p1",
        unit: {
          id: "plan-step-1",
          kind: "task",
          label: "修改登录逻辑",
          status: "in_progress",
          updatedAt: ts,
        },
      }),
    ]);
    const ledger = items.find((item) => item.kind === "ledger");
    assert.equal(ledger?.kind, "ledger");
    if (ledger?.kind === "ledger") {
      assert.equal(ledger.description, "实现登录功能");
    }
  });

  it("无 run_started 时首个 ledger_update 建卡；不同 taskId 各自成卡", () => {
    const items = buildDisplayItems([
      ev(1, {
        type: "ledger_update",
        taskId: "x1",
        unit: {
          id: "notes.md",
          kind: "file",
          label: "notes.md",
          status: "done",
          updatedAt: ts,
        },
      }),
      ev(2, {
        type: "ledger_update",
        taskId: "y2",
        unit: {
          id: "other.txt",
          kind: "file",
          label: "other.txt",
          status: "blocked",
          updatedAt: ts,
        },
      }),
    ]);
    const ledgerItems = items.filter((item) => item.kind === "ledger");
    assert.equal(ledgerItems.length, 2);
    const first = ledgerItems[0]!;
    assert.equal(first.kind, "ledger");
    if (first.kind === "ledger") {
      assert.equal(first.taskId, "x1");
      assert.equal(first.description, undefined);
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

  it("结构化 need_user 生成澄清卡，后续 answerTo 将卡片标为已回答", () => {
    const items = buildDisplayItems([
      ev(1, {
        type: "need_user",
        questionId: "q1",
        question: "选择兼容策略",
        options: [
          { id: "keep", label: "保留兼容" },
          { id: "break", label: "直接升级" },
        ],
        recommendedOptionId: "keep",
      }),
      ev(2, { type: "user", text: "保留兼容", answerTo: "q1" }),
    ]);
    assert.equal(items[0]?.kind, "clarification");
    if (items[0]?.kind === "clarification") {
      assert.equal(items[0].event.recommendedOptionId, "keep");
      assert.equal(items[0].resolvedAnswer, "保留兼容");
    }
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
    sessionsLoaded?: boolean;
    open?: boolean;
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
          sessionsLoaded={props.sessionsLoaded ?? false}
          selectedId={props.selectedId}
          open={props.open}
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

  it("按任务分组渲染，选中项带 active 样式", async () => {
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

  it("open 时侧栏根元素挂 open className（移动端抽屉态）", async () => {
    const { container, root, act } = await setup({
      sessions: [makeSession("s1", "甲")],
      selectedId: "s1",
      open: true,
    });
    const aside = container.querySelector("aside.sidebar");
    assert.ok(aside, "应存在侧栏");
    assert.equal(aside.classList.contains("open"), true);
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

  it("无会话时展示空状态提示（首拉完成前显示加载态）", async () => {
    const { container, root, act } = await setup({ sessions: [], selectedId: "" });
    assert.equal(container.querySelector("button.sidebar-session"), null);
    assert.match(container.querySelector(".sidebar-empty")?.textContent ?? "", /加载任务/);
    await act(async () => root.unmount());
  });

  it("首拉完成后无会话显示「还没有会话」", async () => {
    const { container, root, act } = await setup({
      sessions: [],
      selectedId: "",
      sessionsLoaded: true,
    });
    assert.match(container.querySelector(".sidebar-empty")?.textContent ?? "", /还没有任务/);
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

describe("任务工作台信息层级", () => {
  it("默认项目初始化为项目位置并填入同一个项目 key，大厅保持只读位置", async () => {
    const { initialTaskContext } = await import("./SessionApp");
    assert.deepEqual(initialTaskContext("project-a"), { env: "project", project: "project-a" });
    assert.deepEqual(initialTaskContext("lobby"), { env: "lobby", project: "" });
  });

  const makeTask = (id: string, status: string, title = id) => ({ id, title, status, permissionMode: "normal", createdAt: ts, updatedAt: ts, totalInputTokens: 0, totalOutputTokens: 0, totalCachedTokens: 0, totalCostCny: 0, todos: [], toolCallCount: 0, kind: "interactive" });
  it("将等待、错误和中断归入需要处理，运行中单独分组，idle 归入最近任务", async () => {
    const [{ act }, { createRoot }, { SessionListSidebar }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./SessionApp"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<SessionListSidebar sessions={[makeTask("wait", "waiting_user"), makeTask("error", "error"), makeTask("stop", "interrupted"), makeTask("run", "running"), makeTask("idle", "idle"), makeTask("done", "done")] as never} sessionsLoaded selectedId="" onSelect={() => undefined} onNew={() => undefined} />));
    assert.deepEqual(Array.from(container.querySelectorAll(".task-group-label")).map((node) => node.textContent?.replace(/\d+$/, "")), ["需要你处理", "进行中", "最近任务"]);
    assert.equal(container.querySelector(".task-group-attention")?.querySelectorAll(".sidebar-task-row").length, 3);
    assert.equal(container.querySelector(".task-group-active")?.querySelectorAll(".sidebar-task-row").length, 1);
    assert.equal(container.querySelector(".task-group-recent")?.querySelectorAll(".sidebar-task-row").length, 2);
    await act(async () => root.unmount());
    container.remove();
  });

  it("任务头部只保留标题、状态与中止/续跑", async () => {
    const [{ act }, { createRoot }, { SessionHeader }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-header"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<SessionHeader selected={makeTask("abc123", "waiting_user", "修复问题") as never} busy={false} onInterrupt={() => undefined} onResume={() => undefined} />));
    const text = container.textContent ?? "";
    assert.match(text, /修复问题/);
    assert.match(text, /等待你的回答/);
    assert.doesNotMatch(text, /AGENT \/ SESSION|会话 #|normal/);
    // 等待状态下不显示中止按钮
    assert.equal(container.querySelector(".interrupt-button"), null);
    await act(async () => root.unmount());
    container.remove();
  });

  it("首页空态只呈现任务入口，无欢迎标题", async () => {
    const [{ act }, { createRoot }, { SessionEmpty }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-header"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(
      <SessionEmpty error="" newTaskComposer={<button>新建任务</button>} />,
    ));
    assert.match(container.textContent ?? "", /新建任务/);
    assert.doesNotMatch(container.textContent ?? "", /把工作交给|选择一个会话|新会话/);
    await act(async () => root.unmount());
    container.remove();
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

describe("Composer（无人值守任务模式开关）", () => {
  before(() => {
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  async function renderComposer(runMode: boolean, planMode = false) {
    const [{ act }, { createRoot }, { Composer }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-composer"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const changed: boolean[] = [];
    const planChanged: boolean[] = [];
    await act(async () => {
      root.render(
        <Composer
          message=""
          setMessage={() => undefined}
          busy={false}
          submitting={false}
          selected
          runMode={runMode}
          onRunModeChange={(value) => {
            changed.push(value);
          }}
          planMode={planMode}
          onPlanModeChange={(value) => {
            planChanged.push(value);
          }}
          onSubmit={async () => undefined}
        />,
      );
    });
    return { container, root, act, changed, planChanged };
  }

  it("任务模式开关渲染且可切换；开启后按钮文案变为「启动任务」", async () => {
    const off = await renderComposer(false);
    const toggle = off.container.querySelector(
      ".run-mode-toggle input",
    ) as HTMLInputElement | null;
    assert.ok(toggle, "应渲染无人值守任务开关");
    assert.equal(toggle!.checked, false);
    assert.match(off.container.textContent ?? "", /无人值守任务/);
    // 关闭时：已有会话按钮为「发送」
    const sendButton = Array.from(
      off.container.querySelectorAll("button.save-button"),
    ).at(-1);
    assert.match(sendButton?.textContent ?? "", /发送/);
    // 点击开关 → 通知上层切换
    await off.act(async () => {
      toggle!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.deepEqual(off.changed, [true], "点击开关应通知上层");
    await off.act(async () => off.root.unmount());

    // 开启时：按钮文案变为「启动任务」
    const on = await renderComposer(true);
    const onSendButton = Array.from(
      on.container.querySelectorAll("button.save-button"),
    ).at(-1);
    assert.match(onSendButton?.textContent ?? "", /启动任务/);
    assert.match(on.container.textContent ?? "", /无人值守任务/);
    await on.act(async () => on.root.unmount());
  });

  it("规划模式可切换，开启后主按钮提示理解任务", async () => {
    const rendered = await renderComposer(false, true);
    const toggle = rendered.container.querySelector(
      ".plan-mode-toggle input",
    ) as HTMLInputElement | null;
    assert.ok(toggle);
    assert.equal(toggle!.checked, true);
    assert.match(rendered.container.textContent ?? "", /先理解再执行/);
    assert.match(
      Array.from(rendered.container.querySelectorAll("button.save-button")).at(-1)?.textContent ?? "",
      /让 MyAgent 理解任务/,
    );
    await rendered.act(async () => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.deepEqual(rendered.planChanged, [false]);
    await rendered.act(async () => rendered.root.unmount());
  });
});

describe("隔离工作区入口与结果提示", () => {
  it("新建任务面板以任务输入为主，并保留可明确选择的执行位置与权限档", async () => {
    const [{ act }, { createRoot }, { NewTaskOverlay }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-new-task"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let env = "project";
    let permission = "normal";
    let project = "";
    await act(async () => {
      root.render(<NewTaskOverlay
        newTaskEnv={env as "project" | "lobby"} newTaskProject="p" projects={[{ key: "p", name: "示例项目", cwd: "/example" }]} permissionMode={permission as "normal" | "strict" | "trust"}
        runBoundsPreview={null} submitting={false} message="" runMode={false} workspaceMode="project"
        onWorkspaceModeChange={() => undefined} onRunModeChange={() => undefined} planMode={false} onPlanModeChange={() => undefined}
        onEnvChange={(next) => { env = next; }} onProjectChange={(next) => { project = next; }} onPermissionMode={(next) => { permission = next; }}
        onMessage={() => undefined} onSubmit={async () => undefined}
        onOpenProjectPicker={() => undefined} onClose={() => undefined} onCancelBounds={() => undefined}
      />);
    });
    assert.ok(container.querySelector("textarea"));
    assert.ok(container.querySelector(".new-task-context-row"));
    assert.equal(container.querySelectorAll('.new-task-context-row select').length, 2);
    const envSelect = container.querySelector('.new-task-context-row select') as HTMLSelectElement;
    envSelect.value = "lobby";
    envSelect.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(env, "lobby");
    envSelect.value = "p";
    envSelect.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(env, "project");
    assert.equal(project, "p");
    const permissionSelect = container.querySelectorAll('.new-task-context-row select').item(1) as HTMLSelectElement;
    permissionSelect.value = "strict";
    permissionSelect.dispatchEvent(new Event("change", { bubbles: true }));
    assert.equal(permission, "strict");
    await act(async () => root.unmount());
  });

  it("首页形态不抢占焦点，但仍展示执行位置和权限选择", async () => {
    const [{ act }, { createRoot }, { NewTaskOverlay }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-new-task"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<NewTaskOverlay presentation="home" newTaskEnv="project" newTaskProject="p" projects={[{ key: "p", name: "示例项目", cwd: "/example" }]} permissionMode="normal" runBoundsPreview={null} submitting={false} message="" runMode={false} workspaceMode="project" onWorkspaceModeChange={() => undefined} onRunModeChange={() => undefined} planMode={false} onPlanModeChange={() => undefined} onEnvChange={() => undefined} onProjectChange={() => undefined} onPermissionMode={() => undefined} onMessage={() => undefined} onSubmit={async () => undefined} onOpenProjectPicker={() => undefined} onClose={() => undefined} onCancelBounds={() => undefined} />));
    assert.notEqual(document.activeElement, container.querySelector("textarea"));
    // 首页：位置/权限在左栏，面板只留任务选项
    assert.equal(container.querySelector(".new-task-context-row"), null);
    assert.equal(container.querySelector(".new-task-close"), null);
    const toggle = container.querySelector(".new-task-opts-toggle") as HTMLButtonElement;
    assert.ok(toggle);
    assert.equal(container.querySelector(".new-task-opts-pop"), null);
    await act(async () => toggle.click());
    const pop = container.querySelector(".new-task-opts-pop") as HTMLElement;
    assert.ok(pop);
    assert.ok(pop.querySelector("input[type=checkbox]"));
    assert.ok(pop.textContent?.includes("无人值守任务"));
    await act(async () => root.unmount());
    container.remove();
  });

  it("隔离执行复选框可切换且工作区缺失时显示风险", async () => {
    const [{ act }, { createRoot }, { NewTaskOverlay }, { WorkspaceBanner }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-new-task"), import("./SessionApp"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let mode = "project";
    await act(async () => {
      root.render(<NewTaskOverlay
        newTaskEnv="project" newTaskProject="p" projects={[]} permissionMode="normal"
        runBoundsPreview={null} submitting={false} message="" runMode={true}
        workspaceMode={mode as "project" | "isolated"}
        onWorkspaceModeChange={(next) => { mode = next; }}
        onRunModeChange={() => undefined} planMode={false} onPlanModeChange={() => undefined}
        onEnvChange={() => undefined} onProjectChange={() => undefined} onPermissionMode={() => undefined}
        onMessage={() => undefined} onSubmit={async () => undefined}
        onOpenProjectPicker={() => undefined} onClose={() => undefined} onCancelBounds={() => undefined}
      />);
    });
    // 「隔离执行」收在任务选项弹层内，先点开
    const optsToggle = container.querySelector(".new-task-opts-toggle") as HTMLButtonElement;
    assert.ok(optsToggle);
    await act(async () => optsToggle.click());
    const checkbox = container.querySelector('input[aria-label="隔离执行"]') as HTMLInputElement;
    assert.ok(checkbox);
    checkbox.click();
    assert.equal(mode, "isolated");
    await act(async () => {
      root.render(<WorkspaceBanner workspace={{ mode: "isolated", sourceCwd: "/repo", path: "/tmp/wt", head: "abcdef123456", warnings: ["依赖目录未复制"], exists: false }} />);
    });
    // 路径失效时对话流不再渲染横幅（说明在交付详情中）
    assert.equal(container.textContent ?? "", "");
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

describe("SessionApp 详情抽屉与内联警告", () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = (globalThis as Record<string, unknown>).EventSource;
  const fetchCalls: string[] = [];

  class FakeEventSource {
    static CLOSED = 2;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    constructor(public url: string) {}
    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }

  before(() => {
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    (globalThis as Record<string, unknown>).EventSource = originalEventSource;
  });

  function makeSession(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "s1",
      title: "示例会话",
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
      ...overrides,
    };
  }

  /** 挂载完整 SessionApp：mock fetch（按路由返回）+ 假的 EventSource */
  async function setup(session: Record<string, unknown>) {
    const [{ act }, { createRoot }, { SessionApp }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./SessionApp"),
    ]);
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    globalThis.fetch = (async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : String((input as { url?: string })?.url ?? input);
      fetchCalls.push(url);
      const json = (payload: unknown) =>
        ({ ok: true, status: 200, json: async () => payload }) as Response;
      if (url.includes("/interrupt")) return json({});
      if (url.includes("/workspace")) return json({ workspace: null });
      if (url.includes("/delivery")) return json({});
      if (url.includes("/plan")) return json({ plan: null });
      if (url.includes("/api/sessions")) return json({ sessions: [session] });
      if (url.includes("/api/projects")) return json({ projects: [], defaultKey: "p" });
      if (url.includes("/api/config/effective")) return json({ config: {} });
      return json({});
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SessionApp initialSessionId="s1" />);
    });
    // 等待首屏 fetch 链（sessions → initialSessionId 选中 → workspace/delivery）落定
    await act(async () => {});
    await act(async () => {});
    return { container, root, act };
  }

  function pressEscape() {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
  }

  it("点击状态条打开抽屉，Esc 关闭抽屉且不触发中止", async () => {
    fetchCalls.length = 0;
    const { container, root, act } = await setup(
      makeSession({
        status: "running",
        todos: [{ id: "t1", content: "写核心逻辑", status: "in_progress" }],
        toolCallCount: 1,
      }),
    );
    // 状态条常驻（有 todo），抽屉默认关闭且右栏不常驻
    const statusbar = container.querySelector(".statusbar") as HTMLButtonElement;
    assert.ok(statusbar, "应渲染状态条");
    assert.match(statusbar.textContent ?? "", /计划 0\/1/);
    assert.equal(container.querySelector(".rail-drawer"), null);
    assert.equal(container.querySelector(".session-rail"), null, "右栏不再常驻");

    // 点击状态条 → 打开覆盖抽屉
    await act(async () => {
      statusbar.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    const drawer = container.querySelector(".rail-drawer");
    assert.ok(drawer, "应打开详情抽屉");
    assert.ok(drawer.querySelector(".session-rail"), "抽屉内渲染右栏内容");
    assert.match(drawer.textContent ?? "", /计划详情/);
    assert.match(drawer.textContent ?? "", /写核心逻辑/);

    // Esc → 关闭抽屉，且不触发中止
    await act(async () => {
      pressEscape();
    });
    assert.equal(container.querySelector(".rail-drawer"), null, "Esc 应关闭抽屉");
    assert.equal(
      fetchCalls.some((url) => url.includes("/interrupt")),
      false,
      "抽屉打开时 Esc 不应触发中止",
    );

    // 抽屉关闭后再按 Esc（busy 中）→ 正常触发中止
    await act(async () => {
      pressEscape();
    });
    assert.equal(
      fetchCalls.some((url) => url.includes("/interrupt")),
      true,
      "抽屉关闭后 Esc 应触发中止",
    );
    await act(async () => root.unmount());
    container.remove();
  });

  it("完成态警告内联渲染在会话列（不再由右栏承担）", async () => {
    const { container, root, act } = await setup(
      makeSession({
        status: "done",
        kind: "run",
        toolCallCount: 0,
        todos: [{ id: "t1", content: "写核心逻辑", status: "pending" }],
      }),
    );
    const chatColumn = container.querySelector(".chat-column");
    assert.ok(chatColumn, "应渲染会话列");
    assert.match(chatColumn.textContent ?? "", /未调用任何工具就宣布完成/);
    assert.match(chatColumn.textContent ?? "", /仍有\s*1\s*项任务未完成/);
    // 抽屉未打开时页面没有右栏
    assert.equal(container.querySelector(".session-rail"), null);
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("SessionApp 左侧栏折叠与状态记忆", () => {
  const originalFetch = globalThis.fetch;

  before(() => {
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    window.localStorage.removeItem("myagent.sidebarCollapsed");
  });

  /** 挂载 SessionApp（无选中会话，只 mock 列表/项目/配置三个首屏请求） */
  async function setup() {
    const [{ act }, { createRoot }, { SessionApp }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./SessionApp"),
    ]);
    globalThis.fetch = (async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : String((input as { url?: string })?.url ?? input);
      const json = (payload: unknown) =>
        ({ ok: true, status: 200, json: async () => payload }) as Response;
      if (url.includes("/api/sessions")) return json({ sessions: [] });
      if (url.includes("/api/projects")) return json({ projects: [], defaultKey: "p" });
      if (url.includes("/api/config/effective")) return json({ config: {} });
      return json({});
    }) as typeof fetch;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<SessionApp />);
    });
    await act(async () => {});
    return { container, root, act };
  }

  it("点击折叠按钮切换 collapsed 类并写入 localStorage，重新渲染后保持折叠", async () => {
    window.localStorage.removeItem("myagent.sidebarCollapsed");
    const first = await setup();
    const aside = first.container.querySelector("aside.session-list-sidebar");
    const collapseButton = first.container.querySelector(
      "button.sidebar-collapse",
    ) as HTMLButtonElement;
    assert.ok(aside, "应渲染侧栏");
    assert.ok(collapseButton, "应渲染折叠按钮");
    assert.equal(aside.classList.contains("collapsed"), false, "默认不折叠");
    assert.equal(
      first.container.querySelector(".shell")?.classList.contains("sidebar-collapsed"),
      false,
    );

    // 点击 → 折叠 + 记忆 "1"
    await first.act(async () => {
      collapseButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(aside.classList.contains("collapsed"), true, "点击后应折叠");
    assert.equal(
      first.container.querySelector(".shell")?.classList.contains("sidebar-collapsed"),
      true,
      "shell 应同步折叠态以收窄网格列",
    );
    assert.equal(window.localStorage.getItem("myagent.sidebarCollapsed"), "1");
    assert.equal(collapseButton.getAttribute("aria-label"), "展开侧栏");

    // 再点击 → 展开 + 记忆 "0"
    await first.act(async () => {
      collapseButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(aside.classList.contains("collapsed"), false);
    assert.equal(window.localStorage.getItem("myagent.sidebarCollapsed"), "0");

    // 折叠后模拟刷新：新 root 初始即折叠
    await first.act(async () => {
      collapseButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(window.localStorage.getItem("myagent.sidebarCollapsed"), "1");
    await first.act(async () => first.root.unmount());
    first.container.remove();

    const second = await setup();
    const aside2 = second.container.querySelector("aside.session-list-sidebar");
    assert.equal(
      aside2?.classList.contains("collapsed"),
      true,
      "刷新后应从 localStorage 恢复折叠态",
    );
    assert.equal(
      second.container.querySelector(".shell")?.classList.contains("sidebar-collapsed"),
      true,
    );
    await second.act(async () => second.root.unmount());
    second.container.remove();
    window.localStorage.removeItem("myagent.sidebarCollapsed");
  });

  it("折叠态下新建任务/设置/扩展图标按钮带 title 提示", async () => {
    window.localStorage.setItem("myagent.sidebarCollapsed", "1");
    const { container, root, act } = await setup();
    const aside = container.querySelector("aside.session-list-sidebar");
    assert.ok(aside?.classList.contains("collapsed"), "应以折叠态渲染");

    const newTaskButton = container.querySelector("button.sidebar-new");
    assert.equal(newTaskButton?.getAttribute("title"), "新建任务", "新建任务按钮应带 title");

    const navItems = Array.from(container.querySelectorAll("button.nav-item"));
    const settingsNav = navItems.find((item) => item.textContent?.includes("设置"));
    const pluginsNav = navItems.find((item) => item.textContent?.includes("扩展"));
    assert.equal(settingsNav?.getAttribute("title"), "设置", "设置按钮应带 title");
    assert.equal(pluginsNav?.getAttribute("title"), "扩展", "扩展按钮应带 title");

    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("myagent.sidebarCollapsed");
  });
});

