# 插件协议稳定化（myagent:* specifier）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件引用项目公共代码改用稳定 `myagent:*` specifier（loader 统一解析），与部署方式/项目结构解耦。

**Architecture:** plugin-loader 在加载插件前幂等注册自定义 resolve hook（`myagent:*` → 插件所在项目根 `src/*.ts`，委托 tsx/Node 继续解析）；示例插件改新写法；旧相对路径写法兼容。

**Tech Stack:** Node module hooks（registerHooks/register）、tsx（已注册）、TypeScript。

**工作目录**：`/Users/xuzishuo/Documents/gpt_agent-zcode`（worktree，分支 `zcode-remote-api`，已 rebase 到 e8e0e19）。所有命令在此目录执行。

## Global Constraints

- 提交只落 `zcode-remote-api` 分支，绝不提交 main；合并走 PR（见 [[zcode-branch-workflow]]）
- 解析目标统一 `<项目根>/src/*.ts`；项目根从 `context.parentURL` 推导（插件 `<root>/.myagent/tools/xx.ts` → 上两级）
- 白名单：`myagent:protocol` → `src/shared/plugin-tool.ts`；`myagent:html-text` → `src/tools/html-text.ts`；`myagent:sleep` → `src/utils/sleep.ts`
- 未知 `myagent:*` 抛明确错误（进插件 errors，面板可见）
- 注册幂等（进程级一次）；优先 `module.registerHooks`，回退 `module.register` + data URL
- 每次改动后 `pnpm run typecheck` → `pnpm test`；涉及产物 `pnpm run build`
- 开发完成后必须做**生产级浏览器模拟用户测试**（本计划 Task 4）

---

### Task 1: resolver hook + 注册机制 + 单测

**Files:**
- Modify: `src/tools/plugin-loader.ts`（新增 `ensureSpecifierResolver` + `RESOLVER_SRC` + 共享 resolve 逻辑；`loadOne` 调用）
- Test: `src/tools/plugin-loader.test.ts`

**Interfaces:**
- Produces: `ensureSpecifierResolver(): Promise<void>`（幂等）——Task 2 改造插件后依赖此机制
- Consumes: 现有 `ensureTsRuntime`（`loadOne` 先调用它再调用 resolver 注册）

- [ ] **Step 1: 写失败测试**

追加到 `src/tools/plugin-loader.test.ts`：

```ts
const MYAGENT_MODULES = {
  "src/shared/plugin-tool.ts":
    "export function definePluginTool<T>(tool: T): T { return tool; }\n",
  "src/tools/html-text.ts":
    "export function htmlToMainText(html: string): string { return html.replace(/<[^>]+>/g, ''); }\n",
  "src/utils/sleep.ts":
    "export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> { if (signal?.aborted) return; await new Promise((r) => setTimeout(r, ms)); }\n",
};

test("加载器：myagent:* 稳定 specifier 解析成功且可调用", async () => {
  const { home, project, registry } = await fixture();
  for (const [rel, content] of Object.entries(MYAGENT_MODULES)) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), content, "utf8");
  }
  await writeFile(
    path.join(project, ".myagent", "tools", "alias.ts"),
    `import { definePluginTool } from "myagent:protocol";\n` +
      `import { htmlToMainText } from "myagent:html-text";\n` +
      `import { abortableSleep } from "myagent:sleep";\n` +
      `export default definePluginTool({ name: "Alias", description: "别名导入", inputSchema: { type: "object" }, async run() { await abortableSleep(1); return { summary: htmlToMainText("<b>ok</b>") }; } });\n`,
    "utf8",
  );
  const report = await loadPluginTools(home, project, registry);
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  assert.deepEqual(report.loaded.map((item) => item.name), ["Alias"]);
  const result = await registry.execute("Alias", {}, new AbortController().signal);
  assert.equal(result.summary, "ok");
});

test("加载器：未知 myagent:* specifier 报明确错误", async () => {
  const { home, project, registry } = await fixture();
  await writeFile(
    path.join(project, ".myagent", "tools", "bad-alias.ts"),
    `import { definePluginTool } from "myagent:protocol";\n` +
      `export default definePluginTool({ name: "BadAlias", description: "未知别名", inputSchema: { type: "object" }, async run() { return { summary: "x" }; } });\n`,
    "utf8",
  );
  // 改写为未知 specifier：直接写一个引用 myagent:unknown 的插件
  await writeFile(
    path.join(project, ".myagent", "tools", "bad-alias.ts"),
    `import { definePluginTool } from "myagent:unknown";\n` +
      `export default definePluginTool({ name: "BadAlias", description: "未知别名", inputSchema: { type: "object" }, async run() { return { summary: "x" }; } });\n`,
    "utf8",
  );
  const report = await loadPluginTools(home, project, registry);
  assert.equal(report.loaded.length, 0);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!.message, /未知 myagent/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test 2>&1 | grep -E "myagent|✖" | head -8`
