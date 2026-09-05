# Web 界面结构简化（一主一副）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Web 主界面从「左栏 + 会话流 + 常驻右栏」三区改为「一主一副」：右栏变覆盖抽屉、新增紧凑状态条、左栏可折叠、首页新建任务精简。

**Architecture:** 状态条组件（`session-statusbar.tsx`）复用现有 props（latestTodos / fileChanges / selected），零新增数据通道；右栏 `SessionRail` 组件不变，仅容器从常驻 `<aside>` 改为 overlay 抽屉；左栏折叠状态存 localStorage；首页删除示例区、任务选项收进弹层。

**Tech Stack:** React 19 + TypeScript + 手写 CSS（web/src/styles/chat.css）；测试用 node:test + tsx + happy-dom；E2E 用 Playwright。

**Spec:** `docs/superpowers/specs/2026-09-05-web-simplify-design.md`

## Global Constraints

- 依赖管理用 pnpm（勿用 npm）。
- 任何改动后必须依次运行 `pnpm run typecheck` 和 `pnpm test`，全部通过才算完成。
- 不新增颜色；沿用 chat.css 现有深色 + 品牌绿 token（--bg / --bg-raise / --line / --green 等，以文件内实际变量名为准）。
- 不引入新的状态管理或组件库。
- Web 渲染自研路线：不引入第三方渲染库。
- 改动只提交 main，完成后直接 `git push`。
- UI 文案沿用现有简体中文风格。
- Esc 行为冲突必须处理：抽屉打开时 Esc 关抽屉、不触发中止任务。

---

### Task 1: 状态条组件 session-statusbar.tsx

**Files:**
- Create: `web/src/session-statusbar.tsx`
- Test: `web/src/session-statusbar.test.tsx`

**Interfaces:**
- Consumes: `TodoItem`、`SessionSummary`（`@shared/types.js`）；`FileChangeEntry`（`./session-rail` 已导出）；`formatTokens`（`./session-format`）
- Produces: `SessionStatusBar(props: { latestTodos: TodoItem[]; fileChanges: FileChangeEntry[]; selected: SessionSummary; onOpen: () => void })` —— 全部数据缺失时返回 `null`；点击整条调用 `onOpen`。供 Task 2 在 SessionApp 中使用。

- [ ] **Step 1: 写失败测试**

创建 `web/src/session-statusbar.test.tsx`，沿用 session-render.test.tsx 的 happy-dom 模式（`GlobalRegistrator.register()` + `IS_REACT_ACT_ENVIRONMENT` + `createRoot` + `act`）：

```tsx
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const mountedRoots: Array<{ unmount: () => void }> = [];

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1", title: "测试任务", status: "running", kind: "chat",
    permissionMode: "normal", createdAt: Date.now(), updatedAt: Date.now(),
    todos: [], toolCallCount: 3,
    totalInputTokens: 1000, totalOutputTokens: 200, totalCachedTokens: 0,
    totalCostCny: 0.12, ...overrides,
  } as never; // SessionSummary 字段多，测试只覆盖本组件读取的字段
}

describe("SessionStatusBar", () => {
  before(() => {
    GlobalRegistrator.register();
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  });
  after(() => { for (const r of mountedRoots.splice(0)) r.unmount(); });

  async function render(props: Record<string, unknown>) {
    const [{ act }, { createRoot }, { SessionStatusBar }] = await Promise.all([
      import("react"), import("react-dom/client"), import("./session-statusbar"),
    ]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    await act(async () => { root.render(<SessionStatusBar {...props} />); });
    return container;
  }

  it("计划/改动/花费三分段都渲染", async () => {
    const container = await render({
      latestTodos: [
        { id: "1", content: "定位问题", status: "completed" },
        { id: "2", content: "修复逻辑", status: "in_progress" },
      ],
      fileChanges: [{ path: "a.ts", added: 12, removed: 4 }],
      selected: makeSummary(),
      onOpen: () => undefined,
    });
    const text = container.textContent ?? "";
    assert.ok(text.includes("1/2"), "应显示计划进度");
    assert.ok(text.includes("1 文件"), "应显示文件数");
    assert.ok(text.includes("+12"), "应显示增行");
    assert.ok(text.includes("¥0.12"), "应显示费用");
  });

  it("无数据时整条不渲染", async () => {
    const container = await render({
      latestTodos: [], fileChanges: [],
      selected: makeSummary({ totalCostCny: 0, status: "idle" }),
      onOpen: () => undefined,
    });
    assert.equal(container.querySelector(".statusbar"), null);
  });

  it("点击状态条触发 onOpen", async () => {
    let opened = 0;
    const container = await render({
      latestTodos: [{ id: "1", content: "x", status: "in_progress" }],
      fileChanges: [], selected: makeSummary({ totalCostCny: 0 }),
      onOpen: () => { opened += 1; },
    });
    const bar = container.querySelector(".statusbar") as HTMLElement;
    const { act } = await import("react");
    await act(async () => { bar.click(); });
    assert.equal(opened, 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/xuzishuo/Documents/gpt_agent && TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test "web/src/session-statusbar.test.tsx"`
