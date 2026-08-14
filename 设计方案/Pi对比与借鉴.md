# MyAgent × Pi — 核心对比与借鉴清单

> 决策记录（decisions.md 风格）· 2026-08-09
> 参照源：Pi coding agent（`badlogic/pi-mono` 已迁移为 `earendil-works/pi`，2026-08-09 抓取）
> 抓取范围：`packages/agent/src/agent-loop.ts`（通用循环）、`packages/coding-agent/src/core/agent-session.ts`（会话）、`cache-stats.ts`、`event-bus.ts`、`session-manager.ts`、`compaction/`、`project-trust.ts`、`tools/`

## 1. 定位差异（一切差异的根源）

Pi 是交互式对坐 agent：答一轮即停，用户始终在场。MyAgent 为无人值守的长时间自主任务优化。这决定了以下每一项差异——**凡是无人值守生存必需的机制（任务盒、权限引擎、子代理、角色路由），都是我们的独有强化；Pi 在这些位置是空缺或钩子。**

## 2. 直接差异

| # | 维度 | Pi | MyAgent | 说明 |
|---|---|---|---|---|
| 1 | 任务盒 | 无（deadline/budget 零命中） | `TaskBox`（`src/core/run-task.ts:35`）deadline/budget 三档收尾，final 档 `finalOnly` 全局禁工具（`agent-loop.ts:555`），`--bounds` 编译为 deny 规则 | 无人值守生存机制，Pi 不需要 |
| 2 | 权限审批 | core 无审批：工具直接执行（`agent-loop.ts:600-668`），仅 `beforeToolCall` 钩子 + 一次性项目信任（`project-trust.ts`）+ 工具名 allowlist/denylist | `PermissionEngine` 三档模式 + 四层规则裁决（`permissions.ts:90-99`）、参数级模式匹配、风险翻译（`agent-loop.ts:797`）、审批四级记忆、fail-closed 超时拒绝、deny 硬边界 | 核心优势，不退化 |
| 3 | 子代理 | 无 Task 工具、无子代理 | `TaskRunner` 复用同一 `AgentLoop`，explore 便宜模型 + 只读默认 + 三段式结论回流 | 模型自由定位的直接体现 |
| 4 | 模型路由 | 手动 `cycleModel` / `scopedModels`（交互式操作） | 自动角色路由 main/cheap/explore，压缩与探索自动走便宜模型 | 成本驱动 vs 用户驱动 |
| 5 | 缓存浪费度量 | 离线扫描：`computeCacheWaste(entries)` 全量重扫（`cache-stats.ts:138`），豁免仅 compaction/branch_summary，model switch 计入；美元 | 在线增量（`agent-loop.ts:718`），三分归因：compaction 合法不计费 / model_switch 异常计费 / idle TTL 提示；显示门控 20k tokens 或 0.1 元（`agent-loop.ts:711`）；人民币 | 我们多了归因分类与显示门控 |
| 6 | 事件模型 | `emit(channel: string, data: unknown)`（`event-bus.ts:3`），事件围绕消息生命周期（message_start/update/end） | 33 种 `AgentEvent` 判别联合（`types.ts:36`），围绕动作语义（tool_call/tool_result/cost_update/ask_permission/…） | 消费方零解析成本 |
| 7 | 模块形态 | `AgentSession` 3342 行上帝类（队列/steer/compaction/模型循环/分支/Bash/导出） | 拆分 AgentLoop / AgentSession / SessionStore / TraceStore / PermissionEngine / TaskBox / BranchCoordinator / PermissionWaiter | 保持拆分 |

## 3. "参照 Pi 但实现不同"的项

