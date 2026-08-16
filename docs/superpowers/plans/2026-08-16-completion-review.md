# 任务验收链（完成审查 + 完成报告）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在模型宣布完成之后、交付用户之前加入独立审查（复用 TaskRunner + main 模型），不通过则打回主循环，通过后输出结构化完成报告。

**Architecture:** session.sendInput 主循环在 AgentLoop done 后触发审查（有写操作 / taskMode / 手动 /review 任一即触发，问答跳过）；审查 = 新 TaskRunner 运行（独立 ConversationAgentModel + main client + 只读工具 + 审查 prompt，maxTurns 12、超时 3 分钟）；结论三段式（Verdict/Issues/Unconfirmed）解析后，不通过则 `#model.addUserMessage` 打回并 continue（每轮完成最多 2 次）。`review_result` 事件驱动 CLI/Web 展示。

**Tech Stack:** TypeScript + Node ≥22（core）、React 19 + Vite（web）、node:test + tsx。

## Global Constraints

- 验证命令：`pnpm run typecheck`、`pnpm test`（core `src/**/*.test.ts` + web `web/src/**/*.test.tsx`）。全部通过才算完成。
- 审查不新增模型角色：client 取自 `ConversationAgentModel` 的 main client（新增 getter）。
- 审查打回上限 2 次/轮完成；审查结论不自动修文件（只报问题，修复走主循环）。
- 老会话（无 review_result 事件）Web 端不显示审查元素。
- 不新增依赖。

---

### Task 1: 基础能力（client getter + maxTurns 可配 + 审查结论解析）

**Files:**
- Modify: `src/core/agent-model.ts`（`get client()`）
- Modify: `src/core/task-runner.ts`（`TaskRunnerOptions.maxTurns`）
- Create: `src/core/review-runner.ts`（`parseReviewResult` + `buildReviewPrompt`）
- Test: `src/core/review-runner.test.ts`

**Interfaces:**
- Consumes: `ConversationAgentModel`（agent-model.ts:105 构造）、`TaskRunnerOptions`（task-runner.ts:56）、`EditJournalEntry`（tools/atomic-file.ts:8）
- Produces:
  - `ConversationAgentModel.get client(): ModelClient`（返回底层 API 客户端，供审查建独立上下文）
  - `TaskRunnerOptions.maxTurns?: number`（缺省 40；审查传 12）
  - `parseReviewResult(raw: string): { passed: boolean; issues: string[]; summary: string }`——宽容解析三段式，无法识别时 passed=false、issues=["审查未返回结构化结论：<原文前 200 字>"]
  - `buildReviewPrompt(input: { taskReq: string; modifiedFiles: string[]; lastVerification?: string; todos: Array<{content: string; status: string}> }): string`

- [ ] **Step 1: 写失败测试**

`src/core/review-runner.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewPrompt, parseReviewResult } from "./review-runner.js";

test("parseReviewResult：PASS 结论", () => {
  const result = parseReviewResult(
    "Verdict: PASS\n\nIssues: （无）\n\nUnconfirmed: 无",
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.issues, []);
});

test("parseReviewResult：FAIL + 问题清单", () => {
  const result = parseReviewResult(
    "Verdict: FAIL\nIssues:\n- src/App.tsx:12 待办状态未持久化\n- 缺少测试文件\nUnconfirmed: 无",
  );
  assert.equal(result.passed, false);
  assert.ok(result.issues.length >= 2);
  assert.match(result.issues[0] ?? "", /App\.tsx:12/);
});

test("parseReviewResult：无法识别时 passed=false 且说明原因", () => {
  const result = parseReviewResult("好的，我完成了。");
  assert.equal(result.passed, false);
  assert.ok((result.summary ?? "").length > 0);
});

test("buildReviewPrompt：包含任务要求、改动文件与 todo 状态", () => {
  const prompt = buildReviewPrompt({
    taskReq: "搭一个待办应用",
    modifiedFiles: ["src/App.tsx", "src/lib/todos.ts"],
    lastVerification: "pnpm build 通过",
    todos: [{ content: "写核心逻辑", status: "completed" }],
  });
  assert.match(prompt, /搭一个待办应用/);
  assert.match(prompt, /src\/App\.tsx/);
  assert.match(prompt, /pnpm build 通过/);
  assert.match(prompt, /写核心逻辑/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test src/core/review-runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/core/review-runner.ts`：

