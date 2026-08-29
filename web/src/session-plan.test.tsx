import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

describe("PlanDecisionOverlay（人在闭环计划决策）", () => {
  before(() => {
    try {
      GlobalRegistrator.register();
    } catch {
      // 其他测试已注册。
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it("展示只读证据与三种决定，修改计划必须填写反馈", async () => {
    const [{ act }, { createRoot }, { PlanDecisionOverlay }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-plan"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const decisions: Array<{ decision: string; feedback?: string }> = [];
    let feedback = "";
    const render = () => (
      <PlanDecisionOverlay
        plan={{
          planId: "p1",
          task: "实现登录",
          revision: 2,
          status: "awaiting_approval",
          content: "## 目标\n完成登录\n## 验证方式\n- pnpm test",
          contract: {
            goal: "完成登录",
            steps: [],
            files: [],
            checks: ["pnpm test"],
            risks: [],
          },
        }}
        feedback={feedback}
        submitting={false}
        onFeedback={(value) => {
          feedback = value;
          root.render(render());
        }}
        onDecision={async (decision, value) => {
          decisions.push({ decision, ...(value ? { feedback: value } : {}) });
        }}
      />
    );
    await act(async () => root.render(render()));

    assert.equal(container.querySelector("[role=dialog]")?.getAttribute("aria-modal"), "true");
    assert.match(container.textContent ?? "", /只读规划 · 第 2 版/);
    assert.match(container.textContent ?? "", /Read、Grep、Glob/);
    assert.match(container.textContent ?? "", /批准后自动执行的机器验收/);
    assert.match(container.textContent ?? "", /pnpm test/);
    assert.ok(container.querySelector("h2"), "Markdown 目标标题应渲染");
    const buttons = Array.from(container.querySelectorAll("button"));
    const revise = buttons.find((button) => button.textContent?.includes("修改计划"));
    assert.equal(revise?.disabled, true);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!
        .set!.call(textarea, "不要改 API");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const enabledRevise = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("修改计划"));
    assert.equal(enabledRevise?.disabled, false);
    await act(async () => enabledRevise?.click());
    assert.deepEqual(decisions[0], {
      decision: "revision_requested",
      feedback: "不要改 API",
    });

    const analysis = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("仅保留分析"));
    await act(async () => analysis?.click());
    const approve = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("批准并开始执行"));
    await act(async () => approve?.click());
    assert.deepEqual(decisions.slice(1).map((item) => item.decision), [
      "analysis_only",
      "approved",
    ]);
    await act(async () => root.unmount());
    container.remove();
  });

  it("无可靠检查时明确说明不会冒充机器验收", async () => {
    const [{ act }, { createRoot }, { PlanDecisionOverlay }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("./session-plan"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PlanDecisionOverlay
          plan={{
            planId: "p2",
            task: "只读分析",
            revision: 1,
            status: "awaiting_approval",
            content: "## 目标\n只读分析",
            contract: {
              goal: "只读分析",
              steps: [],
              files: [],
              checks: [],
              risks: [],
            },
          }}
          feedback=""
          submitting={false}
          onFeedback={() => undefined}
          onDecision={async () => undefined}
        />,
      );
    });
    assert.match(container.textContent ?? "", /未配置安全、可识别的机器验收/);
    assert.match(container.textContent ?? "", /不会冒充验收通过/);
    await act(async () => root.unmount());
    container.remove();
  });
});