| 特性 | Pi 实现 | 我们的实现 |
|---|---|---|
| steer 两档 | 独立 steering/followUp 两套队列 × QueueMode（all/one-at-a-time，默认 one-at-a-time，`agent.ts:125-154`） | 单队列 + `steer?: boolean`（`types.ts:43-49`）；且完成当前工具后拒绝剩余工具调用（`agent-loop.ts:540-553`），比 Pi 激进 |
| 并行工具 | **默认并行**，工具声明 `executionMode: "sequential"` 才串行（`agent-loop.ts:419-425`） | 默认串行，会话级 `parallelTools` 开关，批次含 ask 自动退化串行 |
| 重试 | settings.retry 通用退避 | 三分类：瞬时错指数退避（Retry-After 优先）/ overflow 先压缩再重试 / fatal fail-closed（`agent-loop.ts:160-199`） |
| 压缩 | 纯函数 + FileOperations 文件操作跨压缩传承（`compaction.ts`） | 阈值 + keepRecentTokens + 摘要（`agent-model.ts:158`），cacheRetention "none" |
| 截断回合 | `failToolCallsFromTruncatedMessage`（`agent-loop.ts:381`） | 语义一致（`agent-loop.ts:477`） |
| 分支摘要 | branch-summarization.ts | `branch_summarized` 事件（`types.ts:173`） |
| 会话存储 | JSONL append（`${fileTimestamp}_${sessionId}.jsonl`，另有 sqlite-node 可选后端） | JSONL append（`${id}.jsonl`，`session-manager.ts:228`） |

## 4. 借鉴清单（可加强项）

按优先级排序。**P0 为直接提升自主运行质量；P1 为成本精度与扩展性；P2 为体验补充。**

### P0-1 工具级执行模式声明（executionMode）——已落地 2026-08-14

- **Pi**：工具自身声明 `executionMode: "sequential"`，循环按批次内是否有顺序工具决定并行/串行（`agent-loop.ts:419-425`）。
- **现状**：`SEQUENTIAL_TOOL_NAMES`（Edit/MultiEdit/Write/Bash）+ 插件 `executionMode` 声明（缺省只读名启发式），AgentLoop 批次含任一顺序工具整批退化为串行（`agent-loop.ts` 并行条件）。
- ~~改法~~：`ToolExecutor` 工具定义加 `executionMode?: "sequential"`（Write/Edit/MultiEdit/Bash 默认顺序），AgentLoop 批次判定改为"批次内存在顺序工具 → 整批串行"（可精细到仅顺序工具串行、读工具仍并行，Pi 未做此细分，可超越）。
- **落点**：`src/shared/`（工具协议）+ `src/core/agent-loop.ts:505` + `src/tools/executor.ts`。
- **风险**：低。行为仅影响开启 parallelTools 的会话。

### P0-2 写入串行化队列（file-mutation-queue 参照）——已落地 2026-08-14

- **Pi**：`tools/file-mutation-queue.ts` 将文件写入排入队列串行执行。
- **现状**：`AtomicFileTools` 内按 resolve 路径分桶的 promise 链——同路径写互斥（覆盖读-算-写全流程，防 lost update；web server 同进程多会话共享实例时跨会话同样生效），异路径写并行。
- ~~改法~~：按目标路径 hash 分桶的写队列：同路径写互斥，不同路径写可并行。与 P0-1 配合后并行安全。
- **落点**：`src/tools/` 新增，executor 写入路径接入。
- **风险**：低。纯增量。

### P0-3 文件操作跟踪进压缩（FileOperations）——已落地 2026-08-14

- **Pi**：compaction 摘要携带 readFiles/modifiedFiles，且跨压缩传承（`compaction.ts:extractFileOperations`）——模型压缩后仍知道动过哪些文件。
- **现状**：`ToolExecutionResult.fileOps`（Read → read；Edit/MultiEdit/Write → modified，相对路径）→ AgentLoop 累计 → `AgentModel.setFileOps` 注入 → 压缩摘要请求追加 "Files read/modified" 段落 → `context_compacted` 事件携带 fileOps。
- ~~改法~~：AgentLoop 每轮累计 tool 的 Read/Write/Edit 目标路径；compact 时将文件操作清单拼进摘要请求的 user 消息，onCompacted 结果带 fileOps。
- **落点**：`agent-model.ts` + `agent-loop.ts`（tool_result 路径收集）。
- **风险**：低。摘要 prompt 变化需同步压缩模板。

### P0-4 afterToolCall 钩子 + 工具级 terminate 语义——已落地 2026-08-14

