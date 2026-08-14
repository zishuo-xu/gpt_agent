# P0 四项（并行安全 + 压缩文件操作 + afterToolCall/terminate）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实施 Pi 借鉴清单 P0-1 ~ P0-4：写工具声明顺序执行消除并行写竞争、按路径互斥的写入队列、文件操作清单进压缩摘要、afterToolCall 钩子与工具级 terminate 语义。

**Architecture:** 内置顺序工具集 + 插件 executionMode 声明驱动 AgentLoop 批次并行判定（含任一顺序工具整批串行）；AtomicFileTools 内按路径 promise 链互斥；AgentLoop 累计 FileOps 并经 AgentModel.setFileOps 注入压缩摘要；AgentLoopOptions.afterToolCall 在事件 emit 前改写结果，批次全部 terminate 结束循环。

**Tech Stack:** TypeScript + Node 22，node:test + tsx，无新依赖。

## Global Constraints

- 不引入任何新依赖（依赖收敛原则）。
- `ToolDefinition`（wire 形状）不得新增字段——供应商对未知字段可能有校验，执行模式元数据放独立常量与插件协议。
- 全部改动遵循 TDD：先写失败测试，再实现。
- 每任务结束运行 `pnpm exec tsx --test <文件>` 验证本任务测试。
- 提交信息前缀 `feat(core)` / `feat(tools)` / `test` 与仓库惯例一致（中文，冒号分隔）。
- 文档 `设计方案/Pi对比与借鉴.md` §4 的 P0 行在全部完成后标记已落地。

---

### Task 1: P0-1 工具级执行模式（executionMode）

**Files:**
- Modify: `src/shared/tool-names.ts`（新增 looksReadOnlyToolName）
- Modify: `src/tools/tool-definitions.ts`（新增 SEQUENTIAL_TOOL_NAMES）
- Modify: `src/shared/plugin-tool.ts`（PluginTool.executionMode + 注册校验）
- Modify: `src/tools/executor.ts`（isParallelSafe 方法）
- Modify: `src/core/agent-loop.ts`（批次判定 + looksReadOnlyTool 迁移）
- Test: `src/tools/executor.test.ts`、`src/core/agent-loop.test.ts`

**Interfaces:**
- Consumes: `ToolExecutor` 构造签名 `(cwd, files?, todos?, taskHandler?, plugins?)`（executor.test.ts:375 已示范）
- Produces: `ToolExecutor.isParallelSafe(tool: string): boolean`；`looksReadOnlyToolName(name: string): boolean`（shared/tool-names.ts）；`SEQUENTIAL_TOOL_NAMES: ReadonlySet<ToolName>`（tool-definitions.ts）；`PluginTool.executionMode?: "sequential" | "parallel"`

- [ ] **Step 1: 写失败测试（executor.test.ts 追加三个测试）**

在 `src/tools/executor.test.ts` 末尾追加：

```ts
test("isParallelSafe：内置写工具顺序、只读工具并行", () => {
  const executor = new ToolExecutor(process.cwd());
  assert.equal(executor.isParallelSafe("Edit"), false);
  assert.equal(executor.isParallelSafe("MultiEdit"), false);
  assert.equal(executor.isParallelSafe("Write"), false);
  assert.equal(executor.isParallelSafe("Bash"), false);
  assert.equal(executor.isParallelSafe("Read"), true);
  assert.equal(executor.isParallelSafe("Grep"), true);
  assert.equal(executor.isParallelSafe("Glob"), true);
  assert.equal(executor.isParallelSafe("TodoWrite"), true);
  assert.equal(executor.isParallelSafe("Task"), true);
});

test("isParallelSafe：插件声明优先，缺省按只读名启发式", () => {
  const registry = new PluginToolRegistry();
  registry.register({
    name: "WebSearchX",
    description: "网络搜索",
    inputSchema: {},
    run: async () => ({ summary: "ok" }),
  });
  registry.register({
    name: "MutateState",
    description: "修改外部状态",
    inputSchema: {},
    executionMode: "parallel",
    run: async () => ({ summary: "ok" }),
  });
  registry.register({
    name: "ReadFromDB",
    description: "读数据库",
    inputSchema: {},
    executionMode: "sequential",
    run: async () => ({ summary: "ok" }),
  });
  const executor = new ToolExecutor(
    process.cwd(),
    undefined,
    undefined,
    undefined,
    registry,
  );
  assert.equal(executor.isParallelSafe("WebSearchX"), true, "只读名启发式 → 并行");
  assert.equal(executor.isParallelSafe("MutateState"), true, "声明 parallel 覆盖启发式");
  assert.equal(executor.isParallelSafe("ReadFromDB"), false, "声明 sequential 覆盖启发式");
});

test("插件 executionMode 非法值注册被拒绝", () => {
  const registry = new PluginToolRegistry();
  assert.throws(
    () =>
      registry.register({
        name: "BadMode",
        description: "非法模式",
        inputSchema: {},
        executionMode: "banana",
        run: async () => ({ summary: "ok" }),
      }),
    /executionMode/,
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec tsx --test src/tools/executor.test.ts`
Expected: FAIL（`executor.isParallelSafe is not a function`）

- [ ] **Step 3: 实现**

`src/shared/tool-names.ts` 追加（文件末尾）：

```ts
/** 插件工具只读启发式动词表：工具名按驼峰/分隔符切段后，任一动词段命中即视为只读。
    与权限风险翻译（agent-loop riskFor）和插件并行缺省判定（executor.isParallelSafe）共用。 */
const READONLY_VERBS = new Set([
  "list", "read", "get", "search", "query", "fetch", "lookup", "status",
  "info", "show", "inspect", "view", "describe", "check", "ping", "stat",
  "peek", "head", "tail", "whoami", "print", "echo", "find", "ls", "dir",
  "tree", "schema", "version", "help", "cat",
]);

export function looksReadOnlyToolName(toolName: string): boolean {
  const segments = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return segments.some((segment) => READONLY_VERBS.has(segment));
}
```

`src/tools/tool-definitions.ts` 追加（`EXPLORE_TOOL_NAMES` 之后）：

```ts
/** 顺序执行的内置工具（P0-1）：并行模式下含任一此类工具的批次整批退化为串行。
    写类工具需互斥（防同批写竞争），Bash 副作用不可并行。 */
export const SEQUENTIAL_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "Bash",
]);
```

`src/shared/plugin-tool.ts` 的 `PluginTool` 接口（`timeoutMs` 之后）新增：