Expected: FAIL（`myagent:protocol` 无法解析——`ERR_UNSUPPORTED_ESM_URL_SCHEME`）

- [ ] **Step 3: 实现 resolver 注册**

在 `src/tools/plugin-loader.ts` 的 `ensureTsRuntime` 之后追加：

```ts
/**
 * myagent:* 稳定 specifier 解析器（插件协议稳定化）：
 * 插件 import "myagent:protocol" 等，由本解析器翻译到插件所在项目根 src/*.ts，
 * 与部署方式（tsx / node dist）和项目内部结构解耦。
 * 注册在 tsx 之后（后注册先调用）：tsx 先、本解析器后 → myagent:* 先命中本解析器。
 */
let specifierResolverReady = false;

/** registerHooks（Node ≥22.15）内联 resolve：与 RESOLVER_SRC 的 data URL 版本保持同一逻辑 */
async function resolveMyagentSpecifier(
  specifier: string,
  context: { parentURL?: string },
  nextResolve: (specifier: string, context: unknown) => Promise<{ url: string }>,
): Promise<{ url: string }> {
  if (!specifier.startsWith("myagent:")) {
    return nextResolve(specifier, context);
  }
  const rel = MYAGENT_MODULE_MAP[specifier];
  if (!rel) {
    throw new Error(
      `未知 myagent specifier: ${specifier}（白名单：${Object.keys(MYAGENT_MODULE_MAP).join(" / ")}）`,
    );
  }
  const parent = context.parentURL;
  if (!parent) {
    throw new Error("myagent:* 只能在插件模块内使用（缺少 parentURL）");
  }
  // 插件文件 <root>/.myagent/tools/xx.ts → 上两级 = 项目根
  const root = new URL("../..", new URL(".", parent));
  return nextResolve(new URL(rel, root).href, context);
}

/** data URL 版本（Node 22/23 的 register 路径）：逻辑与上方一致，字符串自包含 */
const MYAGENT_RESOLVER_DATA_URL = `data:text/javascript,${encodeURIComponent(
  `const MODULES = ${JSON.stringify({
    "myagent:protocol": "src/shared/plugin-tool.ts",
    "myagent:html-text": "src/tools/html-text.ts",
    "myagent:sleep": "src/utils/sleep.ts",
  })};
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("myagent:")) return nextResolve(specifier, context);
  const rel = MODULES[specifier];
  if (!rel) throw new Error("未知 myagent specifier: " + specifier + "（白名单：" + Object.keys(MODULES).join(" / ") + "）");
  if (!context.parentURL) throw new Error("myagent:* 只能在插件模块内使用（缺少 parentURL）");
  const root = new URL("../..", new URL(".", context.parentURL));
  return nextResolve(new URL(rel, root).href, context);
}`,
)}`;

const MYAGENT_MODULE_MAP: Record<string, string> = {
  "myagent:protocol": "src/shared/plugin-tool.ts",
  "myagent:html-text": "src/tools/html-text.ts",
  "myagent:sleep": "src/utils/sleep.ts",
};

async function ensureSpecifierResolver(): Promise<void> {
  if (specifierResolverReady) return;
  const moduleApi = (await import("node:module")) as {
    registerHooks?: (hooks: {
      resolve: (
        specifier: string,
        context: { parentURL?: string },
        nextResolve: (s: string, c: unknown) => Promise<{ url: string }>,
      ) => Promise<{ url: string }>;
    }) => void;
    register: (specifier: string, parentURL: string) => void;
  };
  if (typeof moduleApi.registerHooks === "function") {
    moduleApi.registerHooks({
      resolve: (specifier, context, nextResolve) =>
        resolveMyagentSpecifier(specifier, context, nextResolve),
    });
  } else {
    moduleApi.register(MYAGENT_RESOLVER_DATA_URL, import.meta.url);
  }
  specifierResolverReady = true;
}
```

