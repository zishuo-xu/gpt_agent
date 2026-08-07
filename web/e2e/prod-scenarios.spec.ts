import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 生产级复杂长任务场景套件（真实模型驱动，浏览器模拟用户真实使用）。
 * 工作区：/tmp/prod-test-workspace（gpt_agent 源码副本，含 node_modules 链接，
 * 可跑 pnpm test / typecheck / build）。
 * 每个场景都是一个完整生产任务：新建会话 → 输入任务 → 等待完成 → 验证产物与测试。
 */

const WORKSPACE = "/tmp/prod-test-workspace";

async function readWorkspaceFile(relative: string): Promise<string> {
  return await readFile(path.join(WORKSPACE, relative), "utf8");
}

/** 新建会话并发送任务（trust 无人值守档，长任务无需审批） */
async function startTask(
  page: Page,
  task: string,
): Promise<void> {
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: "＋ 新会话" })
    .click();
  // 生产长任务选择 trust 无人值守档（normal 下 Bash 审批会挂起等人工）
  await page.getByRole("combobox", { name: "权限档" }).selectOption("trust");
  const input = page.getByPlaceholder(
    "例如：检查这个项目，修复当前失败的测试",
  );
  await input.fill(task);
  await page.getByRole("button", { name: "启动任务" }).click();
  // 等待任务真正启动（会话详情出现输入框；任务运行中 placeholder 为排队版）
  await expect(
    page.getByPlaceholder(/发消息给 MyAgent/),
  ).toBeVisible({ timeout: 60_000 });
}

/** 等待任务完成（真实模型长任务，最长 15 分钟） */
async function waitForCompletion(page: Page): Promise<void> {
  await expect(page.getByText("本轮任务已完成")).toBeVisible({
    timeout: 25 * 60_000,
  });
}

/** 向当前会话继续发消息（长会话多轮场景） */
async function continueChat(page: Page, message: string): Promise<void> {
  const input = page.getByPlaceholder("继续发消息给 MyAgent…");
  await input.fill(message);
  await page.getByRole("button", { name: "发送" }).click();
}