```ts
  /** 执行模式（P0-1）：sequential = 该工具必须串行执行（含此类工具的批次整批退化为串行）；
      parallel = 可与其他工具并发。缺省按工具名只读启发式判定（只读名 → parallel，否则 → sequential）。 */
  executionMode?: "sequential" | "parallel";
```

`register` 方法内（`isToolName` 冲突检查之后）新增校验：

```ts
    if (
      tool.executionMode !== undefined &&
      tool.executionMode !== "sequential" &&
      tool.executionMode !== "parallel"
    ) {
      throw new Error(
        `插件“${tool.name}”executionMode 非法：${String(tool.executionMode)}（仅支持 sequential / parallel）`,
      );
    }
```

`src/tools/executor.ts`：
- 顶部 import 追加（在现有 `import { pluginToolRegistry, ... } from "../shared/plugin-tool.js";` 附近）：

```ts
import {
  isToolName,
  looksReadOnlyToolName,
} from "../shared/tool-names.js";
import { SEQUENTIAL_TOOL_NAMES } from "./tool-definitions.js";
```
- `ToolExecutor` 类内新增方法（`setFileWrittenListener` 之后）：

```ts
  /** 工具是否可并行执行（P0-1）：内置查顺序集；插件查声明，缺省按只读名启发式
      （保守：非只读名视为顺序，避免未知插件写操作混入并行批次） */
  isParallelSafe(tool: string): boolean {
    if (isToolName(tool)) return !SEQUENTIAL_TOOL_NAMES.has(tool);
    const plugin = this.#plugins.get(tool);
    if (plugin?.executionMode === "parallel") return true;
    if (plugin?.executionMode === "sequential") return false;
    return looksReadOnlyToolName(tool);
  }
```

`src/core/agent-loop.ts`：
- 删除文件末尾私有函数 `looksReadOnlyTool`（含 `READONLY_VERBS`，约 705-718 行）。
- `riskFor` 中调用改为：

```ts
  if (!isToolName(call.tool) && looksReadOnlyToolName(call.tool)) {
```
- 顶部 import 追加 `looksReadOnlyToolName`（已有 `import { isToolName, TOOL_NAMES } from "../shared/tool-names.js";` 改为）：

```ts
import {
  isToolName,
  looksReadOnlyToolName,
  TOOL_NAMES,
} from "../shared/tool-names.js";
```
- 并行批次条件（run() 内 `this.#parallelTools &&` 那一串条件）追加最后一项：

```ts
        if (
          this.#parallelTools &&
          calls.length > 1 &&
          !signal.aborted &&
          !this.#steerRequested &&
          calls.every((call) => this.#tools.isParallelSafe(call.tool)) &&
        ) {
```
（删除原有的 `) {` 行尾，整体成为 `calls.every(...) ) {`）

- [ ] **Step 4: 运行通过**

Run: `pnpm exec tsx --test src/tools/executor.test.ts src/core/agent-loop.test.ts`
Expected: executor 三个新测试 PASS；agent-loop 中旧的 Bash 并行测试预期 FAIL（Bash 已顺序化）——进入 Step 5 修复。

- [ ] **Step 5: 修复既有并行测试（Bash×2 → 插件工具×2）**

`src/core/agent-loop.test.ts` 中"两个 0.4s 命令应并发执行"的测试（约 720-775 行，`parallelTools: true` 且两个 `sleep 0.4` Bash）：把两个 Bash call 替换为两个插件工具 `SlowProbe` 调用，并注入注册表：

```ts
test("并行模式：全并行安全工具批次并发执行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-par-"));
  const registry = new PluginToolRegistry();
  registry.register({
    name: "SlowProbe",
    description: "慢速只读探测",
    inputSchema: {},
    executionMode: "parallel",
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { summary: "probe done" };
    },
  });
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      text: "",
      toolCalls: [
        toolCall("p1", "SlowProbe", "probe-1", {}),
        toolCall("p2", "SlowProbe", "probe-2", {}),
      ],
    },
    { text: "并发完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(
      directory,
      undefined,
      undefined,
      undefined,
      registry,
    ),
    approve: async () => ({ granted: true }),
    parallelTools: true,
  });
  const startedAt = Date.now();
  await loop.run();
  const elapsed = Date.now() - startedAt;
  assert.ok(
    elapsed < 700,
    `两个 0.4s 只读探测应并发执行（实际 ${elapsed}ms）`,
  );
  assert.equal(
    events.filter((event) => event.type === "tool_result").length,
    2,
  );
  // 并行路径也 emit tool_call（事件流完整，崩溃恢复时 tool_result 可配对）
  assert.equal(
    events.filter((event) => event.type === "tool_call").length,
    2,
    "并行执行应补发 tool_call 事件",
  );
  const callEvents = events
    .filter((event) => event.type === "tool_call")
    .map(
      (event) =>
        (event as Extract<AgentEvent, { type: "tool_call" }>).call.id,
    );
  assert.deepEqual(
    callEvents.sort(),
    ["p1", "p2"],
    "tool_call 事件覆盖全部并发调用",
  );
});
```
文件顶部 import 追加 `import { PluginToolRegistry } from "../shared/plugin-tool.js";`（若无）。

同时新增顺序退化测试（同文件末尾）：

```ts
test("并行模式：批次含顺序工具（Bash）时整批退化为串行", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-serial-batch-"));
  await writeFile(path.join(directory, "a.txt"), "before\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      text: "",
      toolCalls: [
        toolCall("b1", "Bash", "sleep 0.3", { command: "sleep 0.3" }),
        toolCall("b2", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "串行完成", done: true },
  ]);
  const tools = new ToolExecutor(directory);
  const executionOrder: string[] = [];
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executionOrder.push(`start:${call.id}`);
    const result = await originalExecute(call, signal, options);
    executionOrder.push(`end:${call.id}`);
    return result;
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    parallelTools: true,
  });
  await loop.run();
  // 批次含顺序工具（Bash）→ 整批串行：Read 必须等 Bash 结束后才开始
  assert.deepEqual(executionOrder, [
    "start:b1",
    "end:b1",
    "start:b2",
    "end:b2",
  ]);
});
```

