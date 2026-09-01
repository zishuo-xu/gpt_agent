import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { WorkspaceInfo } from "@shared/types.js";
import type { DeliveryWorkbenchData } from "./DeliveryWorkbench";

before(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Other Web suites may already have registered happy-dom.
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

const baseDelivery: DeliveryWorkbenchData = {
  title: "交付任务",
  outcome: "completed",
  verification: "passed",
  review: "not_run",
  files: [],
  checks: [],
  warnings: [],
  unconfirmed: [],
};

async function renderWorkbench(
  delivery: DeliveryWorkbenchData,
  options: {
    workspace?: WorkspaceInfo;
    onContinue?: () => void;
    onCopyPath?: () => void;
    onExport?: () => void;
  } = {},
) {
  const [{ act }, { createRoot }, { DeliveryWorkbench }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    import("./DeliveryWorkbench"),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <DeliveryWorkbench
        delivery={delivery}
        workspace={options.workspace}
        onContinue={options.onContinue}
        onCopyPath={options.onCopyPath}
        onExport={options.onExport}
      />,
    );
  });
  return { act, container, root };
}

describe("DeliveryWorkbench 状态与证据", () => {
  it("区分已验证、未验收、验收失败、任务失败和任务中断", async () => {
    const cases: Array<{
      delivery: DeliveryWorkbenchData;
      heading: string;
    }> = [
      { delivery: baseDelivery, heading: "已验证完成" },
      {
        delivery: { ...baseDelivery, verification: "not_run" },
        heading: "已完成但未机器验收",
      },
      {
        delivery: { ...baseDelivery, verification: "failed" },
        heading: "机器验收未通过",
      },
      {
        delivery: { ...baseDelivery, outcome: "failed" },
        heading: "任务失败",
      },
      {
        delivery: { ...baseDelivery, outcome: "interrupted" },
        heading: "任务中断",
      },
    ];

    for (const item of cases) {
      const rendered = await renderWorkbench(item.delivery);
      assert.equal(
        rendered.container.querySelector("h2")?.textContent,
        item.heading,
      );
      await rendered.act(async () => rendered.root.unmount());
      rendered.container.remove();
    }
  });

  it("展示验收输出、Review、完整文件清单和隔离工作区风险", async () => {
    const files = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`);
    const delivery: DeliveryWorkbenchData = {
      ...baseDelivery,
      review: "failed",
      files,
      checks: [
        {
          command: "pnpm test",
          status: "passed",
          exitCode: 0,
          durationMs: 1234,
          output: "all tests passed",
        },
      ],
      reviewResult: {
        passed: false,
        issues: ["src/file-7.ts:12 缺少边界处理"],
        summary: "需要修复一项问题",
      },
      unconfirmed: ["文件清单不等于完整 Git diff"],
    };
    const workspace: WorkspaceInfo = {
      mode: "isolated",
      path: "/tmp/myagent-worktree",
      baseHead: "abcdef123456",
      currentHead: "abcdef123456",
      exists: true,
      changedSinceCreated: true,
      warnings: ["依赖目录未复制"],
    };
    const actions: string[] = [];
    const rendered = await renderWorkbench(delivery, {
      workspace,
      onContinue: () => actions.push("continue"),
      onCopyPath: () => actions.push("copy"),
      onExport: () => actions.push("export"),
    });
    const text = rendered.container.textContent ?? "";
    assert.match(text, /机器验收：通过/);
    assert.match(text, /pnpm test/);
    assert.match(text, /1234ms/);
    assert.match(text, /all tests passed/);
    assert.match(text, /缺少边界处理/);
    assert.match(text, /src\/file-7\.ts/);
    assert.equal(rendered.container.querySelectorAll(".delivery-files li").length, 8);
    assert.match(text, /工作区自创建后已发生变化/);
    assert.match(text, /依赖目录未复制/);
    assert.match(text, /尚未自动合并/);

    const buttons = Array.from(
      rendered.container.querySelectorAll<HTMLButtonElement>("footer button"),
    );
    await rendered.act(async () => {
      for (const button of buttons) button.click();
    });
    assert.deepEqual(actions, ["continue", "copy", "export"]);
    await rendered.act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it("隔离路径缺失时明确显示不可用", async () => {
    const rendered = await renderWorkbench(baseDelivery, {
      workspace: {
        mode: "isolated",
        path: "/tmp/missing",
        exists: false,
        warnings: ["隔离工作区路径不存在"],
      },
    });
    assert.match(rendered.container.textContent ?? "", /路径缺失/);
    assert.match(rendered.container.textContent ?? "", /路径不存在/);
    await rendered.act(async () => rendered.root.unmount());
    rendered.container.remove();
  });

  it("首屏突出四项交付指标，文件预览最多五项，完整清单保留在折叠详情", async () => {
    const files = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`);
    const rendered = await renderWorkbench({
      ...baseDelivery,
      files,
      verification: "passed",
      review: "failed",
      warnings: ["存在一个待确认风险"],
      reviewResult: { passed: false, issues: ["需要复查"], summary: "Review 需要复查" },
    });
    assert.equal(rendered.container.querySelectorAll(".delivery-metrics > div").length, 4);
    assert.equal(rendered.container.querySelectorAll(".delivery-files-preview li").length, 5);
    const details = rendered.container.querySelector(".delivery-details");
    assert.ok(details, "应存在机器验收详情折叠区");
    assert.equal(details.querySelectorAll(".delivery-files li").length, 8);
    assert.match(rendered.container.textContent ?? "", /还有 3 个文件/);
    await rendered.act(async () => rendered.root.unmount());
    rendered.container.remove();
  });
});
