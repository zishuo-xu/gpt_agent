# 从 0 搭建项目场景 UX 优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复真实评测发现的三组问题：A 完成声明可信度与 todo 纪律、B 审批卡片信息质量、C Web 任务清单可见性。

**Architecture:** A 在系统提示词（agent-model.ts）强化"完成协议"，并在 AgentLoop 的 `turn.done` 处加软拦截（todo 有未完成项时注入提示消息，最多 2 次）。B 扩充 riskFor 规则库（先去 `cd ... &&` 前缀再匹配）并给 `ask_permission` 事件加 `purpose` 字段（取本轮最近模型文本末行），CLI/Web 审批卡片展示。C 为 Web 会话页任务清单补三态标记、默认展开与完成矛盾警告条。

**Tech Stack:** TypeScript + Node ≥22（core）、React 19 + Vite（web）、node:test + tsx 测试。

## Global Constraints

- 验证命令：`pnpm run typecheck`（core+web 两 tsconfig）、`pnpm test`（core `src/**/*.test.ts` + web `web/src/**/*.test.tsx`）。全部通过才算完成。
- 现有 `ask_permission` 事件缺少 `purpose` 时 UI 不渲染该行（老会话回放兼容）。
- done 软拦截只影响 `turn.done`（模型宣布完成），不影响 `allTerminated`（P0-4 terminate 语义）与子代理循环。
- 不新增依赖；web 样式沿用 `web/src/styles/chat.css` 现有 `rail-todo` 体系。

---

### Task 1: A-1 系统提示词强化（完成协议）

**Files:**
- Modify: `src/core/agent-model.ts:39`（PROMPT_RESPECT 常量）

**Interfaces:**
- Consumes: 无
- Produces: 新提示词段落（纯文案，无代码接口）

- [ ] **Step 1: 修改 PROMPT_RESPECT**

把 `src/core/agent-model.ts:39` 的：

```ts
const PROMPT_RESPECT = `Respect tool errors and permission denials. If a tool is denied, choose a safer alternative or explain the blocker. Keep the final response concise and include changed files and verification results.`;
```

改为：

```ts
const PROMPT_RESPECT = `Respect tool errors and permission denials. If a tool is denied, choose a safer alternative or explain the blocker. Keep the final response concise and include changed files and verification results.

Completion protocol — before declaring the task complete:
1. Update the todo list via TodoWrite: mark finished items completed, and state the reason for any item you will not do (do not silently leave items pending).
2. Run the project's configured verification commands (test / build / lint / typecheck that exist); if the project has no verification commands, state that in the final response.
3. A plan is not completion: if you planned file writes, execute them with Write/Edit before finishing.`;
```

- [ ] **Step 2: 验证**

Run: `pnpm run typecheck`
Expected: 通过（纯字符串改动，无类型影响）

- [ ] **Step 3: Commit**

```bash
git add src/core/agent-model.ts
git commit -m "feat(core): 系统提示词强化完成协议——完成前更新 todo、跑验证命令、禁止只输出计划"
```

---

### Task 2: A-2 done 软拦截（todo 未完成校验）

**Files:**
- Modify: `src/core/agent-loop.ts`（AgentModel 接口、AgentLoopOptions、AgentLoop 类）
- Modify: `src/core/session.ts:588`（AgentLoop 构造传 `getTodos`）
- Test: `src/core/agent-loop.test.ts`

**Interfaces:**
- Consumes: `TodoItem`（`src/core/types.ts`，已有 `{ id, content, status }`）；`ConversationAgentModel.addUserMessage(content)`（agent-model.ts:123 已有）；`PermissionEngine`、`ToolExecutor`（测试构造用，模式见 agent-loop.test.ts:95）
- Produces:
  - `AgentModel.addUserMessage?(content: string): void`（接口新增可选方法）
  - `AgentLoopOptions.getTodos?: () => TodoItem[]`（返回当前 todo 快照；不传则不拦截）
  - 拦截行为：`turn.done` 时若 `getTodos()` 存在非 completed 项且拦截次数 < 2 → 注入 user 消息 + `notify(warn)` 事件，不 emit done，循环继续；再次 `turn.done` 放行。第 3 次及以后直接放行。

