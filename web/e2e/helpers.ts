import { expect, type Page } from "@playwright/test";

/**
 * 新版首页即新建面板（大输入框直接上屏）：聚焦 hero 输入框。
 * 替代旧流程的「＋ 新会话」按钮点击。
 */
export async function focusHomeComposer(page: Page) {
  const input = page.getByPlaceholder("例如：检查这个项目，修复当前失败的测试");
  await expect(input).toBeVisible();
  return input;
}

/** 首页 hero 输入框的主提交按钮（绿色「发送」， aria-label=发送）。 */
export function homeSubmitButton(page: Page) {
  return page.getByRole("button", { name: "发送", exact: true });
}