```ts
import type { TodoItem } from "./types.js";

/** 审查结论：三段式（Verdict / Issues / Unconfirmed）宽容解析 */
export function parseReviewResult(raw: string): {
  passed: boolean;
  issues: string[];
  summary: string;
} {
  const verdictLine = raw
    .split(/\r?\n/)
    .find((line) => /verdict/i.test(line));
  const passed = /verdict\s*:\s*pass/i.test(verdictLine ?? "");
  const issuesSection = raw
    .split(/\r?\n/)
    .reduce<{ collecting: boolean; lines: string[] }>(
      (acc, line) => {
        if (/^issues\s*:/i.test(line.trim())) {
          return { collecting: true, lines: acc.lines };
        }
        if (/^unconfirmed\s*:/i.test(line.trim())) {
          return { collecting: false, lines: acc.lines };
        }
        if (acc.collecting && line.trim()) {
          acc.lines.push(line.trim().replace(/^[-•*]\s*/, ""));
        }
        return acc;
      },
      { collecting: false, lines: [] },
    ).lines;
  if (!/verdict/i.test(raw)) {
    const clipped =
      raw.trim().length > 200 ? `${raw.trim().slice(0, 200)}…` : raw.trim();
    return {
      passed: false,
      issues: [`审查未返回结构化结论：${clipped}`],
      summary: clipped,
    };
  }
  return {
    passed,
    issues: passed ? [] : issuesSection,
    summary: raw.trim(),
  };
}

/** 审查 prompt：任务要求 + 改动文件 + 验证结果 + todo，要求三段式结论 */
export function buildReviewPrompt(input: {
  taskReq: string;
  modifiedFiles: string[];
  lastVerification?: string;
  todos: Array<Pick<TodoItem, "content" | "status">>;
}): string {
  const files =
    input.modifiedFiles.length > 0
      ? input.modifiedFiles.map((file) => `- ${file}`).join("\n")
      : "（无文件修改记录）";
  const todos =
    input.todos.length > 0
      ? input.todos
          .map((todo) => `- ${todo.content}（${todo.status}）`)
          .join("\n")
      : "（无任务清单）";
  return `[完成审查] 你是独立的验收审查员。原始任务要求：
${input.taskReq}

本轮改动文件：
${files}

最近验证结果：
${input.lastVerification ?? "（未运行验证命令）"}

任务清单状态：
${todos}

请逐项核对任务要求是否满足。可用 Read/Grep/Glob 查看实际文件内容，用 Bash 仅运行验证类命令（test/build/lint/typecheck）。禁止修改任何文件。

Return exactly three sections:
Verdict: PASS 或 FAIL（全部要求满足且验证通过才 PASS）
Issues: 不通过时逐条列出问题（含 文件:行号 证据）；通过时写（无）
Unconfirmed: 未能确认的部分`;
}
```

`src/core/agent-model.ts`（`#client` 字段附近，构造后加）：

```ts
  /** 底层 API 客户端（审查/独立上下文复用；同一 client 可建多个 ConversationAgentModel） */
  get client(): ModelClient {
    return this.#client;
  }
```

`src/core/task-runner.ts`：

- 构造（`this.#timeoutMs = options.timeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;` 附近）加：

```ts
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
```