- [ ] **Step 1: 写失败测试**

在 `src/core/agent-loop.test.ts` 的 ScriptedModel 类中加入（用于记录注入消息）：

```ts
  /** done 校验注入的 user 消息记录 */
  readonly userMessages: string[] = [];
  addUserMessage(content: string): void {
    this.userMessages.push(content);
  }
```

在文件末尾追加测试（复制现有测试的 bus/approve 构造模式）：

```ts
test("done 校验：todo 有未完成项时软拦截，再次宣布完成放行", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([{ done: true }, { done: true }]);
  const todos = [{ id: "t1", content: "写核心逻辑", status: "pending" as const }];
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
    getTodos: () => todos,
  });
  await loop.run();
  const doneEvents = events.filter((event) => event.type === "done");
  const warnEvents = events.filter(
    (event) => event.type === "notify" && event.level === "warn",
  );
  assert.equal(doneEvents.length, 1, "第一次 done 被拦截，第二次放行");
  assert.equal(warnEvents.length, 1, "拦截时发 warn 通知");
  assert.equal(model.userMessages.length, 1, "注入一条提示消息");
  assert.match(model.userMessages[0] ?? "", /仍有 1 项未完成/);
});

test("done 校验：todo 全部 completed 时直接放行", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([{ done: true }]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
    getTodos: () => [
      { id: "t1", content: "写核心逻辑", status: "completed" as const },
    ],
  });
  await loop.run();
  assert.equal(
    events.filter((event) => event.type === "done").length,
    1,
    "无未完成项直接完成",
  );
  assert.equal(model.userMessages.length, 0);
});

test("done 校验：连续 3 次宣布完成只拦截 2 次（防死循环）", async () => {
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([{ done: true }, { done: true }, { done: true }]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
    getTodos: () => [
      { id: "t1", content: "写核心逻辑", status: "pending" as const },
    ],
  });
  await loop.run();
  assert.equal(events.filter((event) => event.type === "done").length, 1);
  assert.equal(model.userMessages.length, 2, "第 3 次宣布完成不再拦截");
});
```

注意：若 `ToolExecutor` 构造签名与此不符，以 `src/core/agent-loop.test.ts:95` 现有测试的构造为准复制。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts`
Expected: FAIL（`done` 事件出现 2 次 / userMessages 为空——拦截未实现）

- [ ] **Step 3: 实现拦截**

`src/core/agent-loop.ts` 三处修改：

① AgentModel 接口（约 60 行处）加可选方法：

```ts
  /** done 校验注入提示消息（可选；未实现则跳过拦截） */
  addUserMessage?(content: string): void;
```

② AgentLoopOptions（约 84 行处）加：

```ts
  /** todo 快照读取（done 校验用；不传则跳过未完成检查） */
  getTodos?: () => TodoItem[];
```

类字段（约 152 行 `#steerRequested` 附近）加：

```ts
  /** done 软拦截次数（防死循环上限 2） */
  #doneInterventions = 0;
```

③ 新增私有方法（放在 `steer()` 方法之后）：

```ts
  /** done 软拦截：todo 有未完成项时注入提示消息并继续循环（最多 2 次）。
      返回 true 表示已拦截（不 emit done）。 */
  #interceptDoneIfNeeded(): boolean {
    const todos = this.#getTodos?.() ?? [];
    const incomplete = todos.filter(
      (todo) => todo.status !== "completed",
    );
    if (incomplete.length === 0 || this.#doneInterventions >= 2) {
      return false;
    }
    this.#doneInterventions += 1;
    const list = incomplete
      .map((todo) => `- ${todo.content}（${todo.status}）`)
      .join("\n");
    this.#model.addUserMessage?.(
      `系统提示：你宣布任务完成，但任务清单仍有 ${incomplete.length} 项未完成或未更新：\n${list}\n请先更新任务清单（完成的项标记 completed，放弃的项在回复中说明原因），并运行项目已配置的验证命令（build/test/lint/typecheck 中存在的；项目无验证命令时在回复中说明）。若确实已全部完成，直接再次宣布完成即可。`,
    );
    this.#bus.emit({
      type: "notify",
      level: "warn",
      message: `完成声明已拦截：任务清单仍有 ${incomplete.length} 项未完成或未更新，已提示 Agent 处理`,
    });
    return true;
  }
```