- [ ] **Step 6: 运行通过**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts src/tools/executor.test.ts`
Expected: 全 PASS

- [ ] **Step 7: 提交**

```bash
git add src/shared/tool-names.ts src/tools/tool-definitions.ts src/shared/plugin-tool.ts src/tools/executor.ts src/core/agent-loop.ts src/tools/executor.test.ts src/core/agent-loop.test.ts
git commit -m "feat(core): P0-1 工具级执行模式——写工具声明顺序执行，并行批次自动退化串行"
```

---

### Task 2: P0-2 写入串行化队列（同路径互斥）

**Files:**
- Modify: `src/tools/atomic-file.ts`（#withPathLock + 三个写方法包锁）
- Test: `src/tools/atomic-file.test.ts`

**Interfaces:**
- Consumes: `AtomicFileTools` 构造 `(journal?, options?)`；`edit/multiEdit/write` 现有签名不变
- Produces: 无新公开 API；同路径写互斥、异路径写并行的行为保证

- [ ] **Step 1: 写失败测试（atomic-file.test.ts 追加）**

在 `src/tools/atomic-file.test.ts` 末尾追加（若文件顶部缺 `mkdtemp`/`readFile`/`writeFile`/`os`/`path` import 则补齐）：

```ts
test("同路径并发写互斥：快照延迟下无 lost update", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-"));
  const file = path.join(directory, "x.txt");
  await writeFile(file, "A\n", "utf8");
  const tools = new AtomicFileTools(new EditJournal(), {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    },
  });
  await tools.read(file);
  // 无互斥时：两个 edit 都读到 "A\n"，第二个的 old_string "B" 未找到而抛错
  await Promise.all([
    tools.edit(file, "A", "A\nB", undefined, undefined),
    tools.edit(file, "B", "B\nC", undefined, undefined),
  ]);
  assert.equal(await readFile(file, "utf8"), "A\nB\nC\n");
});

test("不同路径并发写互不等待", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-par-"));
  const fileA = path.join(directory, "a.txt");
  const fileB = path.join(directory, "b.txt");
  await writeFile(fileA, "A", "utf8");
  await writeFile(fileB, "B", "utf8");
  const tools = new AtomicFileTools(new EditJournal(), {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  });
  await tools.read(fileA);
  await tools.read(fileB);
  const startedAt = Date.now();
  await Promise.all([
    tools.write(fileA, "A2"),
    tools.write(fileB, "B2"),
  ]);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 180, `异路径写应并行（各 100ms 快照，实际 ${elapsed}ms）`);
});