- 字段声明加：`readonly #maxTurns: number;`
- `TaskRunnerOptions`（56 行附近）加：`/** 子代理最大轮数（成本兜底）；缺省 40，审查等场景可收紧 */ maxTurns?: number;`
- 常量（`DEFAULT_SUBAGENT_TIMEOUT_MS` 附近）加：`const DEFAULT_MAX_TURNS = 40;`
- `run()` 里 `maxTurns: 40`（250 行）改为 `maxTurns: this.#maxTurns`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test src/core/review-runner.test.ts && pnpm run typecheck`
Expected: PASS / 通过

- [ ] **Step 5: Commit**

```bash
git add src/core/review-runner.ts src/core/review-runner.test.ts src/core/agent-model.ts src/core/task-runner.ts
git commit -m "feat(core): 审查基础——client getter、TaskRunner maxTurns 可配、审查结论解析与 prompt"
```

---

### Task 2: 审查编排（session 触发 / 打回 / 上限 / 事件）

**Files:**
- Modify: `src/core/types.ts`（`review_result` 事件 + `SessionSummary.review`）
- Modify: `src/core/session.ts`（触发、执行、打回、`reviewNow()` 公共方法、summary.review）
- Test: `src/core/session.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseReviewResult`、`buildReviewPrompt`、`ConversationAgentModel.client`、`TaskRunnerOptions.maxTurns`
- Produces:
  - `AgentEvent` 新增 `{ type: "review_result"; passed: boolean; issues: string[]; summary: string; attempts: number }`
  - `SessionSummary.review?: { passed: boolean; attempts: number }`
  - `AgentSession.reviewNow(): Promise<void>`（手动触发审查；运行中或已审查过则忽略）

- [ ] **Step 1: 写失败测试**

`src/core/session.test.ts` 追加（用现有 `setup`/`response`/`ScriptedClient` 模式；ScriptedClient 的响应队列需覆盖审查轮——审查是第二个 AgentLoop（TaskRunner 内部），其 `next()` 也消费 ScriptedClient 队列）：

```ts
test("完成审查：有写操作的任务在 done 后触发审查，通过则正常结束", async () => {
  const { session, collector, cwd } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
    // 审查轮（TaskRunner 消费）
    response("Verdict: PASS\nIssues: （无）\nUnconfirmed: 无", {
      usage: { input: 10, output: 5, cached: 0 },
    }),
  ]);
  await session.sendInput("创建 a.txt");
  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.deepEqual(summary.review, { passed: true, attempts: 1 });
  const reviewEvents = collector.eventsOf("review_result");
  assert.equal(reviewEvents.length, 1);
  const review = reviewEvents[0]!.event as { passed: boolean };
  assert.equal(review.passed, true);
});

test("完成审查：FAIL 打回主循环，修复后再次审查通过", async () => {
  const { session, collector, cwd } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
    // 第一次审查 FAIL
    response("Verdict: FAIL\nIssues:\n- a.txt 内容不符合要求\nUnconfirmed: 无", {
      usage: { input: 10, output: 5, cached: 0 },
    }),
    // 主循环打回后模型修复（再次 Write）+ 宣布完成
    response("修复。", {
      toolCalls: [
        toolCall("write-2", "Write", "a.txt", { file_path: "a.txt", content: "world" }),
      ],
    }),
    response("修复完成。"),
    // 第二次审查 PASS
    response("Verdict: PASS\nIssues: （无）\nUnconfirmed: 无", {
      usage: { input: 10, output: 5, cached: 0 },
    }),
  ]);
  await session.sendInput("创建 a.txt");
  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.deepEqual(summary.review, { passed: true, attempts: 2 });
});

test("完成审查：连续 FAIL 超过 2 次放行并标记未通过", async () => {
  const { session } = await setup([
    response("写文件。", {
      toolCalls: [
        toolCall("write-1", "Write", "a.txt", { file_path: "a.txt", content: "hello" }),
      ],
    }),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 问题一\nUnconfirmed: 无"),
    response("再修。"),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 问题二\nUnconfirmed: 无"),
    response("还修。"),
    response("完成。"),
    response("Verdict: FAIL\nIssues:\n- 问题三\nUnconfirmed: 无"),
  ]);
  await session.sendInput("创建 a.txt");
  const summary = session.summary();
  assert.equal(summary.status, "done");
  assert.deepEqual(summary.review, { passed: false, attempts: 2 });
});

test("完成审查：纯问答（无写操作）不触发", async () => {
  const { session, collector } = await setup([
    response("1+1 等于 2。"),
  ]);
  await session.sendInput("1+1 等于几？");
  assert.equal(collector.eventsOf("review_result").length, 0);
  assert.equal(session.summary().review, undefined);
});
```

注意：`setup` 的 ScriptedClient 队列被主循环和审查轮共享，需按执行顺序排响应。若实际执行顺序与上面假设不符（如 Write 审批交互），以运行结果为准调整响应序列，断言不变。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test src/core/session.test.ts`
Expected: FAIL（review_result 不存在 / 未触发审查）

- [ ] **Step 3: 实现**

`src/core/types.ts`：

- `AgentEvent` 加（`task_end` 之后）：

```ts
  | {
      type: "review_result";
      passed: boolean;
      issues: string[];
      summary: string;
      attempts: number;
    }
```