Expected: FAIL（`./session-statusbar` 模块不存在）

- [ ] **Step 3: 实现组件**

创建 `web/src/session-statusbar.tsx`：

```tsx
import type { SessionSummary, TodoItem } from "@shared/types.js";
import { statusMeta } from "./session-render";
import type { FileChangeEntry } from "./session-rail";

/** 会话头部下方的紧凑状态条：计划进度 / 文件改动 / 费用，点击展开详情抽屉。
 *  各分段仅在对应数据存在时渲染；全空则不渲染。 */
export function SessionStatusBar(props: {
  latestTodos: TodoItem[];
  fileChanges: FileChangeEntry[];
  selected: SessionSummary;
  onOpen: () => void;
}) {
  const todos = props.latestTodos;
  const doneCount = todos.filter((t) => t.status === "completed").length;
  const changes = props.fileChanges;
  const totalAdded = changes.reduce((s, c) => s + (c.added ?? 0), 0);
  const totalRemoved = changes.reduce((s, c) => s + (c.removed ?? 0), 0);
  const cost = props.selected.totalCostCny;

  const segments: Array<{ key: string; node: React.ReactNode }> = [];
  if (todos.length > 0) {
    segments.push({
      key: "plan",
      node: <>计划 <b>{doneCount}/{todos.length}</b></>,
    });
  }
  if (changes.length > 0) {
    segments.push({
      key: "diff",
      node: <>改动 <b>{changes.length} 文件</b>{" "}
        <b className="diff-add">+{totalAdded}</b>{" "}
        <b className="diff-del">−{totalRemoved}</b></>,
    });
  }
  if (cost > 0) {
    segments.push({ key: "cost", node: <b>¥{cost.toFixed(2)}</b> });
  }
  if (segments.length === 0) return null;

  return (
    <button
      type="button"
      className="statusbar"
      onClick={props.onOpen}
      aria-label="展开任务详情"
    >
      {segments.map((seg) => (
        <span className="statusbar-seg" key={seg.key}>{seg.node}</span>
      ))}
      <span className="statusbar-state">{statusMeta[props.selected.status].label}</span>
      <span className="statusbar-hint" aria-hidden="true">详情 ›</span>
    </button>
  );
}
```

注意：`React.ReactNode` 需要 `import type { ReactNode } from "react"` 并替换类型标注。statusMeta 从 `./session-render` 导入（SessionRail 已在用）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/xuzishuo/Documents/gpt_agent && TSX_TSCONFIG_PATH=web/tsconfig.json npx tsx --test "web/src/session-statusbar.test.tsx"`
Expected: 3 个用例全 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/xuzishuo/Documents/gpt_agent
git add web/src/session-statusbar.tsx web/src/session-statusbar.test.tsx
git commit -m "feat(web): 新增会话状态条组件"
```

---

