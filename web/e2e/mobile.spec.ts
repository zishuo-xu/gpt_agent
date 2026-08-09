import { expect, test } from "@playwright/test";

/**
 * 移动端（375px）回归：侧栏抽屉交互。
 * 服务器由 playwright webServer 启动（隔离 HOME /tmp/myagent-gui-test-home）。
 */
test("移动视口：汉堡展开侧栏抽屉，选中会话后收起", async ({ page }) => {
  // 预置一个会话（移动端抽屉默认收起，无法从 UI 新建）
  const created = await page.request.post("http://127.0.0.1:3100/api/sessions", {
    data: { task: "你好" },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto("/");
  const toggle = page.getByRole("button", { name: "打开会话列表" });
  await expect(toggle).toBeVisible();

  const sidebar = page.locator("aside.sidebar");
  await expect(sidebar).not.toHaveClass(/open/, {
    message: "抽屉默认收起",
  });

  await toggle.click();
  await expect(sidebar).toHaveClass(/open/, {
    message: "汉堡点击后抽屉展开",
  });

  // 选中会话 → 抽屉收起（workspace 持久化可能累积多个同名会话，取第一个）
  await sidebar.getByRole("button", { name: /你好/ }).first().click();
  await expect(sidebar).not.toHaveClass(/open/, {
    message: "选中会话后抽屉收起",
  });
});