test.describe("生产级长任务场景", () => {
  test("P1 缺陷修复：truncate preferTail 失效，测试红→修绿", async ({
    page,
  }) => {
    const task =
      "项目里 truncate 的 preferTail 测试失败了（src/tools/truncate.test.ts 的" +
      "「preferTail 时尾部保留更多」）。先运行测试复现失败，找到实现中的问题并修复，" +
      "确保所有测试通过（pnpm test）。不要修改测试文件。";
    await startTask(page, task);
    await waitForCompletion(page);

    // 产物验证：preferTail 分支的头部行数系数小于非 preferTail 分支（尾部保留更多语义；
    // 允许模型用 0.4/0.6 或 0.32/0.6 等任何满足语义的系数与防御性包装）
    const source = await readWorkspaceFile("src/tools/truncate.ts");
    const budgetMatch = source.match(
      /headLineBudget = options\.preferTail\s*\n\s*\? Math\.\w+\(lineBudget \* ([\d.]+)\)\s*\n\s*: Math\.\w+\(lineBudget \* ([\d.]+)\)/,
    );
    expect(budgetMatch, "应能解析 preferTail 行数预算系数").not.toBeNull();
    expect(Number(budgetMatch?.[1])).toBeLessThan(
      Number(budgetMatch?.[2]),
      "preferTail 时头部行数系数应小于非 preferTail（尾部保留更多）",
    );
  });

  test("P2 功能实现：usage-stats 模块（汇总 token/费用）+ 单测", async ({
    page,
  }) => {
    const task =
      "实现一个新模块 src/utils/usage-stats.ts：导出 summarizeUsage(records)，" +
      "输入事件流记录数组，返回 { totalInputTokens, totalOutputTokens, totalCachedTokens, totalCostCny }，" +
      "汇总 cost_update 事件。为该模块写单元测试（src/utils/usage-stats.test.ts），" +
      "并确保 pnpm test 全量通过。";
    await startTask(page, task);
    await waitForCompletion(page);

    // 产物验证：模块与测试存在，导出签名正确
    const moduleSource = await readWorkspaceFile("src/utils/usage-stats.ts");
    expect(moduleSource).toContain("summarizeUsage");
    expect(moduleSource).toMatch(/totalInputTokens/);
    expect(moduleSource).toMatch(/totalCostCny/);
    await expect(
      readWorkspaceFile("src/utils/usage-stats.test.ts"),
    ).resolves.toContain("summarizeUsage");
  });

  test("P3 跨模块重构：escapeHtml 提取到 utils 并更新引用", async ({
    page,
  }) => {
    const task =
      "src/web/export-session.ts 里有一个 escapeHtml 函数（HTML 转义）。" +
      "把它提取到公共模块 src/utils/escape.ts（导出 escapeHtml），" +
      "并更新 export-session.ts 改用新导入。运行 typecheck 和 pnpm test 确保全部通过。";
    await startTask(page, task);
    await waitForCompletion(page);

    // 产物验证：新模块存在、旧文件不再定义本地 escapeHtml、改为引用
    const escapeModule = await readWorkspaceFile("src/utils/escape.ts");
    expect(escapeModule).toContain("export function escapeHtml");
    const exportSource = await readWorkspaceFile("src/web/export-session.ts");
    expect(exportSource).toContain('"../utils/escape.js"');
    expect(
      exportSource.match(/function escapeHtml\s*\(/),
    ).toBeNull();
  });

  test("P4 长会话多轮迭代：同一会话连续 3 轮任务，上下文连续", async ({
    page,
  }) => {
    // 完成计数递增等待（多轮后页面有多个「本轮任务已完成」）
    const waitForNextCompletion = async (before: number) => {
      await expect(
        page.getByText("本轮任务已完成"),
      ).toHaveCount(before + 1, { timeout: 25 * 60_000 });
    };
    // 第一轮：分析
    await startTask(
      page,
      "阅读 src/core/events.ts，用一句话说明这个模块的职责，并指出 SessionStore 用什么文件格式持久化。不要修改任何文件。",
    );
    await waitForNextCompletion(0);
    // 第二轮：基于第一轮的结论写测试（模型需记住第一轮结论）
    await continueChat(
      page,
      "基于你刚才的分析，为 SessionStore 补一个单元测试 src/core/events.test.ts 的补充：验证写入后再读回的事件顺序一致。运行相关测试确认通过。",
    );
    await waitForNextCompletion(1);
    // 第三轮：把第二轮测试中的魔法数字改为命名常量（验证上下文延续到第三轮）
    await continueChat(
      page,
      "把你在上一个测试里使用的魔法数字（如果有）提取为命名常量。如果没用魔法数字，则给测试补充一个断言：读取的事件数与写入数一致。完成后运行测试确认通过。",
    );
    await waitForNextCompletion(2);

    // 验证三轮消息都在同一会话（事件流 user 消息 ≥ 3）
    const eventsSource = await readWorkspaceFile(
      "src/core/events.test.ts",
    );
    expect(eventsSource.length).toBeGreaterThan(0);
    // reload 后重新进入该会话，验证三轮完成标记都保留（同名会话取最新的）
    await page.reload();
    await page
      .getByRole("button", { name: "事件模块职责与持久化" })
      .first()
      .click();
    await expect(
      page.getByText("本轮任务已完成"),
    ).toHaveCount(3, { timeout: 30_000 });
  });

  test("P5 架构分析：生成仓库架构文档", async ({ page }) => {
    const task =
      "分析这个仓库的整体架构，在 docs/architecture-summary.md 写出架构总结（中文，约 600 字）。" +
      "只阅读以下 5 个入口文件，不要探索其他文件：src/cli.ts、src/core/session.ts、" +
      "src/model/client.ts、src/tools/executor.ts、src/web/app.ts。" +
      "写完文档后立即结束，不要运行任何命令，不要修改其他文件。"
    await startTask(page, task);
    await waitForCompletion(page);

    const doc = await readWorkspaceFile("docs/architecture-summary.md");
    expect(doc.length).toBeGreaterThan(500);
    for (const keyword of ["src/core", "src/model", "src/tools", "src/web"]) {
      expect(doc).toContain(keyword);
    }
  });

  test("P6 批处理统计：统计测试规模并输出报告", async ({ page }) => {
    const task =
      "写一个一次性 Node 脚本 scripts/count-tests.mjs：统计 src 与 web/src 下所有 *.test.ts(x) 文件数量、" +
      "其中 test( 调用的总数、以及每个目录的分布，输出到 scripts/test-stats.txt。" +
      "运行脚本生成报告后，把报告内容附在最终回复里。不要修改其他源码文件。";
    await startTask(page, task);
    await waitForCompletion(page);

    const report = await readWorkspaceFile("scripts/test-stats.txt");
    const totalMatch = report.match(/test\( 调用总数[：:]\s*(\d+)/);
    expect(totalMatch).not.toBeNull();
    const total = Number(totalMatch?.[1]);
    expect(total).toBeGreaterThan(200);
  });
});