test("锁等待期间 abort 快速失败，不执行写", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-lock-abort-"));
  const file = path.join(directory, "x.txt");
  await writeFile(file, "A", "utf8");
  const tools = new AtomicFileTools(new EditJournal(), {
    snapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  });
  await tools.read(file);
  const slow = tools.edit(file, "A", "A\nB", undefined, undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const controller = new AbortController();
  const queued = tools.edit(
    file,
    "A\nB",
    "A\nB\nC",
    undefined,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(queued, { name: "AbortError" });
  await slow;
  assert.equal(await readFile(file, "utf8"), "A\nB\n");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec tsx --test src/tools/atomic-file.test.ts`
Expected: 新测试 FAIL（并发 edit 抛 "old_string 未找到" / 并行用时 ≥180ms / queued 未在 abort 时拒绝）

- [ ] **Step 3: 实现（atomic-file.ts）**

类字段（`#snapshot` 之后）新增：

```ts
  /** 同路径写互斥队列（P0-2）：按 resolve 后路径分桶的 promise 链。
      同路径写串行（防 lost update；web server 同进程多会话共享实例时同样生效），
      不同路径写互不等待。 */
  readonly #writeQueues = new Map<string, Promise<void>>();
```

类内新增方法（`#assertRead` 之前）：

```ts
  /** 按路径互斥执行写动作：同路径前驱 settle（成功或失败）后才执行；
      前驱失败不级联（互斥 ≠ 级联失败）。锁等待期间 signal 已 abort 则快速失败。 */
  #withPathLock<T>(
    filePath: string,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = path.resolve(filePath);
    const previous = this.#writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(action, action);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.#writeQueues.set(key, done);
    void done.then(() => {
      if (this.#writeQueues.get(key) === done) {
        this.#writeQueues.delete(key);
      }
    });
    if (signal) {
      assertNotAborted(signal);
    }
    return run;
  }
```

三个写方法包锁（锁覆盖"读旧内容 → 计算 → 快照 → 落盘 → journal"全流程，防 lost update）：

```ts
  async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll = false,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#withPathLock(filePath, signal, async () => {
      this.#assertRead(filePath);
      const before = await readFile(filePath, "utf8");
      const after = applyEdit(before, oldString, newString, replaceAll);
      await this.#commit(filePath, before, after, signal);
      return createDiffPreview(filePath, before, after);
    });
  }
```

```ts
  async multiEdit(
    filePath: string,
    edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#withPathLock(filePath, signal, async () => {
      this.#assertRead(filePath);
      const before = await readFile(filePath, "utf8");
      const after = applyMultiEdit(before, edits);
      await this.#commit(filePath, before, after, signal);
      return createDiffPreview(filePath, before, after);
    });
  }
```

```ts
  async write(
    filePath: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.#withPathLock(filePath, signal, async () => {
      const before = await readOptional(filePath);
      if (before !== null) this.#assertRead(filePath);
      const preview =
        before === null
          ? createNewFilePreview(filePath, content)
          : createDiffPreview(filePath, before, content);
      await this.#snapshot(filePath, before);
      await atomicWriteFile(filePath, content, signal ? { signal } : {});
      this.journal.record({
        path: filePath,
        beforeHash: hash(before),
        afterHash: hash(content),
        beforeContent: before,
      });
      this.#readSet.add(path.resolve(filePath));
      return preview;
    });
  }
```

注意：`#withPathLock` 的 `assertNotAborted(signal)` 在**入队后立即**检查一次（快速失败），action 内部原有的 abort 检查保留（锁等待期间 abort 时，action 启动前再失败一次——`edit` 体内首个 await 前无检查，故在 `#commit` 的 `atomicWriteFile` 检查；如需等待期失败更早，可在 action 首行检查，但当前测试断言的是"abort 后 queued 快速拒绝"——由入队时检查覆盖：queued 入队时未 abort，abort 发生在等待中；因此把 abort 检查放到 `run` 执行前一刻（`run.then` 链上）更准确。改为：

```ts
  #withPathLock<T>(
    filePath: string,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = path.resolve(filePath);
    const previous = this.#writeQueues.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => {
        assertNotAborted(signal);
        return action();
      },
      () => {
        assertNotAborted(signal);
        return action();
      },
    );
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.#writeQueues.set(key, done);
    void done.then(() => {
      if (this.#writeQueues.get(key) === done) {
        this.#writeQueues.delete(key);
      }
    });
    return run;
  }
```
（本实现以最终版为准：锁轮到本操作时先查 abort 再执行——等待期间 abort 即快速失败。）

- [ ] **Step 4: 运行通过**

Run: `pnpm exec tsx --test src/tools/atomic-file.test.ts`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools/atomic-file.ts src/tools/atomic-file.test.ts
git commit -m "feat(tools): P0-2 写入串行化队列——同路径写互斥（跨会话同进程生效），异路径写并行"
```

---

### Task 3: P0-3 文件操作跟踪进压缩（FileOps）

**Files:**
- Modify: `src/core/types.ts`（FileOps 接口 + ToolExecutionResult.fileOps + context_compacted.fileOps）
- Modify: `src/tools/executor.ts`（Read/Edit/MultiEdit/Write 填 fileOps）
- Modify: `src/core/tool-batch.ts`（executeTool 返回结果）
- Modify: `src/core/agent-loop.ts`（#fileOps 累计 + AgentModel.setFileOps）
- Modify: `src/core/agent-model.ts`（setFileOps + compact 拼装 + CompactionResult.fileOps）
- Modify: `src/core/session.ts`（onCompacted → context_compacted.fileOps）
- Test: `src/tools/executor.test.ts`、`src/core/agent-loop.test.ts`、`src/core/agent-model.test.ts`

**Interfaces:**
- Consumes: `AgentLoopOptions`（Task 1 后不变）；`executeTool`（现返回 void，本任务改为返回 `ToolExecutionResult`）
- Produces: `FileOps { read: string[]; modified: string[] }`（types.ts）；`ToolExecutionResult.fileOps?: FileOps`；`AgentModel.setFileOps?(ops: FileOps): void`；`CompactionResult.fileOps?: FileOps`；`AgentEvent context_compacted.fileOps?: FileOps`

- [ ] **Step 1: 写失败测试**

`src/tools/executor.test.ts` 追加：

```ts
test("fileOps：Read 记 read、Edit/Write 记 modified（相对路径），Bash 不记", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-fileops-"));
  await writeFile(path.join(cwd, "a.txt"), "hello\n", "utf8");
  const executor = new ToolExecutor(cwd);
  const readResult = await executor.execute(
    call("r1", "Read", "a.txt", { file_path: "a.txt" }),
    new AbortController().signal,
  );
  assert.deepEqual(readResult.fileOps, { read: ["a.txt"], modified: [] });
  const editResult = await executor.execute(
    call("e1", "Edit", "a.txt", {
      file_path: "a.txt",
      old_string: "hello",
      new_string: "world",
    }),
    new AbortController().signal,
  );
  assert.deepEqual(editResult.fileOps, { read: [], modified: ["a.txt"] });
  const bashResult = await executor.execute(
    call("b1", "Bash", "echo hi", { command: "echo hi" }),
    new AbortController().signal,
  );
  assert.equal(bashResult.fileOps, undefined);
});
```

`src/core/agent-loop.test.ts`：ScriptedModel 类（顶部）新增：

```ts
  /** setFileOps 回灌记录（P0-3 断言用） */
  readonly fileOpsSnapshots: FileOps[] = [];

  setFileOps(ops: FileOps): void {
    this.fileOpsSnapshots.push(ops);
  }
```
（import 追加 `type FileOps`；`class ScriptedModel implements AgentModel` 中 `next` 保留 `done: true` 兜底。）

同文件末尾追加：

```ts
test("AgentLoop 累计文件操作并注入模型（FileOps）", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-fileops-loop-"));
  const filePath = path.join(directory, "sample.txt");
  await writeFile(filePath, "before\n", "utf8");
  const bus = new AgentEventBus();
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "sample.txt", { file_path: "sample.txt" }),
      ],
    },
    {
      toolCalls: [
        toolCall("e1", "Edit", "sample.txt", {
          file_path: "sample.txt",
          old_string: "before",
          new_string: "after",
        }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("normal"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
  });
  await loop.run();
  assert.deepEqual(model.fileOpsSnapshots.at(-1), {
    read: ["sample.txt"],
    modified: ["sample.txt"],
  });
});
```

`src/core/agent-model.test.ts` 追加：

```ts
test("压缩摘要请求携带文件操作清单（FileOps）", async () => {
  const history: ConversationMessage[] = [
    { role: "user", content: "任务开始" },
    { role: "assistant", content: "已读取文件", toolCalls: [] },
    { role: "user", content: "继续" },
  ];
  const cheap = new CapturingClient([
    response("Task goal: 完成\nKey files: a.ts", 40, 12),
  ]);
  const model = new ConversationAgentModel(
    new CapturingClient([response("继续")]),
    history,
  );
  model.setFileOps({ read: ["src/a.ts"], modified: ["src/a.ts"] });
  let compacted: { fileOps?: unknown } | undefined;
  model.configureCompaction({
    client: cheap,
    thresholdTokens: 1,
    keepRecentTokens: 1,
    onCompacted: (result) => {
      compacted = result;
    },
  });
  await model.compact(new AbortController().signal, true);
  const content = (
    cheap.requests[0]?.messages[0] as { content: string }
  ).content;
  assert.match(content, /Files read:\n- src\/a\.ts/);
  assert.match(content, /Files modified:\n- src\/a\.ts/);
  assert.deepEqual(compacted?.fileOps, {
    read: ["src/a.ts"],
    modified: ["src/a.ts"],
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec tsx --test src/tools/executor.test.ts src/core/agent-loop.test.ts src/core/agent-model.test.ts`
Expected: 新测试 FAIL（fileOps undefined / fileOpsSnapshots 空 / 摘要请求无 Files read）

- [ ] **Step 3: 实现**

`src/core/types.ts`：
- 新增（`ToolCall` 定义之后）：

```ts
/** 文件操作跟踪（P0-3）：压缩时携带，压缩后模型仍知道动过哪些文件。
    路径为相对 cwd 的规范化形式（Read → read；Edit/MultiEdit/Write → modified）。 */
export interface FileOps {
  read: string[];
  modified: string[];
}
```
- `ToolExecutionResult` 追加：

```ts
  /** 文件操作跟踪（P0-3）：压缩摘要携带；可选，旧事件回放无此字段也兼容 */
  fileOps?: FileOps;
```
- `context_compacted` 事件追加：

```ts
    /** 压缩时的文件操作跟踪（P0-3）：前端可展示，旧事件兼容 */
    fileOps?: FileOps;
```

`src/tools/executor.ts`：
- Read 分支 return 前追加 `fileOps`（`details` 前）：

```ts
        return {
          summary: `已读取 ${args.file_path} 第 ${offset}-${endLine} 行（共 ${lines.length} 行）`,
          output: bounded.text,
          traceOutput: paged,
          fileOps: {
            read: [
              normalizeSlashes(path.relative(this.#cwd, filePath)),
            ],
            modified: [],
          },
          details: {
```
- Edit 分支：

```ts
        return {
          summary: `已编辑 ${args.file_path}`,
          output: `已编辑 ${args.file_path}（${diffHunkCount(diff)} 处变更）`,
          fileOps: {
            read: [],
            modified: [
              normalizeSlashes(
                path.relative(this.#cwd, this.#resolve(args.file_path)),
              ),
            ],
          },
          details: {
```
- MultiEdit 分支：

```ts
        return {
          summary: `已完成 ${args.file_path} 的 ${args.edits.length} 项编辑`,
          output: `已完成 ${args.file_path} 的 ${args.edits.length} 项编辑`,
          fileOps: {
            read: [],
            modified: [
              normalizeSlashes(
                path.relative(this.#cwd, this.#resolve(args.file_path)),
              ),
            ],
          },
          details: {
```
- Write 分支：

```ts
        return {
          summary: `已写入 ${args.file_path}`,
          output: `已写入 ${args.file_path}（${Buffer.byteLength(args.content)} 字节）`,
          fileOps: {
            read: [],
            modified: [
              normalizeSlashes(
                path.relative(this.#cwd, this.#resolve(args.file_path)),
              ),
            ],
          },
          details: {
```

`src/core/tool-batch.ts`：
- `emitToolResult` 返回结果（签名 `): ToolExecutionResult {`，末尾 `return result;`）。
- `executeTool` 返回最终结果（`Promise<ToolExecutionResult>`）；成功路径 `return emitToolResult(...)`；catch 路径构造 `result` 后 `return emitToolResult(...)`（把 `{ ...result, isError: true }` 先赋给变量再 emit+return）。

`src/core/agent-loop.ts`：
- `AgentModel` 接口追加：

```ts
  /** 文件操作跟踪（P0-3）：压缩时携带，压缩后模型仍知道动过哪些文件 */
  setFileOps?(ops: FileOps): void;
```
- import 追加 `type FileOps`（types.js 已有 ToolCall/ToolExecutionResult import）。
- 类字段（`#steerRequested` 之后）：

```ts
  /** 文件操作跟踪（P0-3）：累计 read/modified 相对路径，注入模型供压缩摘要携带 */
  readonly #fileOps = { read: new Set<string>(), modified: new Set<string>() };
```
- 类内私有方法（`#recordModelError` 附近）：

```ts
  #mergeFileOps(result: ToolExecutionResult | undefined): void {
    if (!result?.fileOps) return;
    for (const file of result.fileOps.read) this.#fileOps.read.add(file);
    for (const file of result.fileOps.modified) {
      this.#fileOps.modified.add(file);
    }
    this.#model.setFileOps?.({
      read: [...this.#fileOps.read],
      modified: [...this.#fileOps.modified],
    });
  }
```
- 串行路径：`await executeTool(...)` 改为接收返回值并 merge：

```ts
          const result = await executeTool(
            this.#bus,
            this.#model,
            this.#tools,
            traceTools,
            {
              call,
              permission: verdict,
              signal,
              ms: toolStartedAt,
              onData: this.#makeOnToolData(call.id),
            },
          );
          this.#mergeFileOps(result);
```
- 并行路径 `#executeBatchParallel` 的 settled 循环内、`emitToolResult` 前追加：

```ts
      this.#mergeFileOps(item.result);
```

`src/core/agent-model.ts`：
- import 追加 `type FileOps`。
- 类字段（`#compaction` 之后）：

```ts
  /** 文件操作跟踪（P0-3）：AgentLoop 每批执行后刷新，compact 时拼进摘要请求 */
  #fileOps: FileOps = { read: [], modified: [] };
```
- 方法（`setTodos` 附近）：

```ts
  setFileOps(ops: FileOps): void {
    this.#fileOps = ops;
  }
```
- `compact()` 的 request messages 改：

```ts
      messages: [
        {
          role: "user",
          content:
            serializeConversation(older) +
            formatFileOpsNote(this.#fileOps),
        },
      ],
```
- `onCompacted` 调用追加（`retainedUserCount` 之后）：

```ts
      ...(this.#fileOps.read.length > 0 || this.#fileOps.modified.length > 0
        ? { fileOps: this.#fileOps }
        : {}),
```
- `CompactionResult` 接口追加：

```ts
  /** 压缩时的文件操作跟踪（P0-3）：事件流透传，前端可展示 */
  fileOps?: FileOps;
```
- 文件末尾新增辅助函数：

```ts
/** 文件操作清单段落（P0-3）：拼进压缩摘要请求，压缩模型据此保留关键文件信息 */
function formatFileOpsNote(fileOps: FileOps): string {
  const { read, modified } = fileOps;
  if (read.length === 0 && modified.length === 0) return "";
  const lines: string[] = [];
  if (read.length > 0) {
    lines.push("Files read:", ...read.map((file) => `- ${file}`));
  }
  if (modified.length > 0) {
    lines.push("Files modified:", ...modified.map((file) => `- ${file}`));
  }
  return `\n\n${lines.join("\n")}`;
}
```

`src/core/session.ts`：onCompacted 的 `context_compacted` emit 追加：

```ts
          this.#bus.emit({
            type: "context_compacted",
            summary: result.summary,
            ratio: result.ratio,
            keepFromSeq,
            ...(result.fileOps ? { fileOps: result.fileOps } : {}),
          });
```

- [ ] **Step 4: 运行通过**

Run: `pnpm exec tsx --test src/tools/executor.test.ts src/core/agent-loop.test.ts src/core/agent-model.test.ts`
Expected: 全 PASS（含既有压缩/循环测试——fileOps 为空时摘要请求与旧行为逐字一致）

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/tools/executor.ts src/core/tool-batch.ts src/core/agent-loop.ts src/core/agent-model.ts src/core/session.ts src/tools/executor.test.ts src/core/agent-loop.test.ts src/core/agent-model.test.ts
git commit -m "feat(core): P0-3 文件操作跟踪进压缩——FileOps 累计并经摘要请求携带，压缩后仍知动过哪些文件"
```

---

### Task 4: P0-4 afterToolCall 钩子 + 工具级 terminate

**Files:**
- Modify: `src/core/types.ts`（ToolExecutionResult.terminate）
- Modify: `src/core/tool-batch.ts`（executeTool transform 参数）
- Modify: `src/core/agent-loop.ts`（afterToolCall 选项、两条路径应用、terminate 批次语义）
- Modify: `src/core/task-runner.ts`（afterToolCall 透传）
- Test: `src/core/agent-loop.test.ts`、`src/core/task-runner.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `executeTool` 返回结果；`#mergeFileOps`
- Produces: `ToolExecutionResult.terminate?: boolean`；`AgentLoopOptions.afterToolCall?: (call, result) => ToolExecutionResult | void | Promise<ToolExecutionResult | void>`；`TaskRunnerOptions.afterToolCall`（透传）；`#executeBatchParallel` 返回 `boolean`（批次是否全部 terminate）

- [ ] **Step 1: 写失败测试（agent-loop.test.ts 追加）**

```ts
test("afterToolCall 改写工具结果（emit 前应用）", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-hook-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
    afterToolCall: (_call, result) => ({
      ...result,
      summary: `改写：${result.summary}`,
    }),
  });
  await loop.run();
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.ok(toolResult?.type === "tool_result");
  if (toolResult?.type === "tool_result") {
    assert.match(toolResult.summary, /^改写：/);
  }
});

test("afterToolCall 抛错不中断循环，保留原结果", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-hook-err-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
    afterToolCall: () => {
      throw new Error("钩子故障");
    },
  });
  await loop.run();
  assert.equal(events.at(-1)?.type, "done");
  const toolResult = events.find((event) => event.type === "tool_result");
  assert.ok(toolResult?.type === "tool_result");
  if (toolResult?.type === "tool_result") {
    assert.match(toolResult.summary, /已读取/);
  }
});

test("terminate：单工具批次 terminate 后循环立即结束", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    // 循环若未终止，第二轮会执行 r2
    {
      toolCalls: [
        toolCall("r2", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  let executed = 0;
  const tools = new ToolExecutor(directory);
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executed += 1;
    return await originalExecute(call, signal, options);
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    afterToolCall: (_call, result) => ({ ...result, terminate: true }),
  });
  await loop.run();
  assert.equal(executed, 1, "terminate 后不再发起下一轮工具调用");
  assert.equal(events.at(-1)?.type, "done");
});

test("terminate：批次部分 terminate 不结束循环", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-part-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  await writeFile(path.join(directory, "b.txt"), "hi\n", "utf8");
  await writeFile(path.join(directory, "c.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("r1", "Read", "a.txt", { file_path: "a.txt" }),
        toolCall("r2", "Read", "b.txt", { file_path: "b.txt" }),
      ],
    },
    {
      toolCalls: [
        toolCall("r3", "Read", "c.txt", { file_path: "c.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  let executed = 0;
  const tools = new ToolExecutor(directory);
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executed += 1;
    return await originalExecute(call, signal, options);
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    afterToolCall: (call, result) => ({
      ...result,
      terminate: call.id === "r1",
    }),
  });
  await loop.run();
  assert.equal(executed, 3, "部分 terminate 不终止循环，后续轮继续执行");
  assert.equal(events.at(-1)?.type, "done");
});

test("terminate 与 steer 交互：steer 优先于 terminate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-steer-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  await writeFile(path.join(directory, "b.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("t1", "Read", "a.txt", { file_path: "a.txt" }),
        toolCall("t2", "Read", "b.txt", { file_path: "b.txt" }),
      ],
    },
    { text: "完成", done: true },
  ]);
  let loop: AgentLoop | undefined;
  loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools: new ToolExecutor(directory),
    approve: async () => ({ granted: true }),
    afterToolCall: (call, result) => {
      if (call.id === "t1") loop?.steer();
      return { ...result, terminate: true };
    },
  });
  await loop.run();
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        (event as Extract<AgentEvent, { type: "permission_denied" }>).call
          .id === "t2",
    ),
    "steer 后批次剩余调用被拒绝",
  );
  assert.notEqual(events.at(-1)?.type, "done", "steer 路径不 emit done");
});

test("terminate 无法绕过 finalOnly：final 阶段工具被拒", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "myagent-term-final-"));
  await writeFile(path.join(directory, "a.txt"), "hi\n", "utf8");
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const model = new ScriptedModel([
    {
      toolCalls: [
        toolCall("t1", "Read", "a.txt", { file_path: "a.txt" }),
      ],
    },
    { text: "总结", done: true },
  ]);
  let executed = 0;
  const tools = new ToolExecutor(directory);
  const originalExecute = tools.execute.bind(tools);
  tools.execute = async (call, signal, options) => {
    executed += 1;
    return await originalExecute(call, signal, options);
  };
  const loop = new AgentLoop({
    bus,
    model,
    permissions: new PermissionEngine("trust"),
    tools,
    approve: async () => ({ granted: true }),
    beforeTurn: async () => ({ finalOnly: true }),
    afterToolCall: (_call, result) => ({ ...result, terminate: true }),
  });
  await loop.run();
  assert.equal(executed, 0, "final 阶段工具被拒绝，不执行");
  assert.ok(
    events.some(
      (event) =>
        event.type === "permission_denied" &&
        (event as Extract<AgentEvent, { type: "permission_denied" }>).reason.includes("纯总结"),
    ),
  );
});
```

`src/core/task-runner.test.ts` 追加：

```ts
test("afterToolCall 透传到子代理循环", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-task-hook-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "auth.ts"),
    "export function refreshToken() {}\n",
    "utf8",
  );
  const bus = new AgentEventBus();
  const events: AgentEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const runner = new TaskRunner({
    cwd,
    bus,
    mode: "trust",
    client: new ScriptedClient([
      response("", [
        {
          id: "grep-1",
          tool: "Grep",
          target: "refreshToken",
          args: { pattern: "refreshToken", path: "." },
        },
      ]),
      response(
        "Conclusion: 找到。\nKey evidence: src/auth.ts:1\nUnconfirmed: 无。",
      ),
    ]),
    afterToolCall: (_call, result) => ({
      ...result,
      summary: `[子代理] ${result.summary}`,
    }),
  });
  const result = await runner.run(
    { description: "检索", prompt: "检索 refreshToken" },
    new AbortController().signal,
  );
  assert.ok(String(result.output).includes("找到"));
  const grepResult = events.find(
    (event) =>
      event.type === "task_event" && event.eventType === "tool_result",
  );
  assert.ok(grepResult, "子代理工具结果经 task_event 转发");
  if (grepResult?.type === "task_event") {
    assert.match(String(grepResult.summary ?? ""), /^\[子代理\]/);
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts src/core/task-runner.test.ts`
Expected: 新测试 FAIL（afterToolCall 未生效 / terminate 不结束循环 / task-runner 无透传）

- [ ] **Step 3: 实现**

`src/core/types.ts` 的 `ToolExecutionResult` 追加：

```ts
  /** 批次终止语义（P0-4）：批次内全部已执行工具 terminate 时结束循环（子代理收尾协议化） */
  terminate?: boolean;
```

`src/core/tool-batch.ts`：
- `executeTool` 增加可选 transform 参数并返回结果：

```ts
/** 执行 + 结果回灌（异常转为 isError 结果），串行/并行批次共用。
    transform（P0-4 afterToolCall）在 emit 前应用：事件流与模型回灌均反映改写后的结果。 */
export async function executeTool(
  bus: AgentEventBus,
  model: AgentModel,
  tools: ToolExecutor,
  traceTools: ToolTraceItem[],
  options: {
    call: ToolCall;
    permission: string;
    signal: AbortSignal;
    ms: number;
    onData?: (chunk: string) => void;
    transform?: (
      result: ToolExecutionResult,
    ) => ToolExecutionResult | void | Promise<ToolExecutionResult | void>;
  },
): Promise<ToolExecutionResult> {
  try {
    const raw = await tools.execute(options.call, options.signal, {
      ...(options.onData ? { onData: options.onData } : {}),
    });
    const transformed = options.transform
      ? await options.transform(raw)
      : undefined;
    const result = transformed ?? raw;
    return emitToolResult(bus, model, traceTools, {
      call: options.call,
      result,
      permission: options.permission,
      ms: options.ms,
    });
  } catch (error) {
    const raw: ToolExecutionResult = {
      summary:
        error instanceof Error ? error.message : "工具执行发生未知错误",
    };
    const transformed = options.transform
      ? await options.transform({ ...raw, isError: true })
      : undefined;
    const result = transformed ?? { ...raw, isError: true };
    return emitToolResult(bus, model, traceTools, {
      call: options.call,
      result,
      permission: options.permission,
      ms: options.ms,
    });
  }
}
```
- `emitToolResult` 签名改 `): ToolExecutionResult {`，末尾 `return result;`。

`src/core/agent-loop.ts`：
- `AgentLoopOptions` 追加：

```ts
  /** afterToolCall 钩子（P0-4，参照 Pi）：工具结果 emit 前改写（脱敏/再截断/错误改写）。
      钩子抛错保留原结果，不中断主循环。 */
  afterToolCall?: (
    call: ToolCall,
    result: ToolExecutionResult,
  ) => ToolExecutionResult | void | Promise<ToolExecutionResult | void>;
```
- 类字段（`#parallelTools` 之后）：

```ts
  readonly #afterToolCall: AgentLoopOptions["afterToolCall"];
```
- 构造器（`this.#parallelTools = ...` 之后）：

```ts
    this.#afterToolCall = options.afterToolCall;
```
- 私有方法（`#mergeFileOps` 附近）：

```ts
  /** P0-4 afterToolCall：emit 前应用；钩子抛错保留原结果（可选增强不得中断主循环） */
  async #applyAfterToolCall(
    call: ToolCall,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    if (!this.#afterToolCall) return result;
    try {
      return (await this.#afterToolCall(call, result)) ?? result;
    } catch {
      return result;
    }
  }
```
- 串行路径：`executeTool` 调用加 transform，batch 终止标记：

```ts
        let allTerminated = true;
        for (const call of calls) {
          const toolStartedAt = Date.now();
          if (signal.aborted) {
            recordTurn();
            return;
          }
          if (this.#steerRequested) {
            // 打断点一：当前工具已完成，拒绝本批剩余调用
            //（模型协议要求每个 tool_use 都有 tool_result 回应）
            emitDeniedTool(this.#bus, this.#model, traceTools, {
              call,
              reason: "用户插入新指令（steer），跳过剩余工具调用",
              permission: "steered",
              ms: Date.now() - toolStartedAt,
            });
            allTerminated = false;
            continue;
          }
          this.#bus.emit({ type: "tool_call", call });
          if (turnPolicy?.finalOnly) {
            emitDeniedTool(this.#bus, this.#model, traceTools, {
              call,
              reason: "任务盒已进入纯总结阶段，禁止继续调用工具",
              permission: "task_box_deny",
              ms: Date.now() - toolStartedAt,
            });
            allTerminated = false;
            continue;
          }
          const verdict = this.#permissions.judge(call);
          if (verdict === "deny") {
            emitDeniedTool(this.#bus, this.#model, traceTools, {
              call,
              reason: "命中 deny 规则，不能临时强制放行",
              permission: "deny",
              ms: Date.now() - toolStartedAt,
            });
            allTerminated = false;
            continue;
          }
          if (verdict === "ask") {
            const detail = await this.#tools
              .preview(call, signal)
              .catch(() => "");
            this.#bus.emit({
              type: "ask_permission",
              call,
              risk: riskFor(call),
              ...(detail ? { detail } : {}),
            });
            const answer = await this.#approve(call, signal);
            if (!answer.granted) {
              const reason = answer.feedback?.trim()
                ? `用户拒绝：${answer.feedback.trim()}`
                : "用户拒绝或审批超时";
              emitDeniedTool(this.#bus, this.#model, traceTools, {
                call,
                reason,
                permission: "user_denied",
                ms: Date.now() - toolStartedAt,
              });
              allTerminated = false;
              // 拒绝来自 steer 取消挂起审批：直接结束本批，不再执行剩余工具
              if (this.#steerRequested) break;
              continue;
            }
          }

          const result = await executeTool(
            this.#bus,
            this.#model,
            this.#tools,
            traceTools,
            {
              call,
              permission: verdict,
              signal,
              ms: toolStartedAt,
              onData: this.#makeOnToolData(call.id),
              transform: (raw) => this.#applyAfterToolCall(call, raw),
            },
          );
          this.#mergeFileOps(result);
          if (result.terminate !== true) allTerminated = false;
        }

        recordTurn();

        if (this.#steerRequested) {
          // steer 后不发 done：退出循环让会话优先消费插队消息
          return;
        }
        // P0-4 批次终止：全部已执行工具 terminate 后结束循环（与 turn.done 同语义）
        if (allTerminated && calls.length > 0) {
          this.#bus.emit({ type: "done" });
          return;
        }
        if (turn.done) {
          this.#bus.emit({ type: "done" });
          return;
        }
```
- 并行路径：`#executeBatchParallel` 签名改返回 `Promise<boolean>`，settled 循环加 applyAfterToolCall + merge + terminate 统计：

```ts
  async #executeBatchParallel(
    verdicts: Array<{ call: ToolCall; verdict: PermissionVerdict }>,
    turnPolicy: { stop?: boolean; finalOnly?: boolean } | undefined,
    signal: AbortSignal,
    traceTools: ToolTraceItem[],
  ): Promise<boolean> {
    // 先统一 emit tool_call（与串行路径一致）：事件流完整，崩溃恢复时
    // tool_result 按 callId 配对不丢（此前并行路径缺 tool_call 事件导致恢复丢失）
    for (const { call } of verdicts) {
      this.#bus.emit({ type: "tool_call", call });
    }
    const executions = verdicts.map(async ({ call, verdict }) => {
      const toolStartedAt = Date.now();
      if (signal.aborted) {
        return { call, verdict, state: "skipped" as const };
      }
      if (verdict === "deny") {
        emitDeniedTool(this.#bus, this.#model, traceTools, {
          call,
          reason: "命中 deny 规则，不能临时强制放行",
          permission: "deny",
          ms: 0,
        });
        return { call, verdict, state: "denied" as const };
      }
      if (turnPolicy?.finalOnly) {
        emitDeniedTool(this.#bus, this.#model, traceTools, {
          call,
          reason: "任务盒已进入纯总结阶段，禁止继续调用工具",
          permission: "task_box_deny",
          ms: 0,
        });
        return { call, verdict, state: "denied" as const };
      }
      try {
        const result = await this.#tools.execute(call, signal, {
          onData: this.#makeOnToolData(call.id),
        });
        return { call, verdict, state: "done" as const, result, toolStartedAt };
      } catch (error) {
        const result: ToolExecutionResult = {
          summary:
            error instanceof Error ? error.message : "工具执行发生未知错误",
        };
        return { call, verdict, state: "error" as const, result, toolStartedAt };
      }
    });
    const settled = await Promise.all(executions);
    let allTerminated = true;
    for (const item of settled) {
      const { call, verdict } = item;
      if (item.state === "skipped") {
        allTerminated = false;
        continue;
      }
      if (item.state === "denied") {
        allTerminated = false; // trace 已在 executions 内记录
        continue;
      }
      const result = await this.#applyAfterToolCall(call, item.result!);
      this.#mergeFileOps(result);
      if (result.terminate !== true) allTerminated = false;
      emitToolResult(this.#bus, this.#model, traceTools, {
        call,
        result,
        permission: verdict,
        ms: Date.now() - item.toolStartedAt,
      });
    }
    return allTerminated;
  }
```
- 并行调用点：

```ts
            const allTerminated = await this.#executeBatchParallel(
              verdicts,
              turnPolicy,
              signal,
              traceTools,
            );
            recordTurn();
            if (this.#steerRequested) {
              return;
            }
            if (allTerminated) {
              this.#bus.emit({ type: "done" });
              return;
            }
            if (turn.done) {
              this.#bus.emit({ type: "done" });
              return;
            }
            continue;
```

`src/core/task-runner.ts`：
- `TaskRunnerOptions` 追加：

```ts
  /** afterToolCall 钩子（P0-4）：透传到子代理循环（子代理收尾协议面） */
  afterToolCall?: AgentLoopOptions["afterToolCall"];
```
- 类字段（`#files` 之后）与构造器赋值：

```ts
  readonly #afterToolCall: TaskRunnerOptions["afterToolCall"];
```
```ts
    this.#afterToolCall = options.afterToolCall;
```
- 子代理 AgentLoop 构造追加：

```ts
      ...(this.#afterToolCall
        ? { afterToolCall: this.#afterToolCall }
        : {}),
```

- [ ] **Step 4: 运行通过**

Run: `pnpm exec tsx --test src/core/agent-loop.test.ts src/core/task-runner.test.ts`
Expected: 全 PASS（含既有测试——无钩子时行为逐字不变）

- [ ] **Step 5: 提交**

```bash
git add src/core/types.ts src/core/tool-batch.ts src/core/agent-loop.ts src/core/task-runner.ts src/core/agent-loop.test.ts src/core/task-runner.test.ts
git commit -m "feat(core): P0-4 afterToolCall 钩子 + 工具级 terminate——批次全部 terminate 结束循环，steer/finalOnly 优先"
```

---

### Task 5: 全量验证与文档校准

**Files:**
- Modify: `设计方案/Pi对比与借鉴.md`（P0 行标记已落地）

- [ ] **Step 1: 全量 typecheck + 测试 + build**

Run:
```bash
pnpm run typecheck
pnpm test
pnpm run build
```
Expected: 全部通过。若测试发现回归，回到对应任务修复（TDD 循环）。

- [ ] **Step 2: 文档校准**

`设计方案/Pi对比与借鉴.md` §4 P0 行（40-71 行附近）四项"改法"加删除线并标注已落地（参照 §3 既有"已借鉴"格式），并更新 §6 决策记录追加一行：

```
- **2026-08-14**：P0 四项全部落地（P0-1 executionMode 批次退化串行 / P0-2 写入串行化队列 / P0-3 FileOps 进压缩 / P0-4 afterToolCall + terminate），见 docs/superpowers/specs/2026-08-14-p0-parallel-safety-and-compaction-design.md。
```

- [ ] **Step 3: 提交**

```bash
git add 设计方案/Pi对比与借鉴.md
git commit -m "docs: Pi 借鉴清单 P0 四项标记已落地"
```

- [ ] **Step 4: 浏览器实测**（真实模型生产级任务，观察并行批次与压缩摘要）并按记忆推送 GitHub。

---

## Self-Review 记录

- **Spec coverage**：P0-1（Task 1）✓ P0-2（Task 2）✓ P0-3（Task 3）✓ P0-4（Task 4）✓ 验证（Task 5）✓
- **类型一致性**：`isParallelSafe`（Task 1 产出，Task 1 内部消费）✓；`executeTool` 返回值（Task 3 改签名，Task 3/4 消费）✓；`#executeBatchParallel` 返回 boolean 仅在 Task 4 引入与消费 ✓；`FileOps`/`setFileOps`/`fileOps`/`terminate`/`afterToolCall` 名称在 Task 3/4 间一致 ✓
- **占位符**：全部步骤含完整代码，无 TBD ✓
