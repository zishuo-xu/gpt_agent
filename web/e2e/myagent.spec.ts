import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * MyAgent Web E2E 回归套件（生产级路径）：
 * - 设置页：加载、分区渲染、作用域切换、扩展字段编辑
 * - 会话页：列表、新建面板、会话详情、分支树
 * - 审批与任务：真实任务（只读）+ 写文件审批流
 * 服务器由 playwright webServer 启动（隔离 HOME /tmp/myagent-gui-test-home）。
 * 工作目录持久化跨运行；涉及文件落盘的用例需先清理旧产物。
 */
const E2E_WORKSPACE = "/tmp/myagent-gui-test-workspace";

/**
 * React 19 受控 select 的真实用户路径选择：经原型 setter 写 value + 派发 change。
 * Playwright 原生 selectOption 直接赋值会同步 React 19 实例级 value tracker，
 * 导致 onChange 的 change-detection 判定"无变化"而静默不触发（受控组件 state
 * 不更新、页面停留在旧数据）——与 typeInto 对 input 的处理同源。
 */
async function selectProjectOption(page: Page, label: string): Promise<void> {
  await page
    .getByRole("combobox", { name: "项目" })
    .evaluate((el, targetLabel) => {
      const select = el as HTMLSelectElement;
      const option = Array.from(select.options).find(
        (item) => item.textContent === targetLabel,
      );
      if (!option) throw new Error(`项目选项不存在：${targetLabel}`);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!
        .set!.call(select, option.value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, label);
}

/**
 * 任务运行期间自动批准审批卡（仅限只读任务测试）。
 * 模型可能选用白名单外的只读命令组合，headless 无人响应时 60s
 * 超时自动拒绝会导致任务停滞；本 helper 轮询未决审批卡并点
 * 「仅这一次」（scope=once），直到完成标记可见或超时。
 * 只读任务契约由任务描述保证；写任务测试不得使用——
 * 「写文件触发审批卡」用例验证的正是审批流本身。
 */
async function autoApproveReadonly(
  page: Page,
  done: Locator,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await done.isVisible().catch(() => false)) return;
    const pending = page.locator(
      ".web-approval-card:not(.resolved) .approve-button",
    );
    if ((await pending.count()) > 0) {
      await pending.first().click();
    }
    // 周期覆盖审批卡 resolved 的 SSE 推送往返（本地服务毫秒级）
    await page.waitForTimeout(750);
  }
}

test.describe("设置页", () => {
  test("加载并渲染六分区，编辑扩展字段后保存", async ({ page }) => {
    await page.goto("/#settings");
    await expect(
      page.getByRole("heading", { name: "设置", exact: true }),
    ).toBeVisible();
    // 模型 tab：供应商分区 + 角色模型
    await expect(
      page.getByRole("heading", { name: "模型供应商" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "角色模型" }),
    ).toBeVisible();
    // 切到通用 tab：权限 / 上下文 / 扩展设置
    await page.getByRole("button", { name: "通用", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "权限与审批" }),
    ).toBeVisible();
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
    // 切回模型 tab → 作用域切换
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.getByRole("button", { name: "当前项目" }).click();
    await expect(
      page.getByText("正在读取本机配置…").or(page.getByRole("heading", { name: "模型供应商" })),
    ).toBeVisible();
  });

  test("修改上下文阈值触发 dirty 状态并可保存", async ({ page }) => {
    await page.goto("/#settings");
    await page.getByRole("button", { name: "通用", exact: true }).click();
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
    await expect(page.getByRole("heading", { name: "扩展", exact: true })).toBeVisible();
    // 侧栏导航有「扩展」项
    await expect(page.getByRole("navigation").getByRole("button", { name: "扩展", exact: true })).toBeVisible();
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
  test("会话列表加载、首页新建面板渲染", async ({ page }) => {
    await page.goto("/");
    // 侧栏（会话列表区）
    await expect(
      page.locator(".session-list-sidebar"),
    ).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "搜索任务" }),
    ).toBeVisible();
    // 新版首页即新建面板：大标题 + hero 输入框
    await expect(
      page.getByRole("heading", { name: "今天想完成什么？" }),
    ).toBeVisible();
    const input = page.getByPlaceholder("例如：检查这个项目，修复当前失败的测试");
    await expect(input).toBeVisible();
    // 位置选择（任务位置 chip）：默认项目
    await expect(
      page.getByRole("combobox", { name: "任务位置" }),
    ).toBeVisible();
    // 范围建议模板（设计稿示例入口）：四个按钮渲染，点击填充输入框
    await expect(page.locator(".home-examples")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "修复问题" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "补充测试" }).click();
    await expect(input).toHaveValue(/补充缺失的单元测试/);
  });

  test("新建会话并发送只读任务，事件流实时渲染", async ({ page }) => {
    await page.goto("/");
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill(
      "List the files in this project and briefly summarize what this project is about. Use read-only commands only.",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const done = page.getByText("本轮任务已完成");
    // 并行：等待完成的同时自动批准白名单外只读命令触发的审批卡
    const approvalLoop = autoApproveReadonly(page, done, 180_000);
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
    await expect(done).toBeVisible({
      timeout: 180_000,
    });
    await approvalLoop;
  });
});

