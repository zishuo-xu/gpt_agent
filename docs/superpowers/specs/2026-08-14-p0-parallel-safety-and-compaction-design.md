# P0 四项实施设计：工具并行安全 + 文件操作进压缩 + afterToolCall/terminate

> 决策依据：`设计方案/Pi对比与借鉴.md` §4 的 P0-1 ~ P0-4（2026-08-09 决策，顺序 P0-1 → P0-2 → P0-3 → P0-4，低风险先行）。本文为落地方案，2026-08-14。
> 涉及代码现状均已核对（agent-loop.ts / tool-batch.ts / executor.ts / atomic-file.ts / agent-model.ts / types.ts / task-runner.ts）。

## 目标

四项互相关联的自主运行质量增强：

1. **P0-1 工具级执行模式**：写类工具（Edit/MultiEdit/Write/Bash）声明为顺序执行，含任一顺序工具的批次整体退化为串行——并行模式下消除同批写竞争。
2. **P0-2 写入串行化队列**：按目标路径互斥的写队列——同路径写串行（含跨会话同进程），不同路径写并行。与 P0-1 配合后并行安全。
3. **P0-3 文件操作进压缩**：压缩摘要携带 readFiles/modifiedFiles，压缩后模型仍知道动过哪些文件。
4. **P0-4 afterToolCall 钩子 + 工具级 terminate**：工具结果改写钩子（脱敏/再截断/错误改写）；批次内全部工具 terminate 时结束循环（子代理收尾协议化）。

## 设计决策

### P0-1 执行模式声明

- **内置工具**：常量 `SEQUENTIAL_TOOL_NAMES = ["Edit", "MultiEdit", "Write", "Bash"]`（放 `src/tools/tool-definitions.ts`）。不进 wire schema（`ToolDefinition` 保持纯净，避免供应商对未知字段的校验风险）。Read/Grep/Glob/TodoWrite/Task 并行安全。
- **插件协议**：`PluginTool` 增加可选 `executionMode?: "sequential" | "parallel"`，`register` 时校验枚举值。缺省按工具名只读启发式判定（复用 agent-loop.ts 中现有 `looksReadOnlyTool` 的动词表，函数移入 `src/shared/tool-names.ts` 供两处共用）：只读名 → 并行；否则 → 顺序（保守）。
- **判定入口**：`ToolExecutor.isParallelSafe(tool: string): boolean`——内置查常量集，插件查声明/启发式。
- **批次判定**：AgentLoop 并行条件追加 `calls.every((c) => this.#tools.isParallelSafe(c.tool))`；含任一顺序工具 → 整批走既有串行路径（对齐 Pi 的"批次内存在顺序工具 → 整批串行"）。细粒度"顺序工具串行、读工具仍并行"留作后续（决策记录标注"可超越"项，本期不做以控风险）。

### P0-2 写入串行化队列

- **位置**：`AtomicFileTools` 内部（`src/tools/atomic-file.ts`）。全部内置写路径（edit/multiEdit/write）都收敛于该类，且 web server 进程内所有会话共享同一实例（`src/web/server.ts:62`）——实例级队列自然覆盖跨会话同路径竞争。
- **粒度**：整个"读旧内容 → 计算 → 快照 → 落盘 → journal"流程加锁（只锁提交仍会有 lost update）。
- **实现**：按 `path.resolve(filePath)` 分桶的 promise 链互斥。新请求挂到该桶链尾；前驱 settle（成功或失败）后执行；链尾清理桶条目。锁等待期间 abort 快速失败（获取锁前后各检查一次 signal）。
- **范围说明**：Bash 与插件工具的内部写入不经由此队列（不拦截）；其并行风险由 P0-1 的顺序声明覆盖（Bash 恒顺序；插件可声明）。

### P0-3 文件操作进压缩