- **Pi**：`afterToolCall` 可改写结果 content/details/usage/terminate（`agent-loop.ts:724-751`）；批次内全部工具 terminate=true 则结束循环（`agent-loop.ts:582-584`）。
- **现状**：`AgentLoopOptions.afterToolCall`（emit 前改写，抛错保留原结果）+ `ToolExecutionResult.terminate`（批次内全部已执行工具 terminate → emit done 结束循环；steer 优先于 terminate，finalOnly 天然不可绕过）；`TaskRunnerOptions.afterToolCall` 透传子代理循环。
- ~~改法~~：
  - AgentLoop 增加可选 `afterToolCall`（脱敏、输出再截断、错误改写）；
  - `ToolExecutionResult` 加 `terminate?: boolean`，批次全部 terminate 时结束循环（子代理收尾协议化）。
- **落点**：`agent-loop.ts` + `types.ts`。
- **风险**：中。terminate 语义与 steer/finalOnly 的交互需测试覆盖。

### P1-1 动态工具注册（addedToolNames）

- **Pi**：工具结果携带 `addedToolNames`，会话中途向模型暴露新工具（`agent-loop.ts:787`）。
- **现状**：工具集在会话开始由角色固定（`agent-model.ts:256` toolDefinitionsFor）。
- **改法**：插件热加载后，下一轮 tool 定义加入工具集。我们的插件/MCP 桥已有动态加载基础，缺的是"模型上下文工具集刷新"环节。
- **落点**：`agent-model.ts`（toolDefinitionsFor 改为可增量）+ `executor.ts`。
- **风险**：中。工具名集合变化会影响缓存前缀（tools 数组参与请求体），需评估。

### P1-2 cacheWrite 计费桶

- **Pi**：cost 分四桶 input/output/cacheRead/cacheWrite，miss 按本消息实际支付率（含写溢价）核算（`cache-stats.ts:77-82`）。
- **现状**：pricing 三价（input/output/cachedInput，`cost.ts:11-13`），缓存写溢价按 input 全价近似。
- **改法**：config schema 加 `cacheWritePerMillionCny`，cost_update 事件与 missedCost 计算走精确桶。
- **落点**：`src/config/schema.ts` + `src/utils/cost.ts` + `src/core/types.ts`（cost_update）。
- **风险**：低。纯计价精度，供应商价格表需要补充 cacheWrite 价。

### P1-3 会话文件时间戳命名

- **Pi**：`${fileTimestamp}_${sessionId}.jsonl`，文件名自带时间序（`session-manager.ts:953`）。
- **现状**：`${id}.jsonl`，时间序依赖 index.json（`session-manager.ts:228`）。
- **改法**：新建会话文件带时间戳前缀，索引恢复逻辑兼容旧名。
- **风险**：低。但迁移存量会话文件需兼容读取（保持读旧名格式）。

### P2-1 提示词模板（prompt templates）

- **Pi**：用户可定义 `/模板名` 展开的提示词模板（`agent-session.ts:expandPromptTemplate`）。
- **现状**：CLI 命令是内置硬编码。
- **改法**：配置层加模板目录，CLI 解析 `/name` 时查表展开。
- **风险**：低。纯增量。

### P2-2 HTML 会话导出

- **Pi**：`exportToHtml`（`agent-session.ts:3225`）。
- **现状**：仅 JSONL。Web 端已有完整渲染器，导出成本低。
- **风险**：低。

## 5. 明确不做

| 项 | 理由 |
|---|---|
| thinking level 运行时循环（off/minimal/low/medium/high） | 模型层已有 thinking 支持，交互式调参价值低、复杂度高 |
| navigateTree 分支 UI | 已有 branch/session-branch 系统 |
| 权限改为钩子式 | 权限引擎是无人值守的核心优势，保持内联强制 |
| 合并 AgentSession 上帝类 | 我们的拆分更利于测试与恢复 |

## 6. 决策记录

- **2026-08-09**：确立"Pi 为循环骨架与度量语义参照源，无人值守三件套（任务盒/权限/子代理）为自主差异"的定位；P0 四项（executionMode、写队列、文件操作入压缩、afterToolCall/terminate）列为下一迭代候选，按"低风险先行"顺序实施：P0-1 → P0-2 → P0-3 → P0-4。
- **2026-08-14**：P0 四项全部落地（P0-1 executionMode 批次退化串行 / P0-2 写入串行化队列 / P0-3 FileOps 进压缩 / P0-4 afterToolCall + terminate），设计见 docs/superpowers/specs/2026-08-14-p0-parallel-safety-and-compaction-design.md；细粒度"顺序工具串行、读工具仍并行"（P0-1 的可超越项）留作后续。
