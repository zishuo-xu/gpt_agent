import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * 插件面板生产级回归（插件协议稳定化配套验证）：
 * - 空态提示 → 加载 → 错误可见（不静默，含文件名）→ 修复恢复 全生命周期
 * - 禁用/启用切换 + 重新加载后状态持久化（plugins.json 落盘）
 * 服务器由 playwright webServer 启动（cwd=/tmp/myagent-gui-test-workspace，
 * HOME=/tmp/myagent-gui-test-home）。用例自管理工作区 .myagent/tools：
 * beforeEach 清空、afterEach 清理，不依赖也不污染其他 spec。
 * 探针插件为自包含 default export（工作区无 src/，不能用 myagent:* 导入）。
 */
const WORKSPACE_TOOLS = "/tmp/myagent-gui-test-workspace/.myagent/tools";

const GOOD_PLUGIN = `export default {
  name: "PanelProbe",
  description: "e2e 面板探针：返回探测结果",
  inputSchema: { type: "object" },
  async run() { return { summary: "probe ok" }; },
};\n`;

const BAD_PLUGIN = `export default { name: "PanelBroken" };\n`;

test.describe("插件面板（生产级回归）", () => {
  test.beforeEach(async () => {
    await rm(WORKSPACE_TOOLS, { recursive: true, force: true });
    await mkdir(WORKSPACE_TOOLS, { recursive: true });
  });

  test.afterEach(async () => {
    await rm(WORKSPACE_TOOLS, { recursive: true, force: true });
  });

  test("全生命周期：空态 → 加载 → 错误可见 → 修复恢复", async ({ page }) => {
    // 1) 空态：无插件时面板显示空提示（不报错不静默）
    await page.goto("/#plugins");
    await expect(
      page.getByRole("heading", { name: "已加载（0）" }),
    ).toBeVisible();
    await expect(
      page.getByText("未加载插件。放入 .myagent/tools/ 并点「重新加载」。"),
    ).toBeVisible();

    // 2) 放入合法插件 → 重新加载 → loaded 1（热重载生效，无需重启 server）
    await writeFile(path.join(WORKSPACE_TOOLS, "probe.ts"), GOOD_PLUGIN, "utf8");
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(
      page.getByRole("heading", { name: "已加载（1）" }),
    ).toBeVisible();
    await expect(page.getByText("PanelProbe")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "加载错误（0）" }),
    ).toBeVisible();

    // 3) 追加坏插件（缺 description/run）→ 重新加载 → 已加载保持 1、错误 1 且含文件名
    await writeFile(path.join(WORKSPACE_TOOLS, "broken.ts"), BAD_PLUGIN, "utf8");
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(
      page.getByRole("heading", { name: "已加载（1）" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "加载错误（1）" }),
    ).toBeVisible();
    await expect(page.getByText(/broken\.ts/)).toBeVisible();
    await expect(page.getByText(/缺少 description 或 run/)).toBeVisible();

    // 4) 修复：删除坏文件 → 重新加载 → 错误清零、插件恢复
    await rm(path.join(WORKSPACE_TOOLS, "broken.ts"), { force: true });
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(
      page.getByRole("heading", { name: "已加载（1）" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "加载错误（0）" }),
    ).toBeVisible();
  });

  test("禁用/启用：面板切换 + 重新加载后状态持久化", async ({ page }) => {
    await writeFile(path.join(WORKSPACE_TOOLS, "probe.ts"), GOOD_PLUGIN, "utf8");
    await page.goto("/#plugins");
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(
      page.getByRole("heading", { name: "已加载（1）" }),
    ).toBeVisible();

    // 禁用 → 按钮切「已禁用」（模型将不可见）
    await page.getByRole("button", { name: "启用中" }).click();
    await expect(page.getByRole("button", { name: "已禁用" })).toBeVisible();

    // 重新加载（模拟用户重启/刷新后）→ 禁用状态保留（pluginDisabled 已持久化）
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(
      page.getByRole("heading", { name: "已加载（1）" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "已禁用" })).toBeVisible();

    // 重新启用 → 恢复「启用中」
    await page.getByRole("button", { name: "已禁用" }).click();
    await expect(page.getByRole("button", { name: "启用中" })).toBeVisible();
  });
});