- **类型**：`types.ts` 新增 `FileOps { read: string[]; modified: string[] }`；`ToolExecutionResult.fileOps?: FileOps`（可选，旧实现无影响）。
- **采集**：`ToolExecutor` 在结果中填充相对路径（`path.relative(cwd, resolved)`）——Read → `read`；Edit/MultiEdit/Write → `modified`；Grep/Glob/Bash/TodoWrite/Task 不填（避免 Grep/Glob 全量结果膨胀）。
- **累计**：AgentLoop 维护 `#fileOps`（read/modified 两个 Set），串行与并行两条路径执行完每个工具后 merge。
- **注入**：`AgentModel` 接口增加可选 `setFileOps?(ops: FileOps)`；`ConversationAgentModel` 持字段，AgentLoop 每批执行后调用。模型 `compact()` 时把清单拼进摘要请求的 user 消息（`Files read: ... / Files modified: ...` 段落）。用字段而非改 compact 签名的原因：`next()` 内部自动压缩、overflow 压缩、手动压缩三条路径统一覆盖。
- **透传**：`CompactionResult.fileOps?` → session 的 onCompacted → `context_compacted` 事件可选字段 `fileOps`（前端忽略不破坏兼容）。

### P0-4 afterToolCall 钩子 + terminate

- **类型**：`ToolExecutionResult.terminate?: boolean`；`AgentLoopOptions.afterToolCall?: (call, result) => ToolExecutionResult | void | Promise<...>`。
- **应用时机**：hook 在 emit 之前应用（事件流与模型回灌都反映改写后的结果）。串行路径给 `executeTool` 增加可选 transform 参数（执行 → transform → emit）；并行路径在 settled 结果 emit 前 apply。hook 抛错吞掉并保留原结果（可选增强不得中断主循环）。
- **终止语义**（对齐 Pi）：批次内**全部**已执行工具 `terminate: true`（无 deny/steer/abort 混入）→ 批次结束后 emit `done` 并退出循环。单工具批次 terminate 同样生效。
- **优先级**：`steer` > `terminate` > `turn.done`（steer 时终止检查让位，用户意图优先；finalOnly 阶段工具被 deny 不会产生 terminate，天然不可绕过）。
- **透传**：`TaskRunnerOptions.afterToolCall` 转发到子代理 AgentLoop（子代理收尾协议面；具体策略后续按需挂接）。

## 测试计划（TDD，红→绿）

| 文件 | 用例 |
| --- | --- |
| `src/core/agent-loop.test.ts` | 并行模式批次含 Edit → 整批串行（执行时序断言）；全只读批次仍并行；afterToolCall 改写结果进 tool_result 事件；hook 抛错不中断；terminate 单工具/全批次/部分批次三态；steer 优先于 terminate |
| `src/tools/executor.test.ts` | Read/Edit/Write 结果带 fileOps 相对路径；Grep/Bash 不带；isParallelSafe：内置顺序集 false、Read true；插件启发式默认 + 声明覆盖 |
| `src/tools/atomic-file.test.ts` | 同路径并发写互斥且无 lost update（两并发 edit 最终内容 = 顺序应用）；异路径并发不互等；锁等待期间 abort 快速失败 |
| `src/core/agent-model.test.ts` | setFileOps 后 compact 请求 user 消息含 Files read/modified；CompactionResult.fileOps 透传 |
| `src/core/task-runner.test.ts` | afterToolCall 透传到子代理 loop |

## 验证

1. `pnpm run typecheck`
2. `pnpm test`
3. `pnpm run build`
4. 浏览器实测（真实模型驱动生产级任务，观察并行批次行为与压缩摘要）
5. 文档校准（README / 设计方案 若有涉及并行或压缩的失实描述）

## 不做（本期）

- 细粒度批次拆分（顺序工具串行、读工具仍并行）——决策记录的可超越项，留后续
- Bash 内部写入拦截、插件写入拦截——不属文件工具路径，不做
- 手动压缩（会话外）的 fileOps 采集增强——模型字段已天然覆盖最近一轮