④ 构造函数赋值（`this.#afterToolCall = options.afterToolCall;` 之后）：

```ts
    this.#getTodos = options.getTodos;
```

字段声明（readonly 组）：`readonly #getTodos: AgentLoopOptions["getTodos"];`

⑤ `turn.done` 两处（约 606 行与 712 行）改为：

```ts
            if (turn.done) {
              if (this.#interceptDoneIfNeeded()) {
                continue;
              }
              this.#bus.emit({ type: "done" });
              return;
            }
```

（`allTerminated` 两处 602-604 / 708-710 不动。）

`src/core/session.ts` 构造处（588 行 `new AgentLoop({` 内，`beforeTurn` 之后）加：

```ts
          getTodos: () => this.#state.todos(),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts`
Expected: PASS（含新增 3 条 + 既有全部）

Run: `pnpm run typecheck`
Expected: 通过

Run: `pnpm test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-loop.ts src/core/session.ts src/core/agent-loop.test.ts
git commit -m "feat(core): done 软拦截——todo 未完成时注入提示继续，防死循环上限 2 次"
```

---

### Task 3: B-1 风险翻译规则扩充

**Files:**
- Modify: `src/core/agent-loop.ts`（`riskFor` 函数）
- Test: `src/core/agent-loop.test.ts`

**Interfaces:**
- Consumes: `riskFor(call)`（agent-loop.ts:742 附近，模块内函数）
- Produces: 无新接口；`ask_permission.risk` 文本对搭建场景更准确

- [ ] **Step 1: 写失败测试**

在 `src/core/agent-loop.test.ts` 末尾追加。`riskFor` 未导出，通过 `ask_permission` 事件断言。构造：模型先输出文本（触发 onTextDelta 需要流式——ScriptedModel 不走 onTextDelta；无妨，risk 断言不依赖文本），调用 Bash 工具，权限 normal 下 Bash 走 ask（`PermissionEngine("normal")` 无 allow 规则时 Bash 判 ask）。

```ts
test("riskFor：cd 前缀不再绕过依赖安装规则", async () => {
  const bus = new AgentEventBus();
  const askEvents: Array<{ risk: string; target: string }> = [];
  bus.subscribe((event) => {
    if (event.type === "ask_permission") {
      askEvents.push({ risk: event.risk, target: event.call.target });
    }
  });
  const model = new ScriptedModel([
    {
      text: "安装依赖。",
      toolCalls: [
        toolCall("bash-1", "Bash", "cd /tmp/proj && pnpm install", {
          command: "cd /tmp/proj && pnpm install",
        }),
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.equal(askEvents.length, 1);
  assert.equal(askEvents[0]?.risk, "将修改依赖清单与 lock 文件");
});

test("riskFor：pnpm create / git init / git commit / npx 有明确翻译", async () => {
  const bus = new AgentEventBus();
  const risks: Array<{ risk: string; target: string }> = [];
  bus.subscribe((event) => {
    if (event.type === "ask_permission") {
      risks.push({ risk: event.risk, target: event.call.target });
    }
  });
  const model = new ScriptedModel([
    {
      text: "脚手架与提交。",
      toolCalls: [
        toolCall("b1", "Bash", "pnpm create vite . --template react-ts", {
          command: "pnpm create vite . --template react-ts",
        }),
        toolCall("b2", "Bash", "git init", { command: "git init" }),
        toolCall("b3", "Bash", "git commit -m init", {
          command: "git commit -m init",
        }),
        toolCall("b4", "Bash", "npx prettier --check .", {
          command: "npx prettier --check .",
        }),
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.deepEqual(
    risks.map((item) => item.risk),
    [
      "将生成项目脚手架文件",
      "将初始化 git 仓库",
      "将创建本地提交",
      "将下载并执行包（脚手架/一次性命令）",
    ],
  );
});
```

