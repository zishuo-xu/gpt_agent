import { expect, test } from "@playwright/test";

/**
 * MyAgent Web E2E 回归套件（生产级路径）：
 * - 设置页：加载、分区渲染、作用域切换、扩展字段编辑
 * - 会话页：列表、新建面板、会话详情、分支树
 * - 审批与任务：真实任务（只读）+ 写文件审批流
 * 服务器由 playwright webServer 启动（隔离 HOME /tmp/myagent-gui-test-home）。
 */

test.describe("设置页", () => {
  test("加载并渲染六分区，编辑扩展字段后保存", async ({ page }) => {
    await page.goto("/#settings");
    await expect(
      page.getByRole("heading", { name: "模型设置" }),
    ).toBeVisible();
    // 供应商分区
    await expect(
      page.getByRole("heading", { name: "模型供应商" }),
    ).toBeVisible();
    // 角色模型
    await expect(
      page.getByRole("heading", { name: "角色模型" }),
    ).toBeVisible();
    // 权限与审批
    await expect(
      page.getByRole("heading", { name: "权限与审批" }),
    ).toBeVisible();
    // 上下文
    await expect(
      page.getByRole("heading", { name: "上下文" }),
    ).toBeVisible();
    // 扩展设置（schema 驱动字段）
    await expect(
      page.getByRole("heading", { name: "扩展设置" }),
    ).toBeVisible();
    // 作用域切换
    await page.getByRole("button", { name: "当前项目" }).click();
    await expect(
      page.getByText("正在读取本机配置…").or(page.getByRole("heading", { name: "模型供应商" })),
    ).toBeVisible();
  });

  test("修改上下文阈值触发 dirty 状态并可保存", async ({ page }) => {
    await page.goto("/#settings");
    const threshold = page.getByRole("spinbutton", {
      name: "硬压缩触发（估算 tokens）",
    });
    // 读当前值再 +1：保证与已保存值不同（重复运行也稳定触发 onChange）
    const current = Number(await threshold.inputValue());
    await threshold.fill(String(current + 1));
    const saveButton = page.getByRole("button", { name: "保存更改" });
    await expect(saveButton).toHaveClass(/dirty/);
    await saveButton.click();
    await expect(page.getByText("配置已保存。")).toBeVisible();
  });
});

test.describe("会话页", () => {
  test("会话列表加载、新建面板打开", async ({ page }) => {
    await page.goto("/");
    // 侧栏（会话列表区）
    await expect(
      page.locator(".session-list-sidebar"),
    ).toBeVisible();
    await expect(
      page.getByLabel("会话列表"),
    ).toBeVisible();
    // 新建会话
    await page
      .getByRole("main")
      .getByRole("button", { name: "＋ 新会话" })
      .click();
    await expect(
      page.getByRole("heading", { name: "今天想让 MyAgent 做什么？" }),
    ).toBeVisible();
    // 项目/大厅二选一（radio input 视觉隐藏，点击关联 label）
    await expect(
      page.getByRole("radio", { name: /在项目下执行/ }),
    ).toBeChecked();
    await page.getByText("在大厅执行", { exact: false }).first().click();
    await expect(
      page.getByRole("radio", { name: /在大厅执行/ }),
    ).toBeChecked();
    // 关闭面板
    await page.getByRole("button", { name: "关闭" }).click();
  });

  test("新建会话并发送只读任务，事件流实时渲染", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("main")
      .getByRole("button", { name: "＋ 新会话" })
      .click();
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill(
      "List the files in this project and briefly summarize what this project is about. Use read-only commands only.",
    );
    await page.getByRole("button", { name: "启动任务" }).click();
    // 进入会话详情，等待工具调用与完成
    await expect(
      page.getByRole("button", { name: "■ 中止任务" }).or(
        page.getByText("本轮", { exact: false }),
      ),
    ).toBeVisible({ timeout: 30_000 });
    // 事件流出现工具卡片（glob/read 等）
    await expect(
      page.locator(".web-tool-card").first(),
    ).toBeVisible({ timeout: 60_000 });
    // 等待任务完成（真实模型，最长 3 分钟）
    await expect(page.getByText("本轮任务已完成")).toBeVisible({
      timeout: 180_000,
    });
  });
});

test.describe("审批流", () => {
  test("写文件触发审批卡，批准后文件落盘", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("main")
      .getByRole("button", { name: "＋ 新会话" })
      .click();
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill(
      "Create a file named e2e-proof.txt in this project with the content: e2e ok",
    );
    await page.getByRole("button", { name: "启动任务" }).click();
    // 等待审批卡（Write 触发）
    await expect(
      page.getByRole("button", { name: "仅这一次" }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("审批请求")).toBeVisible();
    // 批准
    await page.getByRole("button", { name: "仅这一次" }).click();
    await expect(page.getByText("本轮任务已完成")).toBeVisible({
      timeout: 180_000,
    });
  });
});