test.describe("审批流", () => {
  test("写文件触发审批卡，批准后文件落盘", async ({ page }) => {
    // 工作目录跨运行持久化：先清掉上次遗留的同名文件，
    // 否则模型会发现文件已存在并跳过 Write，审批卡永不出现
    await rm(path.join(E2E_WORKSPACE, "e2e-proof.txt"), { force: true });
    await page.goto("/");
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill(
      "Create a file named e2e-proof.txt in this project with the content: e2e ok",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
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
    const input = page.getByPlaceholder(
      "例如：检查这个项目，修复当前失败的测试",
    );
    await input.fill("回复 OK，不要使用工具。");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    // 用户消息立即渲染（无需等任务完成）
    await expect(
      page.locator(".stream-item").first(),
    ).toBeVisible({ timeout: 30_000 });
  }

  test("用户消息书签：打标 → 书签栏出现 → 移除", async ({ page }) => {
    // 书签功能在前端重构中被移除（SessionStream ★ 按钮 + 书签栏 + SessionApp 状态），
    // 后端 /api/sessions/:id/bookmarks 仍在。待确认是否恢复后，再启用此用例。
    test.skip(true, "书签功能已在本次前端重构中移除，待确认恢复后再启用");
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
    // 导出按钮在「轨迹」标签页头部，先切换过去
    await page.getByRole("button", { name: "轨迹" }).click();
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
    // 选择第一个非大厅项目（隔离 workspace 的默认项目）；
    // 项目下拉异步加载，先等出现第二个选项（非大厅）再做原型 setter 选择
    await expect(async () => {
      const count = await page
        .getByRole("combobox", { name: "项目" })
        .evaluate((el) => (el as HTMLSelectElement).options.length);
      expect(count).toBeGreaterThan(1);
    }).toPass({ timeout: 15_000 });
    await page
      .getByRole("combobox", { name: "项目" })
      .evaluate((el) => {
        const select = el as HTMLSelectElement;
        const option = select.options[1];
        if (!option) throw new Error("项目下拉没有第二个选项");
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!
          .set!.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
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
    // 选择 e2e 工作区项目（defaultCwd，startSession 的会话所在）——不能按 index：
    // listProjects 按 updatedAt 降序，隔离 HOME 积累的历史项目会抢占前位；
    // 项目下拉是异步加载的，先等目标选项出现再做原型 setter 选择
    await expect(async () => {
      const has = await page.getByRole("combobox", { name: "项目" }).evaluate(
        (el, label) =>
          Array.from((el as HTMLSelectElement).options).some(
            (o) => o.textContent === label,
          ),
        "myagent-gui-test-workspace",
      );
      expect(has).toBe(true);
    }).toPass({ timeout: 15_000 });
    await selectProjectOption(page, "myagent-gui-test-workspace");
    // 总量卡与图表
    await expect(page.locator(".stats-card").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("会话总数", { exact: false })).toBeVisible();
    // 明细表（表头 + 至少一行）
    await expect(page.locator(".stats-table tbody tr").first()).toBeVisible();
    // 若存在无人值守会话：点「查看」打开收尾总结模态并关闭（不依赖历史数据）。
    // 注意：表格「轨迹」列按钮也是 .stats-summary-button，必须按文本精确选「查看」
    const viewButtons = page.getByRole("button", { name: "查看" });
    if ((await viewButtons.count()) > 0) {
      await viewButtons.first().click();
      const modal = page.locator('.stats-modal[aria-label="收尾总结"]');
      await expect(modal).toBeVisible();
      await modal.getByRole("button", { name: "关闭" }).click();
      await expect(modal).toHaveCount(0);
    }
  });
});