### Task 2: 右栏改覆盖抽屉 + 警告内联

**Files:**
- Modify: `web/src/SessionApp.tsx`（SessionRail 常驻渲染 → 抽屉；autoExpanded 逻辑删除；Esc 冲突处理；警告内联）
- Modify: `web/src/session-rail.tsx`（警告块移出，组件纯展示）
- Modify: `web/src/styles/chat.css`（`.statusbar` / `.rail-drawer` / `.rail-drawer-mask`；`.session-workspace.with-rail` 与 `.session-rail` 常驻样式移除）
- Test: `web/src/SessionApp.test.tsx`（依赖 `.session-rail` 常驻的用例改为先打开抽屉）

**Interfaces:**
- Consumes: Task 1 的 `SessionStatusBar`；现有 `showDetail` state 语义改为「抽屉是否打开」
- Produces: SessionApp 内会话页布局 = SessionHeader → SessionStatusBar → chat-column；抽屉 `.rail-drawer` 覆盖于 `.sessions-main` 右侧，宽 320px

- [ ] **Step 1: 调整 SessionRail——警告移出**

`session-rail.tsx` 中删除 `zeroToolWarning` 块与「已完成但 todo 未完成」警告块（两段 `rail-todo-warning`）。组件只保留计划详情 / 文件改动 / 消耗 / 会话四卡。同时删除文件中不再使用的变量（`zeroToolWarning`）。`hasTodos`/`showDetail`/`fileChanges` 渲染条件保持不变。

注意：SessionRail 的「全空返回 null」早退逻辑要相应简化——警告不再是渲染理由：

```tsx
if (!hasTodos && !props.showDetail && fileChanges.length === 0) {
  return null;
}
```

- [ ] **Step 2: SessionApp 布局改造**

在 `SessionApp.tsx`：

1. 顶部 import 增加 `import { SessionStatusBar } from "./session-statusbar";`
2. **删除** `autoExpandedRef` 及其 useEffect（todo 出现自动展开右栏）——状态条已承担进度可见性。
3. 会话区 JSX 改为（替换现 `conversation={` 内的 `session-workspace` 结构）：

```tsx
conversation={
  <div className="session-workspace">
    <section className="chat-column">
      {workspaceInfo && <WorkspaceBanner workspace={workspaceInfo} />}
      {selected.status === "done" &&
        selected.kind === "run" &&
        selected.toolCallCount === 0 && (
          <div className="rail-todo-warning" role="alert">
            Agent 未调用任何工具就宣布完成——若这是编码/搭建任务，
            结果可能不完整，请检查或让 Agent 重新执行
          </div>
        )}
      {selected.status === "done" &&
        latestTodos.some((todo) => todo.status !== "completed") && (
          <div className="rail-todo-warning" role="alert">
            Agent 已宣布完成，但仍有{" "}
            {latestTodos.filter((todo) => todo.status !== "completed").length}{" "}
            项任务未完成或未更新
          </div>
        )}
      <SessionStatusBar
        latestTodos={latestTodos}
        fileChanges={fileChanges}
        selected={selected}
        onOpen={() => setShowDetail(true)}
      />
      <SessionStream {...现有 props 原样保留} />
      {/* runBoundsPreview + Composer 原样保留 */}
    </section>
    {showDetail && sessionView === "conversation" && (
      <>
        <div className="rail-drawer-mask" onClick={() => setShowDetail(false)} />
        <div className="rail-drawer" role="dialog" aria-label="任务详情">
          <div className="rail-drawer-head">
            <span>详情</span>
            <button
              type="button"
              className="rail-drawer-close"
              aria-label="关闭详情"
              onClick={() => setShowDetail(false)}
            >✕</button>
          </div>
          <SessionRail
            latestTodos={latestTodos}
            selected={selected}
            showDetail
            fileChanges={fileChanges}
          />
        </div>
      </>
    )}
  </div>
}
```

