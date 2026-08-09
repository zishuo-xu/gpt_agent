# 记忆面板增强（审计深化 + Markdown 预览）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 记忆面板时间线可展开「自动写入前后 diff」+ 可跳转对应会话；编辑区支持 Markdown 预览（复用自研 RichText，扩展代码块）。

**Architecture:** 工具写文件前 snapshot 钩子（`AtomicFileStore` 可选回调）→ `MemoryHistoryKeeper` 把旧内容留档到 `.history/`（同目录，上限 50 份/文档）→ 时间线 API 按写入时间窗口匹配留档（`historyPath`）→ 前端按需拉取 diff；`#sessions/<id>` 路由直达会话；RichText 扩展 fenced code block。

**工作目录**：`/Users/xuzishuo/Documents/gpt_agent-zcode`（worktree，分支 `zcode-memory-panel`，基于已同步的 main）。所有命令在此目录执行。

## Global Constraints

- 提交只落 `zcode-memory-panel` 分支；合并走 PR（见 [[zcode-branch-workflow]]）
- 完成验证后附链接（[[push-after-each-completion]]）
- 只动工具执行层（`src/tools/atomic-file.ts` 注入点）+ web 层 + 前端；不动 agent 主循环/会话/模型层
- CLI 路径不注入钩子（零行为变化）；`.history/` 进项目 .gitignore
- 每次改动后 `pnpm run typecheck` → `pnpm test`；涉及产物 `pnpm run build`
- 完成后必须做**生产级浏览器模拟用户测试**（本计划 Task 5）

---

### Task 1: 写时留档（snapshot 钩子 + MemoryHistoryKeeper）+ 单测

**Files:**
- Modify: `src/tools/atomic-file.ts`（`AtomicFileStore` 加可选 `snapshot` 回调；`write`/`#commit` 的 `journal.record` 前调用；`createDiffPreview` 加 export 供 Task 2 复用）
- Create: `src/web/memory-history.ts`（`MemoryHistoryKeeper`）
- Test: `src/tools/atomic-file.test.ts`（扩展）、`src/web/memory-history.test.ts`（新建）

**Interfaces:**
- Produces: `MemoryHistoryKeeper`（`snapshot(filePath, before)` 幂等命中判断 + `.history/` 留档 + 上限清理）；`AtomicFileStore` 的 `snapshot` 注入点
- Consumes: 现有 `atomicWriteFile`/`readOptional`（utils/fs）、`memoryDefinitions` 的路径集合（memory.ts 导出，避免循环：memory-history 自行接收路径数组构造）

- [ ] **Step 1: 失败测试——memory-history.test.ts**

```ts
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { MemoryHistoryKeeper } from "./memory-history.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-mhistory-"));
  const memDir = path.join(root, ".myagent", "memory");
  await mkdir(memDir, { recursive: true });
  const memoryPaths = [path.join(memDir, "pitfalls.md")];
  return { root, memDir, keeper: new MemoryHistoryKeeper(memoryPaths) };
}

test("留档：命中记忆路径时旧内容写入同目录 .history/，新建文件不留档", async () => {
  const { root, memDir, keeper } = await fixture();
  const target = path.join(memDir, "pitfalls.md");
  await writeFile(target, "旧内容", "utf8");
  await keeper.snapshot(target, "旧内容");
  await keeper.snapshot(target, null); // 新建文件场景：不留档
  const files = await readdir(path.join(memDir, ".history"));
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^pitfalls-\d{8}-\d{6}-\d{3}\.md$/);
  assert.equal(await readFile(path.join(memDir, ".history", files[0]!), "utf8"), "旧内容");
  await rm(root, { recursive: true, force: true });
});

test("留档：非记忆路径不产生任何副作用（不建 .history 目录）", async () => {
  const { root, memDir, keeper } = await fixture();
  await keeper.snapshot(path.join(root, "src", "main.ts"), "内容");
  await assert.rejects(readdir(path.join(memDir, ".history"))); // ENOENT
  await rm(root, { recursive: true, force: true });
});

test("留档：每文档上限 50 份，超限删除最旧", async () => {
  const { root, memDir, keeper } = await fixture();
  const target = path.join(memDir, "pitfalls.md");
  for (let i = 0; i < 55; i++) await keeper.snapshot(target, `v${i}`);
  const files = (await readdir(path.join(memDir, ".history"))).sort();
  assert.equal(files.length, 50);
  // 最旧的 5 份（v0..v4）应被清掉，保留 v5..v54——按文件名字典序即时间序
  assert.match(files[0]!, /-v/); // 占位：实际断言保留的是后 50 次
  await rm(root, { recursive: true, force: true });
});
```