在 `loadOne` 的 `await ensureTsRuntime();` 后加 `await ensureSpecifierResolver();`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test 2>&1 | grep -E "myagent|ℹ (pass|fail)" | head -6`
Expected: 新用例 PASS、全量无回归

- [ ] **Step 5: Commit**

```bash
git add src/tools/plugin-loader.ts src/tools/plugin-loader.test.ts
git commit -m "feat(plugin): myagent:* 稳定 specifier 解析——registerHooks/data URL 双路径 + 项目根推导 + 白名单"
```

---

### Task 2: 示例插件改造 + dist 集成验证

**Files:**
- Modify: `.myagent/tools/web-search.ts`、`.myagent/tools/web-fetch.ts`（import 改 `myagent:*`）

**Interfaces:**
- Consumes: Task 1 的解析机制（`myagent:protocol` / `myagent:html-text` / `myagent:sleep`）
- Produces: 示例插件新写法（Task 4 的服务/浏览器验证依赖）

- [ ] **Step 1: 改造 web-fetch.ts**

`web-fetch.ts` 头部三行改为：

```ts
import { definePluginTool } from "myagent:protocol";
import { htmlToMainText } from "myagent:html-text";
import { abortableSleep } from "myagent:sleep";
```

- [ ] **Step 2: 改造 web-search.ts**

`web-search.ts` 头部四行改为：

```ts
import {
  definePluginTool,
  type PluginToolRuntimeConfig,
} from "myagent:protocol";
import { htmlToMainText, htmlToText } from "myagent:html-text";
import { abortableSleep } from "myagent:sleep";
```

（`web-search.ts` 第 4 行原本 `import { fetchPageText } from "./web-fetch.js";` 保持不动——同目录相对导入不受影响。）

- [ ] **Step 3: 全量测试 + build + dist 集成验证**

```bash
pnpm run typecheck && pnpm test 2>&1 | grep -E "ℹ (pass|fail)" | tail -2
pnpm run build 2>&1 | grep -E "built in|error" | tail -1
cat > ./plugin-diag.mjs <<'EOF'
import os from "node:os";
import { loadPluginTools } from "./dist/tools/plugin-loader.js";
import { PluginToolRegistry } from "./dist/shared/plugin-tool.js";
const report = await loadPluginTools(os.homedir(), process.cwd(), new PluginToolRegistry());
console.log("dist 加载:", JSON.stringify(report.loaded.map((l) => l.name)), "| errors:", JSON.stringify(report.errors));
EOF
node ./plugin-diag.mjs && rm -f ./plugin-diag.mjs
```

Expected: typecheck/test 全绿；dist 纯 node 下 `loaded: ["WebFetch","WebSearch"]`、errors 空（新写法在 dist 部署下可加载）

- [ ] **Step 4: Commit**

```bash
git add .myagent/tools/web-search.ts .myagent/tools/web-fetch.ts
git commit -m "refactor(plugin): 示例插件改用 myagent:* 稳定 specifier（不再依赖 src 相对路径）"
```

---

### Task 3: 插件写法文档

**Files:**
- Modify: `docs/plugin-tools.md`

- [ ] **Step 1: 更新文档**

在 `docs/plugin-tools.md` 的插件写法章节（找到 `definePluginTool` 用法示例处）补充/修改为：

````markdown
## 插件引用项目公共代码

推荐使用稳定 specifier（与部署方式/项目结构解耦，无需写相对路径）：

```ts
import { definePluginTool } from "myagent:protocol";        // 插件协议
import { htmlToMainText } from "myagent:html-text";         // HTML 解析工具
import { abortableSleep } from "myagent:sleep";             // 可中断延时
```

白名单：`myagent:protocol` / `myagent:html-text` / `myagent:sleep`。
解析目标为插件所在项目的 `src/*.ts`（loader 自动推导项目根）。

兼容性：旧写法（`../../src/...` 相对路径）仍可加载（tsx 解析兜底），但新插件请使用 `myagent:*`。
````

- [ ] **Step 2: Commit**

```bash
git add docs/plugin-tools.md
git commit -m "docs: 插件写法规范——myagent:* 稳定 specifier 推荐 + 兼容说明"
```

---

### Task 4: 生产级验证（e2e + 浏览器模拟用户 + 全量）与收尾

**Files:**
- Create: `web/e2e/plugin-panel.spec.ts`
- Modify: 无（如 e2e 配置需调整则改 `web/playwright.config.ts`）

- [ ] **Step 1: 写生产级 e2e（插件面板完整生命周期）**

创建 `web/e2e/plugin-panel.spec.ts`：

```ts
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * 插件面板生产级回归：
 * - 启动即加载（ensurePluginsLoaded）：面板直接显示 loaded，无需点 reload
 * - 加载错误可见：坏插件文件 → reload → 面板显示错误，不静默
 * - 修复后恢复：删坏文件 → reload → 错误清零
 * 插件文件写入 e2e 工作区（webServer cwd = /tmp/myagent-gui-test-workspace），
 * 用例自清理。插件为自包含 default export（不依赖 myagent:*，避免工作区缺 src）。
 */