4. 抽屉里 SessionRail 固定 `showDetail` 为 `true`（抽屉即详情）。
5. FlightRecorder 的 `traceActions` 里「任务详情」按钮保留，点击行为由切换改为打开：`onClick={() => setShowDetail(true)}`，文案固定「任务详情」（不再是切换文案）。
6. **Esc 冲突**：现有 Esc 监听（busy 时触发 interrupt）改为：

```tsx
const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (showDetail) {
    setShowDetail(false);
    return;
  }
  if (busy) void interrupt();
};
```

注意现实现外层有 `if (!selectedId || !busy) return;` 早退——抽屉打开时可能不 busy，需把早退改为 `if (!selectedId) return;`，依赖数组加 `showDetail`。

7. `session-workspace` 的 `with-rail` 条件类名删除（不再常驻右栏）。

- [ ] **Step 3: CSS**

`web/src/styles/chat.css`：

- 删除 `.session-workspace.with-rail` 与 `.session-rail` 的常驻布局规则（含约 2613 行附近的媒体查询内对应规则），`.session-rail` 保留卡片内部样式但容器不再占网格列。
- 新增：

```css
.statusbar {
  display: flex; align-items: center; gap: 0;
  width: 100%; padding: 0 14px; height: 36px; margin-bottom: 8px;
  border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg-raise); color: var(--text-2);
  font: inherit; font-size: 12.5px; cursor: pointer; text-align: left;
}
.statusbar:hover { border-color: rgba(52, 211, 153, .3); }
.statusbar-seg { display: inline-flex; align-items: center; gap: 6px; padding: 0 12px; }
.statusbar-seg + .statusbar-seg { border-left: 1px solid var(--line); }
.statusbar-seg:first-child { padding-left: 0; }
.statusbar-seg b { color: var(--text); font-weight: 500; }
.statusbar-state { margin-left: auto; color: var(--text-faint); }
.statusbar-hint { color: var(--text-faint); font-size: 12px; padding-left: 12px; }
.rail-drawer-mask {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .45); z-index: 40;
}
.rail-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: 320px; z-index: 41;
  background: var(--bg-raise); border-left: 1px solid var(--line);
  overflow-y: auto; padding: 16px;
  animation: rail-drawer-in .2s ease;
}
@keyframes rail-drawer-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
  .rail-drawer { animation: none; }
}
.rail-drawer-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; font-weight: 600; margin-bottom: 8px;
}
.rail-drawer-close {
  border: 0; background: transparent; color: var(--text-faint);
  font-size: 15px; cursor: pointer; padding: 2px 6px; border-radius: 6px;
}
.rail-drawer-close:hover { background: var(--bg-float, rgba(255,255,255,.06)); color: var(--text); }
```

CSS 变量名以 chat.css 实际定义为准（写之前 grep `:root` 确认 `--line` `--bg-raise` `--text-faint` 等的真实名称，不一致就改用实际名）。

- [ ] **Step 4: 更新受影响的组件测试**

- `web/src/SessionApp.test.tsx`：找到依赖常驻 `.session-rail` 可见性的用例（如「任务详情」展开断言），改为：先 `container.querySelector(".statusbar")` 点击，再断言 `.rail-drawer .session-rail` 内容。
- `web/src/session-render.test.tsx` 中 `import("./session-rail")` 的用例（约 414/461/505/545/582 行）：若断言了警告文案，迁移到 SessionApp 层断言或删除（警告已移出 SessionRail）。逐条核对后调整。
- 新增用例（放在 SessionApp.test.tsx）：「点击状态条打开抽屉，Esc 关闭抽屉且不触发中止」。

- [ ] **Step 5: typecheck + test**