- `SessionSummary`（找 interface 定义，session.ts 或 types.ts）加：

```ts
      /** 完成审查结论（最后一个 review_result 推导；无审查则缺省） */
      review?: { passed: boolean; attempts: number };
```

`src/core/session.ts`：

- import：`import { buildReviewPrompt, parseReviewResult } from "./review-runner.js";`
- 字段（`#reviewAttempts` 加在 `#taskModelFailed` 附近）：

```ts
  /** 本轮完成的审查循环计数（sendInput 开头重置；打回循环累计，上限 2） */
  #reviewAttempts = 0;
```

- sendInput 开头（`this.#processing = true;` 之后）重置：

```ts
    this.#reviewAttempts = 0;
```

- AgentLoop run 成功结束处（`try { await loop.run(); }` 的 try 块内、catch 之前——即 loop.run() 返回后）加审查编排。定位：`await loop.run();` 后、`} catch (error) {` 前插入：

```ts
          // 任务验收链：完成审查（有写操作 / 任务模式 / 手动触发）
          if (await this.#shouldReview(options)) {
            const review = await this.#runReview(current.text);
            if (!review.passed && this.#reviewAttempts < 2) {
              // 打回：审查结论注入主循环继续修
              const issues = review.issues.join("\n");
              this.#model.addUserMessage(
                `完成审查未通过（第 ${this.#reviewAttempts} 次）：\n${issues}\n请修复这些问题并重新验证后再次宣布完成。`,
              );
              this.#bus.emit({ type: "review_result", ...review });
              continue;
            }
            this.#bus.emit({ type: "review_result", ...review });
          }
```

- 私有方法（`initializeProject` 附近）：

```ts
  /** 完成审查触发条件：开关开 + 未超上限 + （有写操作 或 任务模式 或 手动标记） */
  async #shouldReview(options?: { taskMode?: boolean }): Promise<boolean> {
    if (this.#completionReview === false) return false;
    if (this.#reviewAttempts >= 2) return false;
    if (options?.taskMode === true) return true;
    if (this.#reviewRequested) {
      this.#reviewRequested = false;
      return true;
    }
    return this.#tools.files.journal.entries().length > 0;
  }

  /** 执行完成审查：独立 TaskRunner（main client + 只读 + 审查 prompt） */
  async #runReview(taskReq: string): Promise<{
    passed: boolean;
    issues: string[];
    summary: string;
  }> {
    this.#reviewAttempts += 1;
    const journal = this.#tools.files.journal.entries();
    const modifiedFiles = [
      ...new Set(journal.map((entry) => entry.path)),
    ];
    // 最近验证结果：最后一个 Bash tool_result 的 summary
    const lastBash = [...this.#events]
      .reverse()
      .find(
        (record) =>
          record.event.type === "tool_result" &&
          record.event.summary,
      );
    const prompt = buildReviewPrompt({
      taskReq,
      modifiedFiles,
      lastVerification:
        lastBash?.event.type === "tool_result"
          ? lastBash.event.summary
          : undefined,
      todos: this.#state.todos(),
    });
    const runner = new TaskRunner({
      cwd: this.#cwd,
      bus: this.#bus,
      client: this.#model.client,
      mode: () => this.#permissions.mode,
      rules: () => this.#permissions.rules(),
      approve: async (call, signal) =>
        await this.#approvalWaiter.wait(
          call,
          signal,
          this.#taskApprovalTimeoutMs,
        ),
      reportUsage: (usage) => {
        const costCny = usageCostCny(usage, this.#pricing?.main);
        const actualCostCny = usage.costCny ?? costCny;
        this.#bus.emit({
          type: "cost_update",
          ...usage,
          totalTokens:
            this.#state.tokens() + usage.input + usage.output,
          ...(actualCostCny === undefined
            ? {}
            : {
                costCny: actualCostCny,
                totalCostCny:
                  this.#state.costCny() + actualCostCny,
              }),
        });
      },
      recordTrace: (trace) => this.#traceStore.record(trace),
      timeoutMs: Math.min(this.#subagentTimeoutMs ?? 15 * 60_000, 3 * 60_000),
      maxTurns: 12,
    });
    const signal = new AbortController().signal;
    const result = await runner.run(
      {
        description: `[完成审查] ${taskReq.slice(0, 24)}`,
        prompt,
        writable: false,
      },
      signal,
    );
    return parseReviewResult(
      typeof result.output === "string" ? result.output : "",
    );
  }

  /** 手动触发完成审查（/review 命令；运行中或已完成审查则忽略） */
  async reviewNow(): Promise<void> {
    if (this.#processing) return;
    this.#reviewRequested = true;
    await this.sendInput("", undefined, { skipModel: true });
  }
```

- 字段加：`#reviewRequested = false;` 和 `readonly #completionReview: boolean;`（构造赋值 `options.completionReview ?? true`；AgentSessionOptions 加 `completionReview?: boolean`）
- sendInput 签名确认：`sendInput(text, displayText?, options?)`——`reviewNow` 需要"不发消息但跑审查"的路径。简化：reviewNow 直接执行审查而不经 sendInput：

```ts
  /** 手动触发完成审查（/review 命令；运行中则忽略） */
  async reviewNow(): Promise<void> {
    if (this.#processing) return;
    const lastUser = [...this.#events]
      .reverse()
      .find((record) => record.event.type === "user");
    if (!lastUser || lastUser.event.type !== "user") return;
    this.#reviewAttempts = 0;
    const review = await this.#runReview(lastUser.event.text);
    this.#bus.emit({ type: "review_result", ...review });
    if (!review.passed && this.#reviewAttempts < 2) {
      this.#model.addUserMessage(
        `完成审查未通过（第 ${this.#reviewAttempts} 次）：\n${review.issues.join("\n")}\n请修复这些问题并重新验证后再次宣布完成。`,
      );
      void this.sendInput("", undefined);
    }
  }