const WORKSPACE_TOOLS = "/tmp/myagent-gui-test-workspace/.myagent/tools";
const GOOD_PLUGIN = `export default {
  name: "PanelProbe",
  description: "e2e 面板探针插件",
  inputSchema: { type: "object" },
  async run() { return { summary: "probe ok" }; },
};\n`;
const BAD_PLUGIN = `export default { name: "PanelBroken" };\n`; // 缺 description/run

test.describe("插件面板（生产级）", () => {
  test.beforeEach(async () => {
    await rm(WORKSPACE_TOOLS, { recursive: true, force: true });
    await mkdir(WORKSPACE_TOOLS, { recursive: true });
  });
  test.afterEach(async () => {
    await rm(WORKSPACE_TOOLS, { recursive: true, force: true });
  });

  test("启动即加载：面板直接显示 loaded 插件（无需 reload）", async ({ page }) => {
    await writeFile(path.join(WORKSPACE_TOOLS, "probe.ts"), GOOD_PLUGIN, "utf8");
    await page.goto("/#plugins");
    await expect(page.getByRole("heading", { name: "已加载（1）" })).toBeVisible();
    await expect(page.getByText("PanelProbe")).toBeVisible();
    await expect(page.getByRole("heading", { name: "加载错误（0）" })).toBeVisible();
  });

  test("加载错误可见：坏插件 reload 后面板显示错误而非静默", async ({ page }) => {
    await writeFile(path.join(WORKSPACE_TOOLS, "broken.ts"), BAD_PLUGIN, "utf8");
    await page.goto("/#plugins");
    await expect(page.getByRole("heading", { name: "已加载（0）" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "加载错误（1）" })).toBeVisible();
    // 错误信息含文件名，可定位问题
    await expect(page.getByText(/broken\.ts/)).toBeVisible();
  });

  test("修复后恢复：删坏文件 reload 后错误清零", async ({ page }) => {
    await writeFile(path.join(WORKSPACE_TOOLS, "broken.ts"), BAD_PLUGIN, "utf8");
    await page.goto("/#plugins");
    await expect(page.getByRole("heading", { name: "加载错误（1）" })).toBeVisible();
    // 修复：删除坏文件 → 重新加载
    await rm(path.join(WORKSPACE_TOOLS, "broken.ts"), { force: true });
    await writeFile(path.join(WORKSPACE_TOOLS, "probe.ts"), GOOD_PLUGIN, "utf8");
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(page.getByRole("heading", { name: "已加载（1）" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "加载错误（0）" })).toBeVisible();
  });
});
```

注意：三个用例共享同一服务进程（workers: 1），`beforeEach` 清空 tools 目录保证隔离；插件加载在**服务启动时**已发生，`page.goto("/#plugins")` 读的是启动快照——`beforeEach` 在 goto 前清空目录，但服务已加载旧插件？启动时 tools 目录为空 → loaded 0；用例 1 写文件后 goto——服务不会自动重载！需要 `reload` 按钮或重启服务。**修正**：用例 1 改为 goto 后点「重新加载」再断言（与用例 3 一致）；「启动即加载」断言（loaded 无 reload）单独用真实插件验证（服务级验证，见 Step 3）。用例 1 改造：

```ts
  test("面板生命周期：加载/错误/恢复全链路", async ({ page }) => {
    // 初始：无插件 → 空态可见
    await page.goto("/#plugins");
    await expect(page.getByRole("heading", { name: "已加载（0）" })).toBeVisible();
    // 放好插件 → reload → loaded 1
    await writeFile(path.join(WORKSPACE_TOOLS, "probe.ts"), GOOD_PLUGIN, "utf8");
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(page.getByRole("heading", { name: "已加载（1）" })).toBeVisible();
    await expect(page.getByText("PanelProbe")).toBeVisible();
    // 放坏插件 → reload → loaded 1 + errors 1（错误可见不静默）
    await writeFile(path.join(WORKSPACE_TOOLS, "broken.ts"), BAD_PLUGIN, "utf8");
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(page.getByRole("heading", { name: "已加载（1）" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "加载错误（1）" })).toBeVisible();
    await expect(page.getByText(/broken\.ts/)).toBeVisible();
    // 删坏文件 → reload → 恢复
    await rm(path.join(WORKSPACE_TOOLS, "broken.ts"), { force: true });
    await page.getByRole("button", { name: "重新加载" }).click();
    await expect(page.getByRole("heading", { name: "已加载（1）" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "加载错误（0）" })).toBeVisible();
  });