```bash
cd /Users/xuzishuo/Documents/gpt_agent
pnpm run typecheck && pnpm test
```

Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add web/src/SessionApp.tsx web/src/session-rail.tsx web/src/styles/chat.css web/src/SessionApp.test.tsx web/src/session-render.test.tsx
git commit -m "refactor(web): 右栏改为覆盖抽屉 + 状态条常驻"
```

---

### Task 3: 左侧栏可折叠

**Files:**
- Modify: `web/src/session-sidebar.tsx`（collapsed prop + 折叠按钮）
- Modify: `web/src/SessionApp.tsx`（collapsed state + localStorage 读写）
- Modify: `web/src/styles/chat.css`（`.session-list-sidebar.collapsed` 样式）
- Test: `web/src/SessionApp.test.tsx`（折叠切换 + localStorage 记忆断言）

**Interfaces:**
- Consumes: 无前置任务依赖
- Produces: `SessionListSidebar` 新增 props `collapsed?: boolean; onToggleCollapse?: () => void`；localStorage 键 `myagent.sidebarCollapsed`（值 `"1"` / `"0"`）

- [ ] **Step 1: 侧栏组件改造**

`session-sidebar.tsx`：

```tsx
export function SessionListSidebar(props: {
  // …现有 props 保持不变…
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  // …
  return (
    <aside
      className={`sidebar session-list-sidebar${props.open ? " open" : ""}${props.collapsed ? " collapsed" : ""}`}
    >
      <div className="brand">
        <span className="brand-mark">{/* 现有 svg 不变 */}</span>
        <span className="brand-name">MyAgent</span>
        <button
          type="button"
          className="sidebar-collapse"
          aria-label={props.collapsed ? "展开侧栏" : "折叠侧栏"}
          title={props.collapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={props.onToggleCollapse}
        >
          {props.collapsed ? "»" : "«"}
        </button>
      </div>
      {/* 其余结构不变 */}
    </aside>
  );
}
```

brand 行的文字 `<span>MyAgent</span>` 包一层 `brand-name` 以便折叠时隐藏。折叠态下：项目切换器、搜索框、分组标签、行文字、底部「设置/扩展」文字隐藏，只留图标——用 CSS 完成（`.collapsed .sidebar-search-wrap { display: none }` 等），不改 JSX 结构。注意 `.local-state` 状态点保留。

- [ ] **Step 2: SessionApp 接入**

```tsx
const [sidebarCollapsed, setSidebarCollapsed] = useState(
  () => window.localStorage.getItem("myagent.sidebarCollapsed") === "1",
);
// …
<SessionListSidebar
  // …现有 props…
  collapsed={sidebarCollapsed}
  onToggleCollapse={() =>
    setSidebarCollapsed((v) => {
      window.localStorage.setItem("myagent.sidebarCollapsed", v ? "0" : "1");
      return !v;
    })
  }
/>
```

- [ ] **Step 3: CSS**

```css
.session-list-sidebar { transition: width .18s ease; }
.session-list-sidebar.collapsed { width: 56px; }
.session-list-sidebar.collapsed .brand-name,
.session-list-sidebar.collapsed .sidebar-project-switcher,
.session-list-sidebar.collapsed .sidebar-search-wrap,
.session-list-sidebar.collapsed .task-group-label,
.session-list-sidebar.collapsed .session-line-title,
.session-list-sidebar.collapsed .nav-item span[aria-hidden] + * ,
.session-list-sidebar.collapsed .sidebar-new { /* 新建任务按钮保留 + 图标 */ }
```

折叠态具体隐藏规则以实现时 chat.css 现有类名为准；核心要求：宽度 56px、文字全隐藏、图标居中、新建任务按钮只留「+」。移动端（≤768px 媒体查询内）强制忽略 collapsed 宽度（抽屉行为不变）。

- [ ] **Step 4: 测试**

SessionApp.test.tsx 新增：渲染后点击 `.sidebar-collapse` → 断言 aside 带 `collapsed` 类且 localStorage 为 `"1"`；再渲染一个新 root（模拟刷新）→ 断言初始即折叠。

- [ ] **Step 5: typecheck + test + Commit**

```bash
pnpm run typecheck && pnpm test
git add web/src/session-sidebar.tsx web/src/SessionApp.tsx web/src/styles/chat.css web/src/SessionApp.test.tsx
git commit -m "feat(web): 左侧栏可折叠并记忆状态"
```

---

### Task 4: 首页新建任务精简

**Files:**
- Modify: `web/src/session-new-task.tsx`（删示例区；任务选项改弹层；「打开其他项目」挪入项目下拉）
- Modify: `web/src/styles/chat.css`（删 `.home-examples*` 与 `.new-task-options*` 规则，新增弹层样式）
- Test: `web/src/SessionApp.test.tsx:967` 附近（`.new-task-options` 用例改弹层）
- E2E: `web/e2e/myagent.spec.ts:167`（删 `.home-examples` 断言）、`web/e2e/plan-approval.spec.ts:129`、`web/e2e/isolated-workspace.spec.ts:123`、`web/e2e/prod-scenarios.spec.ts:25`（`.new-task-options > summary` 点击改弹层按钮）

**Interfaces:**
- Consumes: 现有 NewTaskOverlay props 不变
- Produces: 首页 footer 新增「⚙ 选项」按钮（class `new-task-opts-toggle`）+ 弹层（class `new-task-opts-pop`）；项目下拉新增 option `value="__open_other__"` 触发 `onOpenProjectPicker`

- [ ] **Step 1: 组件改造**

`session-new-task.tsx`：

1. 删除 `EXAMPLE_PROMPTS` 常量与 `{home && (<div className="home-examples">…)}` 整块。
2. `optionsDetails` 从 `<details className="new-task-options">` 改为弹层：

```tsx
const [optsOpen, setOptsOpen] = useState(false);
const optsRef = useRef<HTMLDivElement | null>(null);
useEffect(() => {
  if (!optsOpen) return;
  const onDocClick = (event: MouseEvent) => {
    if (!optsRef.current?.contains(event.target as Node)) setOptsOpen(false);
  };
  document.addEventListener("mousedown", onDocClick);
  return () => document.removeEventListener("mousedown", onDocClick);
}, [optsOpen]);

const optionsPopover = (
  <div className="new-task-opts" ref={optsRef}>
    <button
      type="button"
      className="new-task-opts-toggle"
      aria-expanded={optsOpen}
      onClick={() => setOptsOpen((v) => !v)}
    >
      ⚙ 选项
    </button>
    {optsOpen && (
      <div className="new-task-opts-pop" role="dialog" aria-label="任务选项">
        {/* 原 new-task-options-grid 内的三个 checkbox + 权限档 select 原样搬入 */}
      </div>
    )}
  </div>
);
```

3. 「打开其他项目」按钮从选项区移入 home 形态的项目 `<select>`：

```tsx
<select
  className="composer-project-chip"
  // …现有 onChange 改为：
  onChange={(event) => {
    const key = event.target.value;
    if (key === "__open_other__") {
      props.onOpenProjectPicker();
      event.target.value = props.newTaskEnv === "lobby" ? "lobby" : props.newTaskProject;
      return;
    }
    if (key === "lobby") props.onEnvChange("lobby");
    else { props.onEnvChange("project"); props.onProjectChange(key); }
  }}
>
  <option value="lobby">大厅（只读）</option>
  {props.projects.filter((p) => p.key !== "lobby").map((p) => (
    <option value={p.key} key={p.key}>{p.name}</option>
  ))}
  <option value="__open_other__">打开其他项目…</option>
</select>
```

4. 弹层放进 footerControls（「⚙ 选项」按钮位于项目选择之后）；`optionsPopover` 在 home 与 modal 两种形态都挂在 footerControls（modal 形态原本也有 optionsDetails）。弹层容器需要 `position: relative` 上下文（`.new-task-opts { position: relative }`，弹层 `position: absolute; bottom: calc(100% + 6px)`）。
5. 「隔离执行」checkbox 仍在弹层内（仅 `newTaskEnv === "project"` 时显示），条件不变。

- [ ] **Step 2: CSS**

- 删除 `.home-examples`、`.home-examples-label`、`.home-example-chip`、`.new-task-options` 相关全部规则（含 2993–3042 行附近 home 变体）。
- 新增 `.new-task-opts` / `.new-task-opts-toggle` / `.new-task-opts-pop` 样式：弹层 `position: absolute; bottom: calc(100% + 6px); left: 0; width: 260px; background: var(--bg-float); border: 1px solid var(--line); border-radius: 12px; padding: 10px; z-index: 30; box-shadow: 0 12px 32px rgba(0,0,0,.4)`。toggle 按钮沿用 `.icon-btn` 风格。

- [ ] **Step 3: 更新测试与 E2E**

- `SessionApp.test.tsx:967`：`.new-task-options` 改查 `.new-task-opts-toggle`，点击后断言弹层内「无人值守任务」checkbox 可见。
- E2E 四处 `.new-task-options > summary` 点击改为 `page.locator(".new-task-opts-toggle").click()`。
- `myagent.spec.ts:167` 的 `.home-examples` 断言删除，改为断言 `.home-examples` 不存在 + `.new-task-opts-toggle` 可见。

- [ ] **Step 4: typecheck + test + E2E + Commit**

```bash
pnpm run typecheck && pnpm test
npx playwright test --config web/playwright.config.ts --grep-invert "真实"  # 非模型用例
```

（E2E 需要真实 API Key 的用例跳过，与 CI 一致。）

```bash
git add web/src/session-new-task.tsx web/src/styles/chat.css web/src/SessionApp.test.tsx web/e2e/
git commit -m "refactor(web): 首页精简——删示例区，任务选项收进弹层"
```

---

### Task 5: 浏览器 GUI 实测 + 收尾

**Files:**
- 无新文件；验证为主

- [ ] **Step 1: 构建并启动 Web**

```bash
cd /Users/xuzishuo/Documents/gpt_agent
pnpm run web  # 或 pnpm run build && tsx src/cli.ts --web
```

- [ ] **Step 2: GUI 实测（遵循项目记忆：模拟真实用户的复杂/生产级用例）**

用 Browser Use 走完整链路：

1. 首页：确认示例区消失、「⚙ 选项」弹层开合正常、项目下拉含「打开其他项目…」、先规划开关可用。
2. 提交一个真实任务（如「读一下 README 并用一句话总结这个项目」——只读、无需审批、可快速完成）。
3. 执行中：确认状态条出现且进度更新；点击状态条打开抽屉，核对计划详情/文件改动/消耗；Esc 关闭抽屉（确认不触发中止）。
4. 完成态：确认状态条数字与抽屉内容一致；切到 Trace 视图再切回，抽屉状态不异常。
5. 左栏折叠/展开，刷新页面确认折叠状态记忆。
6. computed style 抽查：`.statusbar` 高度 36px、`.rail-drawer` 宽度 320px、折叠侧栏宽度 56px（遵循「视觉验证用 computed style 而非截图」的项目记忆）。

- [ ] **Step 3: 最终检查路由**

```bash
pnpm run typecheck && pnpm test && pnpm run build
```

- [ ] **Step 4: 提交并推送 main**

```bash
git add -A
git commit -m "chore(web): 结构简化收尾与实测修正" --allow-empty  # 无修正则不建空提交
git push origin main
```

---

## Self-Review 记录

- Spec 覆盖：§1 会话页 → Task 1/2；§2 左栏 → Task 3；§3 首页 → Task 4；§4 移动端 → Task 2 CSS（抽屉 fixed 定位天然适配）+ Task 3（媒体查询忽略 collapsed）；§5 视觉约束 → 各 Task CSS 步骤；§6 错误边界 → Task 1（空数据不渲染）/ Task 2（Esc 冲突、警告内联）；§7 测试验证 → Task 5。
- 不做的事：设置/扩展等独立页面、会话流卡片结构均未列入任何 Task。
- 类型一致性：`SessionStatusBar` props 在 Task 1 定义、Task 2 消费，签名一致；`FileChangeEntry` 复用 session-rail 导出现有类型。