```

（实现时以 session.ts 实际 sendInput 签名与事件结构为准微调；测试断言不变。）

- `summary()` 加 review 推导（toolCallCount 推导附近）：

```ts
      review: (() => {
        const last = [...this.#events]
          .reverse()
          .find((record) => record.event.type === "review_result");
        if (!last || last.event.type !== "review_result") return undefined;
        return { passed: last.event.passed, attempts: last.event.attempts };
      })(),
```

- session-manager 构造 session 处传 `completionReview`（`configService` 读取 `behavior.completionReview`——若 schema 未定义则暂用默认 true 透传，Task 5 补 schema）。实现时若 ConfigService 读取路径复杂，先传 `undefined`（默认 true），Task 5 接线。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test src/core/session.test.ts && pnpm run typecheck`
Expected: PASS / 通过

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/session.ts src/core/session.test.ts
git commit -m "feat(core): 完成审查编排——触发/打回（≤2 次）/review_result 事件/summary.review"
```

---

### Task 3: CLI 展示 + /review 命令

**Files:**
- Modify: `src/cli-render.ts`（review_result 渲染）
- Modify: `src/cli.ts`（`/review` 命令）
- Test: `src/core/agent-loop.test.ts` 不涉及；CLI 命令处理无单测（回归验证）

**Interfaces:**
- Consumes: Task 2 的 `review_result` 事件、`AgentSession.reviewNow()`
- Produces: CLI 审查输出（开始/结论）；`/review` 手动触发

- [ ] **Step 1: 实现（无单测的渲染与命令）**

`src/cli-render.ts`（`task_end` 分支后加）：

```ts
    if (event.type === "review_result") {
      const icon = event.passed ? "✓" : "✗";
      const issuesText =
        event.issues.length > 0
          ? `\n` + event.issues.map((issue) => `    - ${issue}`).join("\n")
          : "";
      output(
        `\n${icon} 完成审查${event.passed ? "通过" : `未通过（第 ${event.attempts} 次）`}${issuesText}\n`,
      );
    }
```

`src/cli.ts`（`/help` 列表加一行 + `handleCommand` 加分支）：

```ts
          "/review                            对最近一次完成运行审查（验收链）",
```

```ts
    if (line === "/review") {
      await session.reviewNow();
      safePrompt();
      return;
    }
```

- [ ] **Step 2: 验证**

Run: `pnpm run typecheck`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add src/cli-render.ts src/cli.ts
git commit -m "feat(cli): 审查结论渲染 + /review 手动触发"
```

---

### Task 4: Web 展示（审查卡片 + 徽标）

**Files:**
- Modify: `src/web/api-v1.ts`（SSE 透传 review_result）
- Modify: `web/src/session-display.ts`（DisplayItem kind: "review"）
- Modify: `web/src/session-card.tsx`（审查卡片渲染）
- Modify: `web/src/SessionApp.tsx`（头部徽标：summary.review）
- Test: `web/src/session-render.test.tsx`、`src/web/api-v1.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `review_result` 事件与 `SessionSummary.review`
- Produces: Web 审查卡片（通过/未通过 + 问题清单）、会话头部"已审查"徽标

- [ ] **Step 1: 写失败测试**

`src/web/api-v1.test.ts` 现有"v1 事件映射"测试的 record 列表加一条并断言（找 `record(11, { type: "done" })` 附近）：

```ts
    record(11, { type: "done" }),
    record(12, {
      type: "review_result",
      passed: true,
      issues: [],
      summary: "Verdict: PASS",
      attempts: 1,
    }),
```

断言加（`{ seq: 11, ... type: "done" }` 之后）：

```ts
    { seq: 12, ts: "2026-08-09T10:00:00.000Z", type: "review.result", passed: true, issues: [], summary: "Verdict: PASS", attempts: 1 },
```

`web/src/session-render.test.tsx` 追加（沿用 SessionRail/渲染测试模式，直接测 buildDisplayItems）：

```tsx
describe("buildDisplayItems 审查卡片", () => {
  it("review_result 渲染为 review 卡片", async () => {
    const { buildDisplayItems } = await import("./session-display");
    const items = buildDisplayItems([
      ev(1, { type: "user", text: "搭应用" }),
      ev(2, { type: "review_result", passed: false, issues: ["src/App.tsx:12 未持久化"], summary: "Verdict: FAIL", attempts: 1 }),
    ] as never);
    const review = items.find((item) => item.kind === "review");
    assert.ok(review, "应有 review 卡片");
    assert.equal((review as { event: { passed: boolean } }).event.passed, false);
  });
});
```

（`ev` 辅助与 DisplayItem 类型以 session-render.test.tsx / session-display.ts 实际为准。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec tsx --test src/web/api-v1.test.ts && TSX_TSCONFIG_PATH=web/tsconfig.json pnpm exec tsx --test web/src/session-render.test.tsx`
Expected: FAIL（review.result 未透传 / review 卡片不存在）

- [ ] **Step 3: 实现**

`src/web/api-v1.ts`（`run.finished` case 后加）：

```ts
    case "review_result":
      return {
        ...base,
        type: "review.result",
        passed: event.passed,
        issues: event.issues,
        summary: event.summary,
        attempts: event.attempts,
      };
```

`web/src/session-display.ts`：

- DisplayItem 加：

```ts
  | {
      kind: "review";
      seq: number;
      ts: string;
      event: Record<string, any>;
    }
```

- buildDisplayItems 的 switch（找 `"review_result"` 或现有 case 位置）加：

```ts
      case "review_result":
        items.push({ kind: "review", seq, ts, event });
        break;
```

`web/src/session-card.tsx` 加审查卡片组件（文件末尾或 ToolCard 附近；渲染在 SessionStream 的 item 分发处——找 `item.kind === "subtask"` 的渲染分支参照）：

```tsx
/** 审查卡片：通过/未通过 + 问题清单 */
export function ReviewCard(props: {
  item: Extract<DisplayItem, { kind: "review" }>;
}) {
  const { event } = props.item;
  return (
    <section className={`web-review-card ${event.passed ? "passed" : "failed"}`}>
      <div className="approval-heading">
        <strong>{event.passed ? "✓ 完成审查通过" : `✗ 完成审查未通过（第 ${event.attempts} 次）`}</strong>
      </div>
      {event.issues.length > 0 && (
        <ul className="review-issues">
          {event.issues.map((issue: string, index: number) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

（渲染接入点：SessionStream 按 item.kind 分发组件——实现时找 `case "subtask"` 同层加入 `case "review"`。CSS 加到 `web/src/styles/chat.css`，参照 `.web-approval-card` 样式。）

`web/src/SessionApp.tsx` 头部徽标（`已完成` 状态标签附近，找 statusMeta/StatusTag 使用处）：

```tsx
      {selected?.review && (
        <span className={`review-badge ${selected.review.passed ? "passed" : "failed"}`}>
          {selected.review.passed ? "已审查" : "审查未通过"}
        </span>
      )}
```

（CSS：`.review-badge` 参照 `.session-tag` 风格，追加到 chat.css。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec tsx --test src/web/api-v1.test.ts && TSX_TSCONFIG_PATH=web/tsconfig.json pnpm exec tsx --test web/src/session-render.test.tsx web/src/SessionApp.test.tsx && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/api-v1.ts src/web/api-v1.test.ts web/src/session-display.ts web/src/session-card.tsx web/src/SessionApp.tsx web/src/styles/chat.css web/src/session-render.test.tsx
git commit -m "feat(web): 审查卡片 + 会话头部审查徽标 + SSE 透传"
```

---

### Task 5: 配置开关 + 全量验证 + 真实回归 + 推送

**Files:**
- Modify: `src/config/schema.ts`（`behavior.completionReview`）
- Modify: `src/core/session.ts` / `src/core/session-manager.ts`（接线配置 → AgentSessionOptions.completionReview）

**Interfaces:**
- Consumes: `BehaviorConfig`（schema.ts:64）
- Produces: `behavior.completionReview`（默认 true）生效于会话构造

- [ ] **Step 1: 实现配置**

`src/config/schema.ts` BehaviorConfig 加：

```ts
  /** 完成审查（任务验收链）：有写操作/任务完成后用独立审查跑一遍，不通过打回 */
  completionReview: boolean;
```

默认值（找 BehaviorConfig 默认对象）加：`completionReview: true,`。Schema 描述项加（若 behavior 有逐项 schema 列表则补一条：`{ key: "behavior.completionReview", type: "boolean", title: "完成审查", description: "任务完成后由独立审查核对要求，不通过自动打回（最多 2 次）", default: true, hot: false }`——以现有 behavior 项写法为准）。

`session-manager.ts`（构造 AgentSession 处，modelFactory 附近）传：

```ts
      completionReview: config.behavior?.completionReview ?? true,
```

（以 session-manager 实际读取 config 的方式为准；若 config 读取在别处，接入点相应调整。AgentSessionOptions 已在 Task 2 加 `completionReview?: boolean`。）

- [ ] **Step 2: 全量验证**

Run: `pnpm run typecheck && pnpm test && pnpm run build`
Expected: 全部通过

- [ ] **Step 3: 真实任务回归**

在 `/tmp/myagent-eval-0815/newproj7` 用 trust 档驱动（复用 drive-trust.mjs 改 PROJECT）跑"从零搭建待办应用"任务，观察：

Run: `node drive-trust.mjs`（改 PROJECT=/tmp/myagent-eval-0815/newproj7）
Expected:
- 任务完成后出现 `◇ [完成审查] …` 子代理卡片与 `✓/✗ 完成审查…` 结论行
- 审查不通过时主循环打回继续修（最多 2 次）
- CLI 结束前有完成报告信息（改动文件/验证结果/审查结论）
- 浏览器（`pnpm run web` 新实例或重启 3001）打开该会话：审查卡片渲染、头部"已审查/审查未通过"徽标

- [ ] **Step 4: Commit + 推送**

```bash
git add -A
git commit -m "feat(config): behavior.completionReview 完成审查开关 + 回归验证"  # 若无剩余改动则跳过
git push
```

---

## Self-Review 备注

- **Spec 覆盖**：触发（Task 2 shouldReview）✓；审查执行（Task 2 #runReview，复用 TaskRunner + main client + maxTurns 12 + 超时 3 分钟）✓；打回 ≤2（Task 2）✓；review_result 事件（Task 2）+ CLI（Task 3）+ Web（Task 4）✓；summary.review 徽标（Task 2/4）✓；完成报告（审查结论 + 改动文件 + 验证结果由 review_result/issues 携带，CLI/Web 展示）✓；配置开关（Task 5）✓。
- **类型一致性**：`parseReviewResult` 返回 `{ passed, issues, summary }`；`review_result` 事件同构；`SessionSummary.review = { passed, attempts }`。跨任务一致。
- **风险提示**：Task 2 测试的响应队列顺序依赖 ScriptedClient 共享队列的实际消费顺序（主循环与审查轮交替）；若运行结果与假设不符，调整响应序列而非断言。session.ts 的 sendInput 结构复杂，插入点以 `await loop.run();` 与 `} catch` 的实际代码为准。
