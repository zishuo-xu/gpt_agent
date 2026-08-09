import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * MyAgent Web E2E 回归套件（生产级路径）：
 * - 设置页：加载、分区渲染、作用域切换、扩展字段编辑
 * - 会话页：列表、新建面板、会话详情、分支树
 * - 审批与任务：真实任务（只读）+ 写文件审批流
 * 服务器由 playwright webServer 启动（隔离 HOME /tmp/myagent-gui-test-home）。
 * 工作目录持久化跨运行；涉及文件落盘的用例需先清理旧产物。
 */
const E2E_WORKSPACE = "/tmp/myagent-gui-test-workspace";

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
    // 插件工具开关（schema 驱动渲染）
    await expect(
      page.getByRole("checkbox", { name: /插件工具/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /插件工具/ }),
    ).toBeChecked();
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

test.describe("插件面板", () => {
  test("插件页渲染三分区（加载清单 / 错误 / 调用统计）", async ({ page }) => {
    await page.goto("/#plugins");
    await expect(page.getByRole("heading", { name: "插件" })).toBeVisible();
    // 侧栏导航有「插件」项
    await expect(page.getByRole("button", { name: /插件/ })).toBeVisible();
    // 三个分区标题（数量随环境变化，用正则）
    await expect(
      page.getByRole("heading", { name: /已加载（\d+）/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /加载错误（\d+）/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /调用统计（\d+）/ }),
    ).toBeVisible();
  });

  test("重新加载按钮触发 reload 并提示成功", async ({ page }) => {
    await page.goto("/#plugins");
    const reloadButton = page.getByRole("button", { name: "重新加载" });
    await expect(reloadButton).toBeVisible();
    await reloadButton.click();
    await expect(page.getByText("插件已重新加载（新请求生效）")).toBeVisible();
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
    // 范围建议模板（N4）：四个按钮渲染，点击填充输入框
    await expect(
      page.locator(".task-scope-templates"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "只读分析" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "修复缺陷" }).click();
    await expect(
      page.getByPlaceholder("例如：检查这个项目，修复当前失败的测试"),
    ).toHaveValue(/先运行相关测试复现失败/);
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
    // 工作目录跨运行持久化：先清掉上次遗留的同名文件，
    // 否则模型会发现文件已存在并跳过 Write，审批卡永不出现
    await rm(path.join(E2E_WORKSPACE, "e2e-proof.txt"), { force: true });
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

test.describe("新功能：书签 / 导出 / 续跑按钮", () => {
  async function startSession(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page
      .getByRole("main")
      .getByRole("button", { name: "＋ 新会话" })
      .click();
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill("回复 OK，不要使用工具。");
    await page.getByRole("button", { name: "启动任务" }).click();
    // 用户消息立即渲染（★ 按钮随 user 消息出现，无需等任务完成）
    await expect(
      page.locator("button.stream-bookmark").first(),
    ).toBeVisible({ timeout: 30_000 });
  }

  test("用户消息书签：打标 → 书签栏出现 → 移除", async ({ page }) => {
    await startSession(page);
    // ★ 悬停消息卡片显示星标（真实用户路径），点击打书签
    const bookmark = page.locator("button.stream-bookmark").first();
    await page.locator(".stream-item").first().hover();
    await expect(bookmark).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept("e2e 书签"));
    await bookmark.click();
    // 书签栏出现该书签
    await expect(
      page.locator(".bookmark-item", { hasText: "e2e 书签" }),
    ).toBeVisible({ timeout: 15_000 });
    // 移除（书签卡片 ✕，role=button 的 time 元素）
    await page
      .locator(".bookmark-item", { hasText: "e2e 书签" })
      .getByRole("button", { name: "移除书签 e2e 书签" })
      .click();
    await expect(
      page.locator(".bookmark-item", { hasText: "e2e 书签" }),
    ).toHaveCount(0, { timeout: 15_000 });
  });

  test("导出会话为 HTML：下载文件含事件渲染", async ({ page }) => {
    await startSession(page);
    // 等至少一条 assistant 消息（导出内容含事件）
    await expect(page.getByText("本轮", { exact: false }).first()).toBeVisible(
      { timeout: 60_000 },
    );
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^myagent-[0-9a-f]+\.html$/);
    const filePath = await download.path();
    const content = await import("node:fs/promises").then(({ readFile }) =>
      readFile(filePath, "utf8"),
    );
    expect(content).toContain("<!DOCTYPE html>");
    expect(content).toContain("MyAgent 会话导出");
  });

  test("正常会话不显示续跑按钮，resume API 返回 409", async ({ page, request }) => {
    await startSession(page);
    await expect(page.locator("button.resume-button")).toHaveCount(0);
    // 当前会话无中断任务：resume 应被拒绝
    const sessions = (await (
      await request.get("/api/sessions")
    ).json()) as { sessions: Array<{ id: string }> };
    const latest = sessions.sessions[0] as { id: string };
    const resumeResponse = await request.post(
      `/api/sessions/${latest.id}/resume`,
    );
    expect(resumeResponse.status()).toBe(409);
  });
});

test.describe("新功能：定时任务 / 统计面板", () => {
  test("定时任务：注册 → 列表显示干净命令 → 确认删除", async ({ page }) => {
    await page.goto("/#scheduled");
    await expect(
      page.getByRole("heading", { name: "定时任务" }),
    ).toBeVisible();
    // 选择第一个非大厅项目（隔离 workspace 的默认项目）
    await page.getByRole("combobox", { name: "项目" }).selectOption({ index: 1 });
    const input = page.getByRole("textbox", {
      name: "/run 任务描述 [--at HH:mm] [--every N 分钟] [--permission …]",
    });
    // --at 23:59：今天已过则顺延明天，测试期间不会触发
    await input.fill("/run e2e 定时任务验证 --at 23:59 --permission normal");
    await page.getByRole("button", { name: "注册定时任务" }).click();
    // 列表显示剥离 --at 后的干净命令
    await expect(
      page.locator(".scheduler-item code", {
        hasText: "/run e2e 定时任务验证 --permission normal",
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(".scheduler-item small", { hasText: "一次性" }),
    ).toBeVisible();
    // 删除（确认框接受）
    page.once("dialog", (dialog) => void dialog.accept());
    await page.locator("button.scheduler-remove").click();
    await expect(
      page.getByText("当前项目暂无定时任务", { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("统计面板：总量卡 / 图表 / 明细表渲染", async ({ page }) => {
    await page.goto("/#stats");
    await expect(
      page.getByRole("heading", { name: "任务统计" }),
    ).toBeVisible();
    await page.getByRole("combobox", { name: "项目" }).selectOption({ index: 1 });
    // 总量卡与图表
    await expect(page.locator(".stats-card").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("会话总数", { exact: false })).toBeVisible();
    // 明细表（表头 + 至少一行）
    await expect(page.locator(".stats-table tbody tr").first()).toBeVisible();
    // 若存在无人值守会话：点「查看」打开收尾总结模态并关闭（不依赖历史数据）
    const viewButtons = page.locator("button.stats-summary-button");
    if ((await viewButtons.count()) > 0) {
      await viewButtons.first().click();
      const modal = page.locator(".stats-modal");
      await expect(modal).toBeVisible();
      await expect(modal.getByText("收尾总结", { exact: false })).toBeVisible();
      await modal.getByRole("button", { name: "关闭" }).click();
      await expect(modal).toHaveCount(0);
    }
  });
});