（若测试构造与现有模式不符，以 `src/core/agent-loop.test.ts:95` 现有测试为准。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts`
Expected: FAIL（`risk` 为"命令副作用未知…"）

- [ ] **Step 3: 实现 riskFor 扩充**

`src/core/agent-loop.ts` 的 `riskFor`（约 748 行）Bash 分支开头加"去 cd 前缀"，并扩充规则。把：

```ts
    const command = (call.args as { command?: string }).command ?? call.target;
    if (/^(npm|pnpm|yarn) (install|add|remove|rm)\b/.test(command)) {
```

改为：

```ts
    const raw = (call.args as { command?: string }).command ?? call.target;
    // 去 cd 前缀后匹配：`cd <dir> && pnpm install` 与裸 `pnpm install` 同规则
    const command = raw.replace(/^(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "");
    if (/^(npm|pnpm|yarn) (install|add|remove|rm)\b/.test(command)) {
      return "将修改依赖清单与 lock 文件";
    }
    if (/^(npm|pnpm|yarn) create\b/.test(command)) {
      return "将生成项目脚手架文件";
    }
    if (/^git init\b/.test(command)) {
      return "将初始化 git 仓库";
    }
    if (/^git commit\b/.test(command)) {
      return "将创建本地提交";
    }
    if (/^(npx|pnpm dlx)\b/.test(command)) {
      return "将下载并执行包（脚手架/一次性命令）";
    }
```

注意：原代码在 `if (/^(npm|pnpm|yarn) (install|add|remove|rm)\b/.test(command))` 之后是 `return "将修改依赖清单与 lock 文件";`——新代码把该 return 移入 if 内（原代码 return 位置保持，见 agent-loop.ts:748-751 原文结构）。其余规则（git push / reset / rm / sudo / curl|sh / pkill）保持原样不动。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts`
Expected: PASS

Run: `pnpm run typecheck` && `pnpm test`
Expected: 通过 / 全绿

- [ ] **Step 5: Commit**

```bash
git add src/core/agent-loop.ts src/core/agent-loop.test.ts
git commit -m "feat(core): 风险翻译——去 cd 前缀匹配 + 脚手架/git init/commit/npx 规则"
```

---

### Task 4: B-2 审批附 Agent 目的（purpose）

**Files:**
- Modify: `src/core/types.ts:180-184`（ask_permission 事件）
- Modify: `src/core/agent-loop.ts`（`#recentModelText` 累计 + emit 时带 purpose）
- Modify: `src/cli-render.ts:44-52`（CLI 审批行显示目的）
- Modify: `src/web/api-v1.ts:358-366`（approval.request 透传 purpose）
- Modify: `web/src/session-card.tsx:148`（ApprovalCard 显示目的行）
- Test: `src/core/agent-loop.test.ts`、`src/web/api-v1.test.ts`

**Interfaces:**
- Consumes: `text_delta` 流（agent-loop.ts:399-402 已有回调）
- Produces: `AgentEvent` 的 `ask_permission` 增加可选 `purpose?: string`（末行文本，≤80 字符）；SSE `approval.request` 透传 `purpose`

- [ ] **Step 1: 写失败测试**

`src/core/agent-loop.test.ts` 末尾追加：

```ts
test("ask_permission 携带 purpose（本轮最近模型文本末行）", async () => {
  const bus = new AgentEventBus();
  const askEvents: AgentEvent[] = [];
  bus.subscribe((event) => {
    if (event.type === "ask_permission") askEvents.push(event);
  });
  const model = new ScriptedModel([
    {
      text: "模板已生成。安装依赖并加入 Vitest。",
      toolCalls: [
        toolCall("bash-1", "Bash", "pnpm install", {
          command: "pnpm install",
        }),
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.equal(askEvents.length, 1);
  const ask = askEvents[0];
  assert.ok(ask && ask.type === "ask_permission");
  assert.equal(
    ask.purpose,
    "模板已生成。安装依赖并加入 Vitest。",
  );
});

test("ask_permission 无模型文本时不携带 purpose", async () => {
  const bus = new AgentEventBus();
  const askEvents: AgentEvent[] = [];
  bus.subscribe((event) => {
    if (event.type === "ask_permission") askEvents.push(event);
  });
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("bash-1", "Bash", "pnpm install", {
          command: "pnpm install",
        }),
      ],
    },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor({
      cwd: "/tmp",
      registry: new PluginToolRegistry(),
      task: async () => ({ summary: "" }),
      readFile: async () => ({ content: "", lines: 0 }),
      writeFile: async () => ({}),
    }),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  const ask = askEvents[0];
  assert.ok(ask && ask.type === "ask_permission");
  assert.equal(ask.purpose, undefined);
});
```

`src/web/api-v1.test.ts` 追加（按该文件现有 ask_permission 断言模式，约 92 行附近）：

```ts
    // （沿用该文件现有测试构造；断言新增字段）
    assert.equal(decoded.type, "approval.request");
    assert.equal(decoded.purpose, "模板已生成。安装依赖。");
```

（若 api-v1.test.ts 现有 ask_permission 测试结构与字段名不同，以现有为准，仅补 purpose 断言。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts && pnpm exec tsx --test src/web/api-v1.test.ts`
Expected: FAIL（`ask.purpose` 为 undefined）

- [ ] **Step 3: 实现**

① `src/core/types.ts:180-184`：

```ts
      type: "ask_permission";
      call: ToolCall;
      risk: string;
      detail?: string;
      /** Agent 本轮意图（最近模型文本末行，≤80 字符；老会话无此字段） */
      purpose?: string;
    }
```

② `src/core/agent-loop.ts`：

- 字段（`#doneInterventions` 旁）：

```ts
  /** 本轮模型文本累计（ask_permission 的 purpose 来源） */
  #recentModelText = "";
```

- 工具函数（模块级，`riskFor` 附近）：

```ts
/** ask_permission.purpose：取模型文本最后一行（清理空白，截 80 字符） */
function lastTextPurpose(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  return last.length > 80 ? last.slice(-80) : last;
}
```

- 流式回调（399-402 行）里累计：

```ts
      this.#model.onTextDelta = (text) => {
        streamedText = true;
        this.#recentModelText += text;
        this.#bus.emit({ type: "text_delta", text });
      };
```

- 非流式补发（470-472 行）同样累计：

```ts
        if (turn.text && !streamedText) {
          this.#recentModelText += turn.text;
          this.#bus.emit({ type: "text_delta", text: turn.text });
        }
```

- 每轮开始重置：`while (!signal.aborted) {` 之后（409 行）加：

```ts
        this.#recentModelText = "";
```

- ask_permission emit（659-664 行）加：

```ts
            const purpose = lastTextPurpose(this.#recentModelText);
            this.#bus.emit({
              type: "ask_permission",
              call,
              risk: riskFor(call),
              ...(purpose ? { purpose } : {}),
              ...(detail ? { detail } : {}),
            });
```

③ `src/cli-render.ts`（ask_permission 分支，44-52 行）：

```ts
    if (event.type === "ask_permission") {
      approvalState.pendingCallId = event.call.id;
      output(
        `  需要审批：${event.risk}\n` +
          `  ${event.call.tool}(${event.call.target})\n` +
          `${event.purpose ? `  目的：${event.purpose}\n` : ""}` +
          `${event.detail ? `${event.detail}\n` : ""}` +
          "  输入 y/n；/allow session|project|global 可记住；/deny 可附留言。\n",
      );
    }
```

④ `src/web/api-v1.ts`（ask_permission case，358-366 行）：

```ts
    case "ask_permission":
      return {
        ...base,
        type: "approval.request",
        callId: event.call.id,
        tool: event.call.tool,
        risk: event.risk,
        ...(event.purpose ? { purpose: event.purpose } : {}),
      };
```

⑤ `web/src/session-card.tsx` ApprovalCard（148 行 `<p>{event.risk}</p>` 之后）：

```tsx
      <p>{event.risk}</p>
      {event.purpose && (
        <p className="approval-purpose">目的：{event.purpose}</p>
      )}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts && pnpm exec tsx --test src/web/api-v1.test.ts`
Expected: PASS

Run: `pnpm run typecheck` && `pnpm test`
Expected: 通过 / 全绿

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/agent-loop.ts src/cli-render.ts src/web/api-v1.ts web/src/session-card.tsx src/core/agent-loop.test.ts src/web/api-v1.test.ts
git commit -m "feat(core+web): 审批卡片附 Agent 目的（ask_permission.purpose，CLI/Web 展示）"
```

---

### Task 5: C Web 任务清单可见性

**Files:**
- Modify: `web/src/SessionApp.tsx`（`showDetail` 自动展开）
- Modify: `web/src/session-rail.tsx`（三态标记 + 完成矛盾警告条）
- Modify: `web/src/styles/chat.css`（warning 样式）
- Test: `web/src/SessionApp.test.tsx`、`web/src/session-render.test.tsx`

**Interfaces:**
- Consumes: `SessionSummary.status`（"done" 等，web/src/session-render.tsx:158 statusMeta）；`latestTodos: TodoItem[]`（SessionApp.tsx:183 useMemo）
- Produces: 任务清单项显示 `✓/→/○` 标记；存在 todo 时详情右栏自动展开；`status === "done"` 且存在非 completed todo 时显示警告条

- [ ] **Step 1: 写失败测试**

`web/src/SessionApp.test.tsx` 末尾追加（按该文件 `typeInto`/happy-dom 渲染模式）：

```tsx
describe("详情右栏自动展开", () => {
  it("会话存在 todo_update 时详情右栏自动展开", async () => {
    const { container } = await renderSessionApp([
      ev(1, { type: "user", text: "搭一个应用" }),
      ev(2, { type: "todo_update", todos: [
        { id: "t1", content: "初始化", status: "pending" },
      ] }),
    ]);
    const rail = container.querySelector(".session-rail");
    assert.ok(rail, "右栏存在");
    const heading = [...container.querySelectorAll("h2")].find(
      (node) => node.textContent === "任务清单",
    );
    assert.ok(heading, "任务清单默认展开可见");
  });
});
```

（若 SessionApp.test.tsx 无 `renderSessionApp` 辅助，用该文件现有渲染模式——happy-dom 注册 + 组件挂载。）

`web/src/session-render.test.tsx` 追加：

```tsx
describe("任务清单三态标记", () => {
  it("completed 显示 ✓、in_progress 显示 →、pending 显示 ○", () => {
    // 直接测 SessionRail 的标记逻辑若不可行，则通过 DOM 渲染断言：
    // 渲染三条不同状态的 todo，检查 .todo-check 文本分别为 ✓ / → / ○
  });
});
```

（若 SessionRail 不便直接单测，测试改为在 SessionApp.test.tsx 中随自动展开测试一并断言 `document.querySelectorAll(".todo-check")` 的文本内容。以 happy-dom 实际渲染为准。）

- [ ] **Step 2: 运行测试确认失败**

Run: `TSX_TSCONFIG_PATH=web/tsconfig.json pnpm exec tsx --test web/src/SessionApp.test.tsx web/src/session-render.test.tsx`
Expected: FAIL（无 `.session-rail` 或 todo-check 无 →/○）

- [ ] **Step 3: 实现**

① `web/src/SessionApp.tsx`：`showDetail` 初始 false（59 行）保持不变；新增 useEffect（在 `latestTodos` useMemo 定义之后）：

```tsx
  // 存在任务清单时自动展开详情右栏（从 0 搭建场景：用户默认看到进度）
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (!autoExpandedRef.current && latestTodos.length > 0) {
      autoExpandedRef.current = true;
      setShowDetail(true);
    }
  }, [latestTodos]);
