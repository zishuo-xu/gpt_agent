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


