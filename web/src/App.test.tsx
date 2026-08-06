import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Config } from "./settings/types";

/**
 * 模拟真实用户输入：经原型 setter 写值（绕过 React 19 实例级 value 追踪器——
 * 直接赋值会同步 tracker，导致 onChange 的 change-detection 判定无变化），
 * 再派发 input 事件触发 React 合成 onChange。
 */
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function fixtureConfig(): Config {
  return {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        enabled: true,
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "",
        hasApiKey: true,
        models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        enabled: true,
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-test",
        hasApiKey: true,
        models: ["deepseek-v4-flash"],
      },
    ],
    models: {
      main: { providerId: "anthropic", model: "claude-sonnet-4-5" },
      cheap: { providerId: "anthropic", model: "claude-haiku-4-5" },
      explore: { providerId: "deepseek", model: "deepseek-v4-flash" },
    },
    permissions: {
      mode: "normal",
      rules: [{ effect: "deny", pattern: "Write(secrets/**)" }],
      approvalTimeoutMs: 60000,
    },
    context: {
      compactAtEstimatedTokens: 90000,
      keepRecentTokens: 20000,
    },
    server: { host: "127.0.0.1", password: "" },
  };
}

describe("设置页分区组件（App.tsx 拆分后的行为层测试）", () => {
  before(() => {
    // 同文件其他 describe 可能已注册（全局单例），幂等处理
    try {
      GlobalRegistrator.register();
    } catch {
      // 已注册：忽略
    }
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });

  async function render(props: {
    element: React.ReactElement;
  }) {
    const [{ act }, { createRoot }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(props.element);
    });
    return { container, root, act };
  }

  it("ProviderPanel：渲染供应商导航与选中编辑器，切换选中触发回调", async () => {
    const [{ ProviderPanel }] = await Promise.all([
      import("./settings/ProviderPanel"),
    ]);
    const calls = { select: [] as string[] };
    const { container, root, act } = await render({
      element: (
        <ProviderPanel
          providers={fixtureConfig().providers}
          selectedProviderId="anthropic"
          selectedIndex={0}
          scope="global"
          projectKeyOverrides={null}
          revealedKey={false}
          saving={false}
          testingKey={null}
          testResults={{}}
          onSelectProvider={(id) => calls.select.push(id)}
          onResetRevealedKey={() => undefined}
          onToggleRevealedKey={() => undefined}
          onAddProvider={() => undefined}
          onRemoveProvider={() => undefined}
          onToggleProvider={() => undefined}
          onUpdateProvider={() => undefined}
          onUpdateModel={() => undefined}
          onAddModel={() => undefined}
          onRemoveModel={() => undefined}
          onTestConnection={() => undefined}
        />
      ),
    });
    assert.equal(
      container.querySelectorAll(".provider-nav-item").length,
      2,
      "两个供应商入口",
    );
    assert.ok(container.querySelector(".provider-editor"), "选中供应商显示编辑器");
    const deepseekNav = container.querySelectorAll(".provider-nav-item")[1] as HTMLButtonElement;
    await act(async () => {
      deepseekNav.click();
    });
    assert.deepEqual(calls.select, ["deepseek"]);
    // 模型列表与测试按钮
    assert.equal(container.querySelectorAll(".model-row").length, 2);
    await act(async () => root.unmount());
  });

  it("ProviderPanel：API Key 显示/隐藏切换", async () => {
    const [{ ProviderPanel }] = await Promise.all([
      import("./settings/ProviderPanel"),
    ]);
    const toggles: boolean[] = [];
    const { container, root, act } = await render({
      element: (
        <ProviderPanel
          providers={fixtureConfig().providers}
          selectedProviderId="anthropic"
          selectedIndex={0}
          scope="global"
          projectKeyOverrides={null}
          revealedKey={false}
          saving={false}
          testingKey={null}
          testResults={{}}
          onSelectProvider={() => undefined}
          onResetRevealedKey={() => undefined}
          onToggleRevealedKey={() => toggles.push(true)}
          onAddProvider={() => undefined}
          onRemoveProvider={() => undefined}
          onToggleProvider={() => undefined}
          onUpdateProvider={() => undefined}
          onUpdateModel={() => undefined}
          onAddModel={() => undefined}
          onRemoveModel={() => undefined}
          onTestConnection={() => undefined}
        />
      ),
    });
    const keyInput = container.querySelector(".secret-field input") as HTMLInputElement;
    assert.equal(keyInput.type, "password", "默认隐藏 Key");
    await act(async () => {
      (container.querySelector(".secret-field button") as HTMLButtonElement).click();
    });
    assert.equal(toggles.length, 1, "显示/隐藏按钮触发回调");
    await act(async () => root.unmount());
  });

  it("ProviderPanel：scope=global 且项目覆盖同 id 时显示覆盖提示", async () => {
    const [{ ProviderPanel }] = await Promise.all([
      import("./settings/ProviderPanel"),
    ]);
    const { container, root, act } = await render({
      element: (
        <ProviderPanel
          providers={fixtureConfig().providers}
          selectedProviderId="deepseek"
          selectedIndex={1}
          scope="global"
          projectKeyOverrides={{
            cwd: "/repo",
            configPath: "/repo/.myagent/local.jsonc",
            providers: [{ id: "deepseek", name: "DeepSeek" }],
          }}
          revealedKey={false}
          saving={false}
          testingKey={null}
          testResults={{}}
          onSelectProvider={() => undefined}
          onResetRevealedKey={() => undefined}
          onToggleRevealedKey={() => undefined}
          onAddProvider={() => undefined}
          onRemoveProvider={() => undefined}
          onToggleProvider={() => undefined}
          onUpdateProvider={() => undefined}
          onUpdateModel={() => undefined}
          onAddModel={() => undefined}
          onRemoveModel={() => undefined}
          onTestConnection={() => undefined}
        />
      ),
    });
    assert.ok(
      container.querySelector(".key-override-hint")?.textContent?.includes("/repo"),
      "项目 Key 覆盖提示显示",
    );
    await act(async () => root.unmount());
  });

  it("RoleModelsPanel：三个角色卡片，切换供应商触发回调", async () => {
    const [{ RoleModelsPanel }] = await Promise.all([
      import("./settings/RoleModelsPanel"),
    ]);
    const calls: Array<[string, string]> = [];
    const config = fixtureConfig();
    const { container, root, act } = await render({
      element: (
        <RoleModelsPanel
          providers={config.providers}
          models={config.models}
          onSelectRoleProvider={(role, providerId) => calls.push([role, providerId])}
          onUpdateRole={() => undefined}
          onUpdateRolePricing={() => undefined}
          onAddRoleFallback={() => undefined}
          onUpdateRoleFallback={() => undefined}
          onRemoveRoleFallback={() => undefined}
        />
      ),
    });
    assert.equal(container.querySelectorAll(".role-card").length, 3);
    const mainSelect = container.querySelectorAll(".role-card select")[0] as HTMLSelectElement;
    assert.equal(mainSelect.value, "anthropic");
    await act(async () => {
      mainSelect.value = "deepseek";
      mainSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.deepEqual(calls, [["main", "deepseek"]]);
    await act(async () => root.unmount());
  });

  it("PermissionsPanel：规则列表渲染与删除回调", async () => {
    const [{ PermissionsPanel }] = await Promise.all([
      import("./settings/PermissionsPanel"),
    ]);
    const calls: Array<string> = [];
    const config = fixtureConfig();
    const { container, root, act } = await render({
      element: (
        <PermissionsPanel
          permissions={config.permissions}
          onUpdatePermission={(patch) => calls.push(JSON.stringify(patch))}
          onUpdateRule={() => undefined}
        />
      ),
    });
    assert.equal(container.querySelectorAll(".permission-rule-row").length, 1);
    assert.ok(
      (container.querySelector(".permission-rule-row input") as HTMLInputElement).value.includes("secrets"),
    );
    await act(async () => {
      (container.querySelector(".permission-rule-row button") as HTMLButtonElement).click();
    });
    assert.equal(calls.length, 1, "删除规则触发 onUpdatePermission");
    await act(async () => root.unmount());
  });

  it("ContextPanel：渲染阈值字段，修改触发回调", async () => {
    const [{ ContextPanel }] = await Promise.all([
      import("./settings/ContextPanel"),
    ]);
    const calls: Array<number> = [];
    const config = fixtureConfig();
    const { container, root, act } = await render({
      element: (
        <ContextPanel
          context={config.context}
          onChange={(recipe) => {
            const next = recipe({ ...config });
            calls.push(next.context.compactAtEstimatedTokens);
          }}
        />
      ),
    });
    const inputs = container.querySelectorAll(".behavior-grid input");
    assert.equal(inputs.length, 2);
    const threshold = inputs[0] as HTMLInputElement;
    assert.equal(threshold.value, "90000");
    await act(async () => {
      typeInto(threshold, "50000");
    });
    assert.deepEqual(calls, [50000]);
    await act(async () => root.unmount());
  });
});