```

② `web/src/session-rail.tsx` 任务清单渲染（118-131 行）：

```tsx
              props.latestTodos.map((todo) => (
                <div
                  className={`rail-todo ${todo.status}`}
                  key={todo.id}
                >
                  <span className="todo-check">
                    {todo.status === "completed"
                      ? "✓"
                      : todo.status === "in_progress"
                        ? "→"
                        : "○"}
                  </span>
                  <span>{todo.content}</span>
                </div>
              ))
```

在 `RailCard title="任务清单"` 卡片内、列表上方加警告条（`props.latestTodos.length === 0` 分支之后）：

```tsx
          <RailCard title="任务清单">
            {props.selected.status === "done" &&
              props.latestTodos.some(
                (todo) => todo.status !== "completed",
              ) && (
                <div className="rail-todo-warning">
                  Agent 已宣布完成，但仍有{" "}
                  {
                    props.latestTodos.filter(
                      (todo) => todo.status !== "completed",
                    ).length
                  }{" "}
                  项任务未完成或未更新
                </div>
              )}
            {props.latestTodos.length === 0 ? (
```

③ `web/src/styles/chat.css`（`.rail-todo.completed .todo-check` 附近）追加：

```css
.rail-todo.in_progress .todo-check {
  border-color: #759cff;
  box-shadow: 0 0 0 2px rgba(110, 155, 255, 0.14);
  color: #cfe0ff;
}

.rail-todo .todo-check {
  color: #9aa7b5;
}

.rail-todo-warning {
  margin: 8px 0;
  padding: 6px 8px;
  border: 1px solid #c98a2b;
  border-radius: 6px;
  background: rgba(201, 138, 43, 0.12);
  color: #e8b45a;
  font-size: 11px;
  line-height: 1.5;
}
```

（若 `.rail-todo.in_progress .todo-check` 已存在，仅追加 `.todo-check` 颜色与 warning 样式。）

- [ ] **Step 4: 运行测试确认通过**

Run: `TSX_TSCONFIG_PATH=web/tsconfig.json pnpm exec tsx --test web/src/SessionApp.test.tsx web/src/session-render.test.tsx`
Expected: PASS

Run: `pnpm run typecheck` && `pnpm test`
Expected: 通过 / 全绿

- [ ] **Step 5: Commit**

```bash
git add web/src/SessionApp.tsx web/src/session-rail.tsx web/src/styles/chat.css web/src/SessionApp.test.tsx web/src/session-render.test.tsx
git commit -m "feat(web): 任务清单三态标记 + 有 todo 自动展开详情 + 完成与未完成矛盾警告"
```

---

### Task 6: 全量验证与真实任务回归

**Files:**
- 无代码改动

- [ ] **Step 1: 全量验证**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: 全部通过

- [ ] **Step 2: CLI 真实任务回归**

在 `/tmp/myagent-eval-0815/newproj2`（新空目录）重跑评测任务，复用 `drive.mjs`（改 PROJECT 路径与任务为：`从零搭建一个待办应用。React + TypeScript + Vite。功能：添加/编辑/删除/筛选待办，localStorage 持久化。配 Vitest 写核心逻辑测试并跑通，保证 pnpm build 通过。`）：

Run: `node /tmp/myagent-eval-0815/drive2.mjs`
Expected:
- 不再出现"宣布完成但没写代码"：最终 todo 全部 completed 或回复中说明放弃项
- 审批卡片出现"目的："行与准确风险翻译（如"将修改依赖清单与 lock 文件"）
- 若仍出现未完成声明，CLI 输出可见 `notify(warn)` 拦截提示

- [ ] **Step 3: Web 回归观察**

浏览器打开 `http://127.0.0.1:3000`（已有实例为旧 dist，需重启后观察；若实例为旧构建，用 `pnpm run web` 起新端口实例观察）：
- 会话详情打开即见任务清单（无需点「⤢ 详情」）
- todo 项有 ✓/→/○ 标记
- 审批卡片显示"目的："行
- 若存在"已完成但 todo 未完成"的会话，任务清单显示警告条

- [ ] **Step 4: Commit 剩余 + 推送**

```bash
git add -A
git commit -m "chore: 从 0 搭建场景 UX 优化收尾"  # 若无剩余改动则跳过
git push
```

---

## Self-Review 备注

- **Spec 覆盖**：A-1 → Task 1；A-2 → Task 2；B-1 → Task 3；B-2 → Task 4；C-1/C-2/C-3 → Task 5。全部覆盖。
- **实现决策微调**（与 spec 的差异，实施后同步修正 spec）：done 拦截条件从"未完成项且本轮未调用 TodoWrite"简化为"存在非 completed 项即拦截（≤2 次）"——覆盖模型"更新了部分 todo 但仍宣布完成"的变体，行为更可预测。
- **类型一致性**：`getTodos` / `addUserMessage?` / `purpose?` / `.todo-check` 三态文本在各任务间一致。
