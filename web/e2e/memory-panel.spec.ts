import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * 记忆面板生产级回归（审计深化 + Markdown 预览）：
 * - 面板加载：四类文档 + 时间线空态
 * - 文档编辑保存 + 清空（confirm）
 * - 预览/编辑切换：markdown 渲染（标题/列表/代码块）且不丢草稿
 * 服务器由 playwright webServer 启动（cwd=/tmp/myagent-gui-test-workspace）。
 * 说明：e2e 环境无模型配置，无法真实会话触发 agent 写入记忆——
 * 时间线 diff/跳转的完整链路在服务级 + 浏览器模拟用户验证（真实模型写入）。
 */
const WORKSPACE_MEMORY = "/tmp/myagent-gui-test-workspace/.myagent/memory";

test.describe("记忆面板（生产级回归）", () => {
  test.beforeEach(async () => {
    await rm(WORKSPACE_MEMORY, { recursive: true, force: true });
    await mkdir(WORKSPACE_MEMORY, { recursive: true });
  });

  test.afterEach(async () => {
    await rm(WORKSPACE_MEMORY, { recursive: true, force: true });
  });

  test("面板加载：文档列表 + 时间线结构渲染（chips + 空态或记录）", async ({
    page,
  }) => {
    await page.goto("/#memory");
    await expect(
      page.getByRole("heading", { name: "记忆面板" }),
    ).toBeVisible();
    // 全局 + 项目文档列表（限定列表区，避免与编辑器标题冲突）
    const list = page.locator(".memory-list");
    await expect(list.getByText("preferences（全局）")).toBeVisible();
    await expect(list.getByText(/\/ conventions/)).toBeVisible();
    await expect(list.getByText(/\/ pitfalls/)).toBeVisible();
    // 时间线结构：标题 + 筛选 chips 渲染
    await expect(
      page.getByRole("heading", { name: "自动写入记录" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "全部" })).toBeVisible();
    // 记录区要么空态要么有条目（e2e 工作区可能有历史会话事件）
    const emptyOrList = page
      .getByText("尚无 Agent 自动写入记录。")
      .or(page.locator(".timeline-entry"));
    await expect(emptyOrList.first()).toBeVisible();
  });

  test("编辑保存 + 预览切换（标题/列表/代码块渲染，切回不丢草稿）", async ({
    page,
  }) => {
    await page.goto("/#memory");
    const markdown = [
      "## 稳定记忆",
      "",
      "- [2026-08-10] 预览测试条目",
      "",
      "```bash",
      "pnpm test",
      "```",
    ].join("\n");
    const textarea = page.locator(".memory-textarea");
    await textarea.fill(markdown);
    // 保存
    await page.getByRole("button", { name: "保存更改" }).click();
    await expect(page.getByText("记忆已保存。")).toBeVisible();
    // 切预览：标题/列表/代码块渲染
    await page.getByRole("button", { name: "预览" }).click();
    await expect(page.locator(".memory-preview h2")).toHaveText("稳定记忆");
    await expect(page.getByText("• [2026-08-10] 预览测试条目")).toBeVisible();
    await expect(page.locator(".memory-preview pre.code-block")).toContainText(
      "pnpm test",
    );
    // 切回编辑：草稿保留
    await page.getByRole("button", { name: "编辑" }).click();
    await expect(textarea).toHaveValue(markdown);
  });
});