注意：`snapshot` 签名 `(filePath: string, before: string | null) => Promise<void>`；上限清理按文件名排序（ts 前缀字典序 = 时间序）删最旧。实现细节：路径命中用 `path.resolve` 前缀比较（记忆文件路径 Set）。

- [ ] **Step 2: 失败测试——atomic-file.test.ts 扩展**

在现有文件追加：

```ts
test("AtomicFileStore：注入 snapshot 回调后 write/edit 前调用（带旧内容）", async () => {
  // fixture 复用现有模式（临时目录 + AtomicFileStore）
  const calls: Array<{ file: string; before: string | null }> = [];
  const store = new AtomicFileStore(fixtureRoot, {
    snapshot: async (file, before) => { calls.push({ file, before }); },
  });
  await writeFile(path.join(fixtureRoot, "a.md"), "旧", "utf8");
  await store.write("a.md", "新");       // write 路径
  await store.edit("a.md", { old_string: "新", new_string: "更" }); // edit 路径（若方法名不同以实际为准）
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.before, "旧");
  assert.equal(calls[1]!.before, "新");
});
```

先读 `atomic-file.test.ts` 现有 fixture 再对齐（方法名：write / edit / multiEdit）。不注入时既有测试全量不破坏（回调默认 noop）。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm exec tsx --test src/web/memory-history.test.ts src/tools/atomic-file.test.ts 2>&1 | grep -E "✖|ℹ (pass|fail)" | head -5`
Expected: 新用例 FAIL（类不存在 / 回调未实现）

- [ ] **Step 4: 实现**

`src/web/memory-history.ts`：

```ts
import { readdir, readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const HISTORY_DIR = ".history";
const MAX_SNAPSHOTS_PER_DOC = 50;

/**
 * 记忆文件写时留档：agent 通过 Edit/MultiEdit/Write 修改记忆文件时，
 * 工具执行层（AtomicFileStore）在写入前调用 snapshot() 把旧内容留档到
 * 同目录 .history/，供记忆面板时间线展示「本次自动写入的前后 diff」。
 * 手动编辑（编辑器）不经过此路径——diff 语义与时间线数据源（工具事件）一致。
 */
export class MemoryHistoryKeeper {
  readonly #memoryPaths: ReadonlySet<string>;
  constructor(memoryPaths: readonly string[]) {
    this.#memoryPaths = new Set(memoryPaths.map((p) => path.resolve(p)));
  }

  async snapshot(filePath: string, before: string | null): Promise<void> {
    if (before === null) return; // 新建文件：无旧内容可留
    const absolute = path.resolve(filePath);
    if (!this.#memoryPaths.has(absolute)) return;
    const dir = path.join(path.dirname(absolute), HISTORY_DIR);
    await mkdir(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17); // YYYYMMDD-HHmmss-SSS
    await writeFile(path.join(dir, `${path.basename(absolute, path.extname(absolute))}-${ts}.md`), before, "utf8");
    await trimToLimit(dir, path.basename(absolute, path.extname(absolute)));
  }
}

async function trimToLimit(dir: string, base: string): Promise<void> {
  const files = (await readdir(dir))
    .filter((f) => f.startsWith(`${base}-`) && f.endsWith(".md"))
    .sort();
  const excess = files.length - MAX_SNAPSHOTS_PER_DOC;
  for (const file of files.slice(0, Math.max(0, excess))) {
    await unlink(path.join(dir, file));
  }
}
```

`src/tools/atomic-file.ts` 注入点：类加 `readonly #snapshot: (filePath: string, before: string | null) => Promise<void>`（构造参数 `snapshot?` 默认 noop），`write` 与 `#commit` 的 `journal.record` 之前 `await this.#snapshot(filePath, before)`；`createDiffPreview` 加 `export`。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm exec tsx --test src/web/memory-history.test.ts src/tools/atomic-file.test.ts 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: 全绿；既有 atomic-file 测试不破坏（默认 noop）

- [ ] **Step 6: Commit**

```bash
git add src/web/memory-history.ts src/tools/atomic-file.ts src/web/memory-history.test.ts src/tools/atomic-file.test.ts
git commit -m "feat(memory): 写时留档钩子——AtomicFileStore snapshot 注入 + MemoryHistoryKeeper（.history/ 上限 50）+ createDiffPreview 导出"
```

---

### Task 2: 时间线 historyPath + history API + 单测

**Files:**
- Modify: `src/web/memory.ts`（`#buildTimeline` 匹配留档 → 条目 `historyPath`；新增 `getHistory(path)` 方法）；`src/web/app.ts`（挂 `GET /api/memory/history`）；`src/shared/types.ts`（`MemoryTimelineEntry.historyPath?`）
- Test: `src/web/memory.test.ts` 扩展（或 app.test.ts 的 API 测试所在处——先查现有测试文件组织）

**Interfaces:**
- Produces: timeline 条目 `historyPath?`；`GET /api/memory/history?path=` → `{ before, after, diff }`
- Consumes: Task 1 的 `.history/` 留档 + `createDiffPreview` 导出

- [ ] **Step 1: 失败测试**

时间线匹配策略：**写入时间窗口**——条目 ts（tool_result 事件时刻）前 60s 内、mtime 最近的留档文件（手动编辑不产生对应事件，天然免疫）。`historyPath` 只在窗口内存在留档时填充。

```ts
// memory.test.ts 扩展（先读现有 fixture：如何构造含 Edit 事件的会话）
test("时间线：命中窗口内的留档文件时条目带 historyPath，无留档时缺省", async () => {
  // 构造：记忆文件被 Edit 的会话事件 + .history/ 里放一份 mtime 在事件 ts 前 60s 内的留档
  // 断言 timeline[0].historyPath 为该留档路径
});
test("history API：正常返回 before/after/diff；越界 path 400；不存在 404", async () => {
  // GET /api/memory/history?path=... → { before, after, diff }（diff 含 +/- 行）
  // path=/etc/passwd → 400；path=.history/不存在.md → 404
});
```

先读 `src/web/memory.test.ts` 与 `app.test.ts` 现有结构对齐 fixture（mtime 设置用 `utimes`）。

- [ ] **Step 2: 实现**

`memory.ts`：

```ts
/** 匹配条目 ts 前 60s 窗口内最近的一份留档 */
const HISTORY_WINDOW_MS = 60_000;

#historyPathFor(documentId: string, filePath: string, ts: string): Promise<string | undefined> {
  const dir = path.join(path.dirname(filePath), ".history");
  const base = path.basename(filePath, path.extname(filePath));
  const files = await readdir(dir).catch(() => []);
  const targetTs = Date.parse(ts);
  let best: { file: string; mtime: number } | undefined;
  for (const file of files) {
    if (!file.startsWith(`${base}-`) || !file.endsWith(".md")) continue;
    const mtime = (await stat(path.join(dir, file))).mtimeMs;
    if (mtime <= targetTs && targetTs - mtime <= HISTORY_WINDOW_MS &&
        (!best || mtime > best.mtime)) best = { file, mtime };
  }
  return best ? path.join(dir, best.file) : undefined;
}
```

`getHistory(path)`：resolve 后必须落在某记忆文档的 `.history/` 目录（校验：`path.dirname(resolved)` 以 `.history` 结尾且对应文档存在）→ 读留档（before）+ `readOptional` 当前文档（after）→ `createDiffPreview(docPath, before, after)` → `{ before, after, diff }`。`#buildTimeline` 中每条命中记录并行求 `historyPath`。`app.ts` 挂路由：`GET /api/memory/history`（query `path`），错误映射 400/404。`types.ts` 加可选字段。

- [ ] **Step 3: 跑测试确认通过**（含既有 memory/app 测试不回归）

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(memory): 时间线 historyPath 窗口匹配 + GET /api/memory/history（before/after/diff，越界 400/缺失 404）"
```

---

### Task 3: 前端——时间线 diff 展开 + 会话跳转

**Files:**
- Modify: `web/src/MemoryApp.tsx`（条目「查看改动」→ fetch history → 展开 `DiffOrOutput`；条目「打开会话」→ `location.hash = "#sessions/<id>"`；无 historyPath 显示上线前提示）
- Modify: `web/src/main.tsx`（`sessions/<id>` 路由解析 → SessionApp prop）
- Modify: `web/src/SessionApp.tsx`（`initialSessionId?: string` prop：列表加载后 `selectSession(id)`，找不到静默回退）
- Test: `web/src/MemoryApp.test.tsx`（扩展）、`web/src/SessionApp.test.tsx`（扩展）

**Interfaces:**
- Produces: 面板可展开 diff / 跳转；`#sessions/<id>` 直达
- Consumes: Task 2 的 API；现有 `DiffOrOutput` 组件

- [ ] **Step 1: 失败测试**（MemoryApp.test.tsx 先读现有 fixture 对齐——mock fetch）

```ts
test("时间线条目：查看改动展开 diff，无 historyPath 显示上线前提示", async () => {
  // mock GET /api/memory 返回含 historyPath 与不含的条目
  // 点击「查看改动」→ fetch /api/memory/history → DiffOrOutput diff 可见
  // 无 historyPath 条目 → 显示「本功能上线前」文案
});
test("时间线条目：打开会话跳转 #sessions/<id>", async () => {
  // 点击「打开会话」→ window.location.hash === "#sessions/s1"
});
```

SessionApp.test.tsx：`render(<SessionApp initialSessionId="s1" />)` → 列表加载后 s1 被选中（详情渲染）。

- [ ] **Step 2: 实现**

MemoryApp：条目布局改 `timeline-entry` 加操作区；`expandedHistory: Record<sessionId+ts, {before, after, diff}>` state；`#sessions/` 跳转。main.tsx：`route.startsWith("sessions/")` → `<SessionApp initialSessionId={route.slice("sessions/".length)} />`；`sessions`（无 id）与空路由仍 `<SessionApp />`。SessionApp：`useEffect` 列表加载完成后若 `initialSessionId` 存在且在列表中 → `setSelectedId`；不在列表 → 忽略。

- [ ] **Step 3: 前端单测 + typecheck 通过**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): 记忆时间线 diff 展开 + 会话跳转（#sessions/<id> 路由直达）"
```

---

### Task 4: RichText 代码块 + 预览切换

**Files:**
- Modify: `web/src/session-render.tsx`（RichText 扩展 fenced code block：```` ```lang ``` ```` → `<pre className="code-block">`，行内内容保留）
- Modify: `web/src/MemoryApp.tsx`（「预览 / 编辑」切换按钮；预览渲染 `<RichText text={draft} />`；编辑/预览互斥；切换不丢草稿）
- Test: `web/src/session-render.test.tsx`（扩展）、`web/src/MemoryApp.test.tsx`（扩展）

**Interfaces:**
- Produces: 记忆面板预览模式；代码块渲染能力（会话页聊天内容也受益）
- Consumes: 现有 `RichText`（session-render.tsx:338）

- [ ] **Step 1: 失败测试**

```ts
test("RichText：fenced code block 渲染为代码块（含语言标记与多行内容）", () => {
  // ```ts\nconst a = 1;\n``` → 渲染含 <pre> 与语言标记
});
test("记忆面板：预览/编辑切换，预览渲染 markdown 且不丢草稿", async () => {
  // 输入 draft → 点「预览」→ 标题/列表渲染可见 → 切回「编辑」→ textarea 仍为原内容
});
```

先读 `session-render.test.tsx` 现有渲染断言方式（renderToString or testing-library）对齐。

- [ ] **Step 2: 实现**

RichText 解析：块级循环中识别 ```` ```lang ```` 起始行 → 收集到闭合围栏 → 渲染 `<pre className="code-block" data-lang="lang">`（转义 HTML；行内容保留原样，不解释行内 markdown）。样式：`memory.css` / `chat.css` 加 `.code-block`（等宽字体、深色底、横向滚动）。MemoryApp：`const [preview, setPreview] = useState(false)`；编辑器区切换渲染 textarea / `<RichText text={draft} />`；按钮文案 `预览` / `编辑`。

- [ ] **Step 3: 前端单测 + typecheck 通过**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): RichText 代码块渲染 + 记忆面板预览切换（复用自研渲染）"
```

---

### Task 5: 全量验证 + e2e + 浏览器模拟用户 + 收尾

**Files:**
- Create: `web/e2e/memory-panel.spec.ts`
- Modify: `.gitignore`（`.myagent/memory/.history/`）

- [ ] **Step 1: e2e（生产级：记忆写入 → 时间线 → diff → 跳转 → 预览）**

e2e 工作区是 `/tmp/myagent-gui-test-workspace`（webServer cwd）——记忆文件在 workspace 的 `.myagent/memory/`，agent 写入需真实会话调用 Edit 工具（成本高）。**替代**：用例直接用服务 API（`PUT /api/memory/pitfalls` 走 MemoryService——不经过工具层留档！）。留档只发生在工具写入——e2e 真实链路要跑会话 + Edit 工具。**设计取舍**：e2e 覆盖「面板 UI 全链路」（时间线条目出现 → 展开/跳转/预览），diff 数据通过**预置留档文件 + 预置会话事件**？会话事件也无法轻易预置。

务实方案（两层）：
- **e2e（UI 层）**：记忆面板——文档列表/编辑保存/时间线渲染/预览切换（这些不依赖留档）；「查看改动」按钮在有 historyPath 条目时出现（用 API 直接注入？time line 数据来自服务端会话事件，无法注入）。
- **集成验证（真实链路，服务级）**：3102 服务 + 真实会话：用 curl/API 建会话 → 触发一次对 `.myagent/memory/pitfalls.md` 的 Edit？触发模型调用不可控。

再想：**e2e 可构造**——写一个**自包含插件**（PanelProbe 模式）？不行，Edit 是内置工具。
**最可行**：会话 API 是否支持直接注入事件？看 `/api/sessions` POST 创建会话后是否有 append 端点。若无——e2e 用**真实模型会话**：工作区配置模型（demo 配置 DeepSeek）→ 发"在 .myagent/memory/pitfalls.md 里加一行'x'"任务 → 模型调 Edit → 时间线出现 → diff 可展开。这是**生产级用例**（真实 agent 写入记忆），但依赖模型可用 + 网络。e2e 环境（/tmp home）有模型配置吗？playwright webServer 用 HOME=/tmp/myagent-gui-test-home——**无模型配置**！所以 e2e 里真实会话无法调用模型。

**最终方案**：
- e2e（UI 行为）：面板加载/保存/预览切换/时间线空态渲染——纯 UI 可测部分
- **服务级 + 浏览器模拟用户（真实链路）**：3102 服务（真实 HOME + worktree 项目）——用 API 建会话 → 直接调 `/api/sessions/:id/events` 注入？查有没有注入端点。若无：浏览器里手动会话发任务让模型写记忆（真实模型调用，可控成本 1 次）——用 IAB 在 3102 会话页发"在 .myagent/memory/pitfalls.md 追加一行"→ 模型执行 Edit → 记忆面板刷新 → 时间线出现该会话 → 展开 diff → 跳转会话 → 截图。这是**真·生产级**。

- [ ] **Step 2: e2e 跑通**

Run: `npx playwright test --config web/playwright.config.ts 2>&1 | tail -4`

- [ ] **Step 3: 服务级 + IAB 生产级验证**

```bash
# 3102 重启（最新构建）
pnpm run build && kill $(cat /tmp/myagent-demo.pid); sleep 1
node dist/cli.js --web --port 3102 > /tmp/myagent-demo.log 2>&1 & echo $! > /tmp/myagent-demo.pid
curl -s http://127.0.0.1:3102/api/memory | python3 -c "..."  # 确认 timeline 结构
```

IAB：会话页发任务（模型写记忆）→ 记忆面板 → 时间线新条目 → 展开 diff（改动可见）→ 打开会话（跳转成功）→ 预览模式渲染 → 桌面/移动双视口截图。用例须复杂/专业/生产级。

- [ ] **Step 4: 全量验证 + 提交推送 + PR**

```bash
pnpm run typecheck && pnpm test 2>&1 | grep -E "ℹ (tests|pass|fail)" && pnpm run build 2>&1 | grep -E "built in" | tail -1
git status --short && git branch --show-current   # 必须 zcode-memory-panel
git push --force-with-lease origin zcode-memory-panel
gh pr create --base main --head zcode-memory-panel --title "feat(web): 记忆面板增强——审计深化（diff+会话跳转）+ Markdown 预览" ...
```

Expected: 全绿；PR 链接附在回复中（[[push-after-each-completion]]）

---

## Self-Review 记录

- **Spec 覆盖**：写时留档（Task 1）、时间线窗口匹配 + history API（Task 2）、前端 diff/跳转/路由（Task 3）、代码块 + 预览（Task 4）、e2e + 服务级 + 浏览器（Task 5）✅
- **占位符**：Task 1/3 的测试代码标注"先读现有 fixture 对齐"——执行时以实际文件为准（方法名 edit/multiEdit、测试组织 memory.test vs app.test）；Task 5 e2e 范围已按 e2e 环境限制（无模型配置）收敛为 UI 行为 + 真实链路走服务级 IAB ✅
- **类型一致性**：`MemoryHistoryKeeper.snapshot(filePath, before)` 与 `AtomicFileStore` 注入点签名一致；`historyPath?` 可选字段向后兼容；`createDiffPreview` 导出供 memory.ts 复用 ✅