```

- [ ] **Step 2: 跑 e2e（desktop + mobile project 全量）**

Run: `npx playwright test --config web/playwright.config.ts 2>&1 | tail -4`
Expected: 全量通过（原 13 + 新插件面板用例）

- [ ] **Step 3: 服务级验证 + 浏览器模拟用户测试（生产级）**

```bash
# 重启 worktree 服务（真实 HOME 由环境默认；插件在 worktree .myagent/tools，已改 myagent:*）
kill $(cat /tmp/myagent-demo.pid) 2>/dev/null; sleep 1
node dist/cli.js --web --port 3102 > /tmp/myagent-demo.log 2>&1 & echo $! > /tmp/myagent-demo.pid
sleep 2.5
curl -s http://127.0.0.1:3102/api/plugins | python3 -c "import json,sys; d=json.load(sys.stdin); print('loaded:', [p['name'] for p in d['loaded']], '| errors:', len(d['errors']))"
```

Expected: `loaded: ['WebFetch', 'WebSearch'] | errors: 0`（**启动即加载 + myagent:* 新写法在真实服务生效**）

然后用 browser-use（IAB）模拟用户走完整流程：打开 `http://127.0.0.1:3102/#plugins` → 断言「已加载（2）」+ 两个插件名 + 「加载错误（0）」→ 截图存档；再切 375px 移动视口 → 插件面板渲染正常 → 截图。**用例必须复杂/专业/生产级**：含空态、错误态（临时放坏插件 → reload → 错误可见 → 删掉恢复）、桌面/移动双视口。

- [ ] **Step 4: 全量验证 + 提交推送**

```bash
cd /Users/xuzishuo/Documents/gpt_agent-zcode
pnpm run typecheck && pnpm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && pnpm run build 2>&1 | grep -E "built in" | tail -1
git status --short
git log --oneline main..HEAD
git branch --show-current   # 必须输出 zcode-remote-api
git push origin zcode-remote-api
```

Expected: 全绿；提交全部在 `zcode-remote-api`；推送成功（若远程分支拒绝非快进，用 `git push --force-with-lease origin zcode-remote-api`——远程分支是旧 rebase 前 sha，内容已被 PR 吸收）

---

## Self-Review 记录

- **Spec 覆盖**：白名单/解析机制（Task 1）、项目根推导（Task 1 实现内）、示例插件改造（Task 2）、文档（Task 3）、测试策略全部（Task 1 单测 + Task 2 dist 集成 + Task 4 e2e/服务/浏览器）✅
- **占位符**：Task 4 Step 3 的浏览器用例标注为执行时按实际面板 DOM 断言——因浏览器验证是交互式的，计划给出断言目标（loaded 2/错误 0/双视口），执行时以 domSnapshot 事实为准 ✅
- **类型一致性**：`ensureSpecifierResolver` 命名 Task 1 定义、Task 2/4 无直接消费（机制生效）；`MYAGENT_MODULE_MAP` 与 data URL 内 MODULES 双份保持一致（注释注明）✅
