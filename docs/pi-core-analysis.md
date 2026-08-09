# Pi CORE 源码级对照 — MyAgent 改造参考

> 整理时间：2026-08-05
> 基线：克隆 earendil-works/pi @ 05bf9df（2026-08-04，coding-agent v0.83.0），位于 `/tmp/pi-reference`
> 本文是 `docs/pi-agent-analysis.md`（高层调研，2026-08-03）的**源码级深化**：只写可直接落地的实现事实（常量、算法、接口），并逐项对照 MyAgent CORE 现状给出差距与优先级。
> 行号均指基线克隆中的位置；Pi 仓库仍在快速演进，落地前请以最新源码复核。

---

## 0. 总览：先认识 Pi 的"双轨"现实

调研文档描述的是 2025-11 的形态，当前仓库已演进为**两代实现并存**，这本身就是一个重要教训：

| 实现 | 位置 | 状态 |
|---|---|---|
| **JSONL 文件版**（成熟应用） | `packages/coding-agent/src/core/session-manager.ts`（1714 行） | CLI 主路径；`main.ts` 的 `SessionManager` 全走它 |
| **新版 Session API + SQLite**（通用 harness 重构） | `packages/agent/src/harness/session/*` + `packages/storage/sqlite-node/` | 接口完整（`Session`/`SessionStorage`/`SessionRepo`/`AgentHarness`），但 `AgentHarness` 的 `prompt/skill/compact/navigateTree/resume/steer` 目前全部抛 `HarnessNotImplemented`；实际使用者只有 evals/server 体系 |

- 两套会话 entry 模型（`SessionEntry` vs harness `Entry`）、两套 compaction（`coding-agent/src/core/compaction/` vs `agent/src/harness/compaction/`）**刻意同构**——SQLite 是 JSONL 的"落库版"。
- 依赖方向：`pi-ai ← pi-agent-core ← pi-coding-agent`，`pi-tui` 独立（仅被 coding-agent 依赖）。
- **对 MyAgent 的含义**：不要学 Pi 走"先应用后下沉"的双轨过渡；直接采用结论形态——把纯函数/协议放底层，应用策略放上层，一次到位。

四个包的公共面速查（`src/index.ts`）：

| 包 | 公共面 |
|---|---|
| `pi-ai` | `Models`/`Provider`/`Message`/`Usage`（含 cost 明细）/`StreamFunction`/`Tool`（TypeBox schema）/`calculateCost`；auth、OAuth、provider 目录（models.dev 生成） |
| `pi-agent-core` | `Agent`（有状态包装）/`agentLoop`/`StreamFn` 契约/`AgentEvent`/`AgentTool`/`AgentState` + harness（session/compaction/skills/system-prompt/ExecutionEnv/文件工具） |
| `pi-coding-agent` | `AgentSession`/`SessionManager`/`ModelRuntime`/`SettingsManager`/资源加载/扩展系统/工具工厂/modes（interactive/print/rpc） |
| `pi-tui` | 终端 UI 组件库，零依赖 pi 包 |

---

## 1. 上下文与缓存工程

### 1.1 动态系统提示词（system-prompt.ts）

**Pi 的组装**（`coding-agent/src/core/system-prompt.ts:28` `buildSystemPrompt`，由 `agent-session.ts` 的 `_rebuildSystemPrompt` 调用；**会话中只在工具集/加载变化时重建**，前缀友好）：

```
1. 身份段（可整体替换：用户写 SYSTEM.md → customPrompt，默认段全部替换）
2. Available tools:   每工具一行 `- {name}: {snippet}`，只列启用工具
3. Guidelines:        按工具条件追加（如只有 bash 无 grep 时提示"Use bash for file operations"）
                       + 永远追加两条（Be concise / Show file paths clearly）
4. Pi documentation:  文档路径指引
5. appendSystemPrompt（APPEND_SYSTEM.md）
6. <project_context><project_instructions path="...">AGENTS.md 全文</project_instructions></project_context>
7. skills 清单（仅 read 工具可用时；每 skill 恰好 5 行，见 1.3）
8. Current working directory: {cwd}
```

**AGENTS.md 分层加载**（`core/resource-loader.ts:70-156`）：候选名 `["AGENTS.md","AGENTS.MD","CLAUDE.md","CLAUDE.MD"]`（大小写 + Claude 兼容），加载顺序 = 全局 `~/.pi/agent/AGENTS.md` → cwd 到根目录**逐级向上**每层取第一个，最终 `[全局, 根, …, cwd]`（根侧优先）；git worktree 场景用 `findShadowedContextFile` 去重避免同一被跟踪文件重复加载。

**工具 snippet 常量**：read `"Read file contents"`、bash `"Execute bash commands (ls, grep, find, etc.)"`、write `"Create or overwrite files"`、ls/grep/find 各一行；多行 snippet 压成单行（`_normalizePromptSnippet`）。内建工具全集 7 个：read/bash/edit/write/grep/find/ls（`createAllToolDefinitions`）；coding 子集 4 个；只读子集 read/grep/find/ls。

**MyAgent 现状**：`agent-model.ts` 的 `buildSystemPrompt(toolNames)` 已有动态工具集 + 段落裁剪（navigation/task/memory/respect/bash 按需拼装），与 Pi 同源；AGENTS.md 只加载 cwd 根目录一个（无祖先链、无 CLAUDE.md 兼容）；**记忆注入（全局 MEMORY.md + 项目三件套 + 跨项目索引）是 MyAgent 独有的资产**，Pi 没有记忆机制。

### 1.2 缓存统计（cache-stats.ts）

**Pi 的完整算法**（`coding-agent/src/core/cache-stats.ts`）：

```ts
CACHE_TTL_MS = 5 * 60 * 1000        // Anthropic 缓存 TTL，idle 归因用
NOISE_FLOOR_TOKENS = 1024           // 低于此的 miss 视为 breakpoint 粒度噪音
```

- `detectMiss(prev, message, models)`：`promptTokens = input + cacheRead + cacheWrite`；`missedTokens = min(prev.promptTokens, promptTokens) - cacheRead`；`≤1024` 忽略。
- **成本**：`paidPerToken = (cost.input + cost.cacheWrite) / paidTokens`；`readPerToken` 有 cacheRead 时用实际单价、全 miss 回合用模型定价兜底；`missedCost = missedTokens × max(0, paidPerToken - readPerToken)`。
- **`reportedCache` sticky 标志**：prev 从未报告过缓存活动的会话不计 miss——区分「OpenAI 式全 miss」与「根本不支持缓存的 provider」。
- 扫描时 `compaction`/`branch_summary` entry → 重置 prev（合法变化，不计）；**模型切换仍计入 miss**；`idleMs ≥ 5min` 仅用于文案归因（`Cache miss after Nm idle`）。
- UI 显示阈值：`missedTokens < 20_000 && missedCost < 0.1` 不显示；开关默认关（`settings.showCacheMissNotices ?? false`）。
- miss 按 `AssistantMessage` 对象引用挂 Map，**不持久化**，重渲染时重新推导。
- 上游：usage 由 pi-ai provider 层挂到 `AssistantMessage.usage`（Anthropic 映射 `cache_read_input_tokens`/`cache_creation_input_tokens`）；`/session` 命令用 `computeCacheWaste` 展示累计 + `getUsageCostBreakdown`（按 provider/responseModel 分桶，toolResult/compaction 归 "Tools/summaries"）。

**MyAgent 现状**（`agent-loop.ts:442` `computeMissedTokens` + `missedCost`）：算法同源——1024 噪音底、compaction/model_switch/idle 三类原因、`missedCostCny` 按 `(input - cachedInput)` 单价差估算；`/cost` 展示累计。**差距**：
- MyAgent 用 `prev.input` 而非 `input+cacheRead+cacheWrite` 计算 expected，OpenAI 系 provider 的 cacheWrite 被忽略（影响有限，因为 MyAgent 主要算 input vs cached）；
- 无 `reportedCache` sticky 标志（不支持缓存的供应商会被误报 miss——但 MyAgent 的 DeepSeek 等 OpenAI 兼容端点缓存行为差异大，值得补）；
- 无 UI 显示阈值与默认关开关（miss 提示可能刷屏）；
- miss 归属在会话内累计（事件流重放可恢复），未按轮次引用保留——与 Pi 一致的做法，无差距。

### 1.3 Lazy Skills（渐进式披露）

**Pi 的机制**（`coding-agent/src/core/skills.ts` + `agent/src/harness/system-prompt.ts`）：

- Skill = `SKILL.md` + frontmatter `{name?, description?, disable-model-invocation?}`；name 校验（≤64、`[a-z0-9-]`、无 `--`）、description 必填（≤1024），冲突先到先得。
- 发现：目录含 SKILL.md 即 skill root；尊重 `.gitignore/.ignore/.fdignore`；分层 = 全局 `~/.pi/agent/skills` + 项目 `<cwd>/.pi/skills` + 扩展/CLI 路径。
- **「每轮只占一行」的实现**：system prompt 尾部只挂清单——每个 skill 恰好 5 行 XML（`<skill><name>/<description>/<location>`，含绝对路径），**不含 content**；模型匹配 description 后用 read 工具读 `location` 拿全文（懒加载）；`/skill:name` 命令则把全文注入为 **user 消息**（`<skill name=...>` 包裹）。content 永不进 system prompt → 不破坏前缀缓存。
- 仓库**没有随包内置任何 skill**（测试 fixtures 与示例扩展除外）——机制完整、内容交给社区。

**MyAgent 现状**：无 skills 机制（9 内置工具 + 记忆常驻 system；插件工具按角色动态注入——main 全量 / explore 只读集），但无「按需加载」的渐进披露。Task 子代理部分承担了"隔离大探索"的角色。**差距**：skill 机制是 MyAgent「记忆复利」之外的另一条能力注入通道，且与缓存前缀工程兼容（清单尾部 + 全文走消息）。

### 1.4 压缩（compaction）

**Pi 的实现**（`agent/src/harness/compaction/compaction.ts` + `coding-agent/src/core/agent-session.ts`）：

```ts
DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
shouldCompact: contextTokens > contextWindow - reserveTokens
estimateTokens: Math.ceil(chars / 4)；图片按 4800 字符/张
```

- **触发**（`message_end` 后）：`threshold`（估算超限）或 `overflow`（错误消息匹配 overflow 正则排除限流类；或 stopReason=stop 但 usage 超窗的静默溢出）——overflow 会**剔除失败消息后重试一次**（`_overflowRecoveryAttempted`）。
- **切点** `findCutPoint`：从尾向前累计 token 到 ≥ keepRecentTokens（20000）处切；`toolResult` 不可切、切点非 user 消息则回退轮起点（`isSplitTurn`，被切掉的轮前缀单独用 `TURN_PREFIX_SUMMARIZATION_PROMPT` 摘要）。
- **摘要 prompt**：`SUMMARIZATION_PROMPT` 固定结构（## Goal / ## Constraints & Preferences / ## Progress(Done/In Progress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical Context）；有旧摘要时换 `UPDATE_SUMMARIZATION_PROMPT`（`<previous-summary>` 标签合并，支持"压缩的压缩"）；末尾附 `<read-files>/<modified-files>` 文件清单供下次继承。
- **摘要请求隔离**：`cacheRetention: "none"` + 新 `sessionId`（摘要是一次性请求，不写缓存）；maxTokens = `min(0.8×reserveTokens, model.maxTokens)`。
- **落盘与恢复**：压缩 entry `{summary, firstKeptEntryId, tokensBefore, details, usage}` 是普通树节点，**旧消息不删**；构建上下文时"路径上最近 compaction 之前的条目一律跳过"，compaction 本身转成 `compactionSummary` 消息（`<summary>` 标签）进上下文。压缩沿**当前分支路径**做，各分支独立压缩。

**MyAgent 现状**（`agent-model.ts` `compact`）：阈值式触发（`compactAtEstimatedTokens` 默认 90k，仅每轮 `next()` 前检查，无 overflow 分支）；保留**最近 N 轮用户回合**（默认 4）而非 token 预算；无 reserveTokens 概念；无 split turn 处理；摘要请求走同一客户端（不隔离缓存写入）；恢复时 `conversationFromRaw` 找最近 `context_compacted` 事件、`keepFromSeq` 起重建——**恢复语义已与 Pi 等价**（压缩点之前跳过）。**差距**：① token 预算代替轮数（更贴合上下文窗口实际占用）；② overflow 触发 + 自动重试；③ 摘要请求缓存隔离；④ 压缩事件携带 `tokensBefore/after` 用于更好的统计。

---

## 2. 会话状态管理

### 2.1 存储格式对照

| 维度 | Pi JSONL（主路径） | Pi SQLite（新版） | MyAgent |
|---|---|---|---|
| 位置 | `~/.pi/agent/sessions/--<cwd编码>--/<ts>_<uuid>.jsonl` | WAL 单文件 + `migrations` 记账 | `~/.myagent/projects/<base64url>/sessions/<id>.jsonl` + `index.json` + `<id>.trace.jsonl` |
| 树结构 | entry `{type,id,parentId,timestamp}` + `leafId` 指针，**append-only 树** | `entries.parent_id` 权威 + `lanes`/`branch_tips` 派生缓存 | 事件 `seq` 单调 + 事件级 `branchId` 字段，branch_switch 事件即真相 |
| 头部 | `{type:"session",version,id,timestamp,cwd,parentSession}`，v1→v3 原地迁移 | `sessions` 表 + `facts`（标题/书签） | 无头部；元数据在 `index.json` |
| 特殊 entry | `compaction`/`branch_summary`/`custom`（不进上下文）/`custom_message`（进上下文）/`label`（书签）/`session_info`（标题） | 同左 + `records` 运行日志 + `session_stats` 聚合 | 全部是事件（`context_compacted` 等），无书签、无会话内标题 |
| 搜索 | 流式扫描 + 内存过滤 | **FTS5**（trigram） | 无 |
| 并发 | 单进程 | 租约 + fence（防过期写者复写） | 单进程 |
| 写入 | 首个 assistant 前不落盘（避免半截用户消息文件） | 事务 + seq 单调分配 | 事件即写（JSONL 每行一个事件，追加写） |

Pi 注释原文要点（session-manager.ts:844-854）："append-only trees... Appending creates a child of the current leaf. Branching moves the leaf to an earlier entry, allowing new branches **without modifying history**."

### 2.2 回溯 / 分支 / 书签

- **Pi**：`branch(branchFromId)` 只是把 `leafId` 改指旧节点，之后追加的新 entry `parentId = 旧节点`——旧分支一行不动，文件天然是树。`label` entry 做书签（可清除）。`createBranchedSession(leafId)` 把 root→leaf 路径复制进新文件（`parentSession` 指向原文件）实现"提取单条对话线"。**`branch-summarization`**：离开分支前把将被放弃的路径（旧 leaf → 公共祖先）压缩成 `branch_summary` entry 挂在**新位置**，tokenBudget = `contextWindow - reserveTokens`，prompt 结构 `BRANCH_SUMMARY_PROMPT`（Goal/Constraints/Progress/Key Decisions/Next Steps）+ `<read-files>/<modified-files>` 清单；恢复时转 `branchSummary` 消息（`<summary>` 标签）。
- **MyAgent**：`forkBranch(seq, label)` 从任意事件 seq 分裂、`switchBranch` 回溯；`conversationFrom` 按分支链过滤（fork 点之后发生在祖先分支的事件不进入新分支视角）；恢复时 `branchesFromEvents` 重建树。**差距**：① 无书签（label）；② ~~无分支摘要~~（已落地：`branch_summarized` 事件 + `summarizeConversation`，fork/switch 后台触发，见 P1-8）；③ 无"提取单线对话"导出；④ 分支树在事件层重建，粒度 = 事件 seq，与 Pi 的 entry 粒度等价但数据模型不同——改造存储时若要支持"从任意节点继续"的 UI 语义（Pi 的 navigateTree 有 position before/at），事件层方案也够用。

### 2.3 会话恢复

- **Pi**：`open` → 头 4KB 缓冲读 header → 流式按行 parse（坏行跳过）→ 迁移 → `leafId = 最后一条 entry`；`buildContextEntries` = 找路径上最近 compaction → `[compaction] + firstKeptEntryId 之后的旧路径条目 + compaction 之后所有新条目`；`continueRecent` 按 mtime 取最新同 cwd 会话。
- **MyAgent**：读全部记录 → `conversationFrom(records, branches, branchId)` 重建模型消息（含压缩摘要恢复）→ `applyEventState` 恢复累计 token/todos/状态；标题与权限档从 `index.json` 恢复（Pi 从 entry 流恢复，MyAgent 双源）。恢复语义等价；坏行容错已具备（`readRecordedEvents` 走 `readJsonl`，坏行跳过不抛，`utils/fs.ts`）。

### 2.4 跨供应商上下文交接（transform-messages.ts）

**Pi**（`packages/ai/src/api/transform-messages.ts`，每次请求前必跑）：
- `thinking` 块：`redacted`/`thinkingSignature` **仅同模型保留**（provider+api+model 全同），跨模型时 thinking 文本降级为普通 text 块；
- `toolCallId` 归一化：OpenAI Responses 的 450+ 字符 id 重写为 Anthropic 的 `^[a-zA-Z0-9_-]{1,64}$`；
- 跳过 `stopReason === "error"|"aborted"` 的 assistant 消息（残缺回合不重放）；
- **孤儿 toolCall**（无对应 toolResult）自动补合成 `{role:"toolResult", content:"No result provided", isError:true}`；
- `content == null` 的旧数据补 `[]`。
- 另有会话层扩展角色折叠：`bashExecution`/`custom`/`branchSummary`/`compactionSummary` 都折叠为 user 消息。

**MyAgent 现状（2026-08-09 已落地）**：`transformMessages`（`src/model/transform-messages.ts`，每次请求前必跑）——toolCallId 归一化 + 空 tool content 兜底 + **相邻 assistant 合并**（半截回合聚合）+ **孤儿 toolCall 补结果**（`No result provided` + isError）+ **空 assistant 丢弃**（Anthropic `content: []` 400 修复）。恢复路径 `conversationFromRaw` 同步聚合连续 text_delta。thinking 全链路（2026-08-09）：provider 配置 `thinking`/`thinkingBudgetTokens`（**默认开启**——思考质量优先、成本次之；显式 `false` 关闭）→ Anthropic 请求 `thinking:{type:"enabled",budget_tokens}`、响应解析 thinking 块（complete + stream 的 thinking_delta）；**模型不支持 extended thinking（400 含 thinking）自动降级不带 thinking 重试一次**（complete/stream 均覆盖，换便宜模型不卡死）；OpenAI 请求不加 reasoning 参数（兼容第三方端点），响应解析 `reasoning_content`；会话内 assistant 消息携带 `thinking` 字段（不持久化到事件流，与 Pi「仅同模型保留」一致）；wire 构建时按目标供应商能力保留 thinking 块或降级为普通 text（`[思考过程]\n…`）。流式 fallback（2026-08-09）：`FallbackModelClient.#stream` 首候选流式中途失败顺延下一候选以完整请求重放（已吐出的 text_delta 重复属流式固有限制），done 携带 `model` 与 `fallbacks`；abort 立即透传不 fallback。分支摘要客户端随 `applyModelConfigChange` 热刷新。并行模式补发 `tool_call` 事件（恢复时 tool_result 可配对）。

---

## 3. 工具执行与事件流

### 3.1 Bash 执行对照（防挂起是已修过的坑）

| 维度 | Pi（tools/bash.ts + utils/child-process.ts + bash-executor.ts） | MyAgent（tools/bash.ts） |
|---|---|---|
| spawn | `detached: true`（新进程组组长，非 Windows）| `detached: true` + `shell: true` |
| 防挂起 | `waitForChildProcess`：exit 后启动 **100ms 空闲定时器，每次 data 事件重新 arm**——后代持续输出则继续读不丢尾部（修 earendil-works/pi#5303），静默持有句柄 100ms 后 release | exit 后固定 **2s 排空定时器，data 不续期**——子进程持续输出超过 2s 即被当作"输出可能不完整"截断 |
| 杀进程 | 超时 `killProcessTree` 直接 SIGKILL 负 pid（= 整进程组）；exec.ts 路径 SIGTERM→5s→SIGKILL；父进程退出时对全局 `trackedDetachedChildPids` 补刀 | 超时/abort SIGTERM 整组 → 500ms 后 SIGKILL |
| 输出上限 | 50KB/2000 行，滚动缓冲 100KB；**超限全量写 `/tmp/pi-bash-*.log`** 并给 `fullOutputPath` | 12KB/150 行头尾截断；全量留 `traceOutput`（内存，无落盘） |
| 流式 | `OutputAccumulator` + **100ms 节流的 partial 更新**（`tool_execution_update` 事件） | 无流式 partial（只发一次 `tool_result`） |
| abort | 返回**已累积的部分输出**（`cancelled: true` + output + fullOutputPath） | abort 直接 reject（已采集的 stdout/stderr 丢弃） |
| 工具 | `rg`/`fd` 流式执行，达上限 kill 子进程；缺二进制时自动从 GitHub releases 下载 | 进程内 readdir+readFile 全文件扫描（无二进制依赖，但大仓库慢、无 gitignore 感知） |

**MyAgent 差距清单**（按收益排序）：
1. **data 续期**：`onExit` 里 data 事件重新 arm 排空定时器（Pi 的 `EXIT_STDIO_GRACE_MS=100` 模式），修"持续输出的命令被 2s 截断"——当前实现 `sleep 60 && echo done` 这类命令大概率拿到 `outputIncomplete` 警告。
2. **abort 返回部分输出**：`terminateAndReject` 改为收集已累积输出后 resolve（`aborted: true`），UI/模型都能看到中止前的结果。
3. **超限全量落盘**：`traceOutput` 常驻内存，长输出会撑爆会话内存；按 Pi 写 temp file + `fullOutputPath`。
4. **截断策略对齐**：bash 用**保尾**（truncateTail——尾部是命令结果/错误关键），MyAgent 当前统一保头尾（58%/32%），对长构建日志头尾都重要，但 Pi 的取舍（保尾 + temp file 全量）更稳。
5. **grep/find 换 rg/fd**（中期）：大仓库性能差一个量级，且无 gitignore 语义；引入二进制依赖需评估。

### 3.2 事件模型与状态机

**Pi 的 AgentEvent**（agent/types.ts:422-437）：
```
agent_start / agent_end(messages)
turn_start / turn_end(message, toolResults)
message_start(message) / message_update(message, assistantMessageEvent) / message_end(message)
tool_execution_start(toolCallId, toolName, args)
tool_execution_update(toolCallId, toolName, args, partialResult)
tool_execution_end(toolCallId, toolName, result, isError)
```

- **loop 是"流式函数"不是类**：`agentLoop(...) → EventStream<AgentEvent, AgentMessage[]>`；`Agent` 类是状态包装（`AgentState`：systemPrompt/model/thinkingLevel/tools/messages/isStreaming/streamingMessage/pendingToolCalls），事件归约更新状态，listener 按订阅顺序 await。
- **streamFn 契约**：不得 throw / 不得返回 rejected promise；失败必须编码进事件流（`done`/`error` + 最终 `AssistantMessage{stopReason:"error"|"aborted", errorMessage}`）；`stopReason === "length"`（输出截断）时**本批全部 toolCall 直接判失败**（参数可能不完整）。
- **工具并行**：默认 `toolExecution: "parallel"`（prepare 串行 preflight，执行并发，`tool_execution_end` 按完成序、toolResult 消息按 assistant 原始顺序）；`shouldTerminateToolBatch` = 批内每个结果都 `terminate === true`。
- **队列**：`steer()` / `followUp()` 入 `PendingMessageQueue`（mode all / one-at-a-time），loop 排水点取出——与 MyAgent 的 steer 语义一致。

**MyAgent 现状**（agent-loop.ts + events.ts）：事件偏 UI 语义（`text_delta`/`tool_call`/`tool_result`/`ask_permission`/`todo_update`/`cost_update`）；工具默认串行、`behavior.parallelTools` 开启后同批预检全过（无 ask）则并发执行、结果按原始顺序回灌；无 `message_update` 级流式状态（有 text_delta 但工具执行只有 start/end）；`AgentLoop` 是类 + `run()`，`ConversationAgentModel` 兼任状态包装。**差距**：
- ~~并行工具执行~~ ✅ 已落地：`behavior.parallelTools` 配置开关 + 批次预检退化串行（ask 不并行），deny/finalOnly 同步拒绝，结果按 assistant 原始顺序回灌（2026-08-05）；
- ~~length 截断判失败~~ ✅ 已落地：client 解析 `stop_reason`/`finish_reason` → `ModelResponse.stopReason`，`AgentLoop` 在截断回合（max_tokens/length）对本批全部 toolCall 判失败回灌模型，不执行（2026-08-05）；
- `tool_execution_update` 流式 partial（Web/CLI 实时看到命令输出，配合 3.1 的流式收集）。

### 3.3 工具协议与参数校验

**Pi**：
- `AgentToolResult<T> = { content: (Text|Image)[];  // 唯一进 LLM 上下文
  details: T; usage?; terminate?; addedToolNames? }`——read 的 details 带 `{truncation}`，bash 带 `{truncation, fullOutputPath}`，**edit 的 diff 只进 details（UI 渲染），LLM 只看到 `"Successfully replaced N block(s) in <path>."`**。
- 校验：**TypeBox schema + AJV**（`Value.Convert` 类型转换 + 自定义 JSON-schema 递归 coercer + `Compile` 按 schema 缓存）；失败格式 `Validation failed for tool "<name>":\n  - <path>: <message>\nReceived arguments:\n<JSON>`；校验错误包成 toolResult **回给 LLM，不抛 UI**。
- `beforeToolCall`/`afterToolCall` 钩子（拦截/逐字段覆盖），`prepareArguments` 兼容垫片（JSON 字符串参数解析等）。
- 注意：**工具结果里没有 summary 概念**，`content` 就是给模型的文本；MyAgent 的 summary/output 二元组是等价物。

**MyAgent 现状**：AJV schema 驱动校验（`args-validate.ts`：编译缓存 + 类型强转 + 字段级报错 + wire 键名回显，见 P2-15）；**Edit/MultiEdit 的 diff 已移出 LLM 上下文**（output 只报替换块数，diff 进 `details.diff` 供 UI 高亮，审批预览 diff 不受影响，见 P0-3）。

### 3.4 Abort 与重试

**Pi 三层重试**：
1. **assistant turn 级 auto-retry**（agent-session.ts:2637-2748）：`RETRYABLE_PROVIDER_ERROR_PATTERN`（overloaded/rate limit/429/5xx/网络错误/timed out/stream ended…）/ `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`（insufficient_quota/out of budget/billing…）；默认 `{maxRetries: 3, baseDelayMs: 2000}`，退避 `2s/4s/8s`；重试前从 state 摘掉失败 assistant 消息；发 `auto_retry_start/end` 事件。
2. **provider 请求级**（provider-retry.ts）：`x-should-retry` 头优先 → retry-after 头 → `min(0.5×2^n, 8)s` 指数退避 + 25% 抖动；`DEFAULT_MAX_RETRY_DELAY_MS = 60s`。
3. **summarization 重试**（retry.ts:162-211）：`stopReason === "aborted"` 永不重试。

**MyAgent 现状**（2026-08-09 已对齐）：turn 级 `#requestTurn` auto-retry（`agent-loop.ts`）——`error-policy.ts` classifyModelError 三分类（retry/overflow/fatal，quota/认证 fail-closed）+ 指数退避（默认 3 次 2s 起步，可配置）+ **overflow 特例**（上下文超长先 force 压缩再重试一次）+ Retry-After 优先；重试期 abort 立即可中断（见 P1-11）。`FallbackModelClient` 链式降级（complete + **流式**均覆盖，`model_fallback` 事件）。**差距**：无 25% 向下抖动（Pi provider 级公式记录备查，未实现）。

### 3.5 截断对照

| 维度 | Pi | MyAgent |
|---|---|---|
| 策略 | 按工具选方向：`truncateHead`（read/find/grep/ls，保留头部+续读指引）vs `truncateTail`（bash，保留尾部） | 按工具选方向：`preferTail` 头尾预算互换（bash 保尾，其余保头）——已对齐（见 P0-4） |
| 上限 | bash/read `2000 行 / 50KB`；grep 单行 500 字符截断 + `"[... truncated]"` | bash 150 行/12KB、read 256 行/30KB、grep 200 行/20KB、glob 300 行/8KB |
| 单行 | `truncateLine` 500 字符 | 2000 字符 |
| 首行超限 | read 返回空 content + `firstLineExceedsLimit` → 引导 `bash: sed -n 'Np' | head -c` | 头部切片硬截（保留前 58% 预算字符） |

MyAgent 的差异化上限（更激进，符合"控制单轮注入量"方向）其实比 Pi 更省；方向选择已对齐（bash 保尾，P0-4）。剩余差距：**续读指引的精准度**（Pi 的 read 截断提示带精确行号区间）与 **Bash 超限全量落盘**（已实现，P2-16）。

---

## 4. 整体架构对照

### 4.1 分层对照

| 层 | Pi | MyAgent | 备注 |
|---|---|---|---|
| 模型契约 | `pi-ai`：Models/Provider 接口 + models.dev 生成目录 + TypeBox 消息/工具类型 | `src/model/client.ts`：`ConfiguredModelClient` 双协议（anthropic/openai）| MyAgent 单文件双协议够用；Pi 的 40+ provider 靠生成目录，MyAgent 是 3-4 个手工配置 |
| 通用 agent 运行时 | `pi-agent-core`：AgentLoop（流式函数）+ Agent（状态包装）+ StreamFn 契约 | `src/core/agent-loop.ts` + `src/model/agent-model.ts`（会话消息与循环同层）| 差距：MyAgent 的"循环"与"模型上下文管理"耦合在 agent-model 的 `next()` 里，Pi 拆成纯 loop + 消息组装 |
| 应用会话 | `coding-agent`：AgentSession（订阅 Agent 事件 → 持久化/扩展/重试/压缩）+ SessionManager | `src/core/session.ts`（AgentSession 兼任 loop 装配 + 审批 + 任务盒 + 分支）+ `session-manager.ts` | MyAgent 单类 896 行承担的职责，Pi 拆在 session/runner/services 三层；**MyAgent 的 AgentSession 是合理的单文件，不建议照搬拆分** |
| 前端 | pi-tui + modes（interactive/print/rpc） | CLI + Web（Hono/React/SSE） | 事件驱动一致；MyAgent 的事件模型偏 UI 语义是优势（审批/成本/todo 都是事件） |
| 扩展 | 全量扩展系统（jiti 加载、工具/命令/shortcut/UI 组件/messageRenderer/beforeProvider 钩子） | 插件工具通道（`.myagent/tools/` 目录发现 + PluginToolRegistry + MCP 桥接 + 插件面板） | tools 注册面已落地；钩子面未做（见 4.2） |
| 权限 | **无内置**（跑在用户权限下，隔离靠容器） | 三档权限引擎 + 审批流 + 记忆 | MyAgent 的差异化资产，Pi 明确不做 |

### 4.2 扩展机制（Pi 全量 vs MyAgent tools 注册面）

- 加载：项目 `.pi/extensions/` + 全局 `~/.pi/agent/extensions/` + CLI/包 manifest（package.json 的 `"pi"` 字段）；单层目录发现（`*.ts/*.js`、`index.ts`、带 pi 字段的 package.json）；**jiti** 运行时加载 TS；默认导出工厂 `(pi: ExtensionAPI) => void`。
- 挂载点全部在**会话层钩子**而非侵入 loop：`beforeToolCall/afterToolCall`（经 agent hooks 转发）、`message_end` 链式替换、`tool_execution_end` 字段级合并、`before_provider_request`/`before_provider_headers`、`resources_discover`（skill/prompt/theme 路径）、`before_agent_start`（systemPrompt 覆盖）。
- 注册面：tools（`ToolDefinition` 含 `promptSnippet`/`renderCall`/`renderResult`）、slash commands、shortcuts、flags、UI 组件、markdown transformer、provider（`ProviderConfigInput` 覆盖层）。
- **MyAgent 已落地**（tools 注册面）：`.myagent/tools/` 两层目录发现 + `definePluginTool` + 声明式配置注入 + 热重载（面板「重新加载」）+ 单插件禁用（持久化）+ 超时护栏 + MCP server 桥接（stdio/HTTP）——见 `docs/plugin-tools.md`。**未做**：会话层钩子面（`beforeToolCall/afterToolCall`、message 链式替换、UI 组件渲染），参考 Pi 的钩子清单设计——先定钩子面再定加载机制，零侵入。

### 4.3 模型层对照

- Pi：`ModelRuntime`（应用侧单例：内置目录 + 扩展 provider + models.json 三层合成，`recomposeProvider`）+ `model-resolver`（纯策略：CLI → scoped → settings → available 的解析优先级，支持 `pattern:thinkingLevel` 后缀与 glob）+ provider-composer（纯函数合成 auth：`apiKey` 支持字面量/`$ENV`/`!command`）。
- MyAgent：`ConfigService` schema 驱动 + `FallbackModelClient` 链（main/cheap/explore 三角色）+ `/model` 热切换 + 单价计算。**差距**：① ~~无"模型切换后 thinking 转换"~~（已落地：transformMessages + thinking 全链路 + 跨模型降级，见 2.4）；② fallback 是整链顺序（Pi 也是顺序，无差距；MyAgent 流式也已覆盖）；③ MyAgent 的三角色（main/cheap/explore）比 Pi 的"任意模型任意时刻切换"更结构化——这反而是优势（角色 = 固定用途，缓存/成本可预测）。

---

## 5. 改造优先级（对照落地清单）

> 落地记录：P0 五条（2026-08-05 第一轮）+ 本轮（2026-08-05 第二轮）——
> 新增 trace 分析器（`scripts/analyze-traces.ts`，统计 diff 占比 / bash 截断率 / 缓存命中率，为 P0-3 观察项提供数据）、P1 六条、P2 一条。
> 剩余未做：P1-7（缓存写入控制，等供应商层支持）、P1-12（rg/fd 引入，待产品决策）、P2-14（书签）、P2 其余。
> 2026-08-05 第三轮（第一期 5 项）：检索加速（P1-12 的零依赖替代：git ls-files + gitignore 过滤）、stopReason 截断判失败（P1-10 ✅）、session_info 元数据事件（P2-14 前置）、Web 会话搜索（P2-17 ✅）、跨项目记忆开关。
> 2026-08-05 第四轮：P0-3 diff 移出上下文（测量驱动 ✅）、P2-16 Bash 全量落盘（✅）、P2-15 AJV 参数校验（✅，类型强转 + 字段级报错 + wire 键名回显）。
> 2026-08-06 第五轮（Pi 对照修正）：缓存隔离（`cacheRetention: "none"` 省略 cache_control——分支摘要已隔离 ✅，**压缩摘要于 2026-08-09 补上隔离**）、Write 对齐 Pi（无 diff、只报字节数 ✅）、**wire 键名统一**（消灭 camelCase 层：删 normalizeToolArgs/wireToolArgs/WIRE_TO_CAMEL 映射/validateArgs，全程 wire 键名 + schema minLength/minItems 承接非空规则，未知键由 additionalProperties 拒绝并回显 ✅）。provider 级 25% 向下抖动**未落地**（回合级重试未做抖动；Pi 公式记录备查，无对应代码）。

### P0 — 低成本高收益，直接对照改

> 状态：**五条已全部落地**（2026-08-05）。

| # | 改造 | Pi 参照 | 现状 | 预期收益 |
|---|---|---|---|---|
| 1 | **Bash 输出排空 data 续期** | `waitForChildProcess` 100ms 空闲重 arm（child-process.ts:49-137） | ✅ `bash.ts` onExit 排空定时器随 data 续期（固定 2s 窗口改为空闲窗口） | 修复"持续输出命令输出被截断"，无人值守任务高发场景 |
| 2 | **Bash abort 返回部分输出** | `BashResult.cancelled + output + fullOutputPath`（bash-executor.ts） | ✅ `terminateAndResolve`：abort/超时 kill 进程树后以部分输出 resolve（`aborted`/`details.timedOut` 标记） | 中止后模型/UI 可见已执行部分，调试体验质变 |
| 3 | **Edit/MultiEdit diff 移出 LLM 上下文** | `content = "Successfully replaced N block(s)"`，diff 只进 `details`（edit.ts:350-360） | ✅ 测量（1122 轮 trace：Edit 45 次、diff 39.1KB、占输入 0.1%）后落地：output 改简短 summary（含 hunk 数），diff 移入 `details.diff`（Web 渲染优先取之，旧 trace 回退 output），审批预览 diff 不受影响（2026-08-05 第四轮） | 每轮省几十字节~10KB+ 上下文（均值 0.1%，大 diff 场景收益明显）；模型需要时可用 Read 自行核对 |
| 4 | **Bash 截断改保尾** | `truncateTail`（truncate.ts:168-241） | ✅ `truncateToolText` 新增 `preferTail`（头尾预算 32%/58% 互换），bash 启用 | 命令错误/结果在尾部，保尾信息价值更高 |
| 5 | **cache miss 显示阈值 + 默认关开关** | `missedTokens < 20k && missedCost < $0.1` 不显示；`showCacheMissNotices ?? false` | ✅ `shouldShowCacheMissNotice` helper（agent-loop.ts）+ `behavior.showCacheMissNotices` 配置（默认关，CLI/Web 均门控；压缩重置说明不受开关影响） | 消除高频会话的提示噪音 |

### P1 — 中期，涉及核心语义

> 状态：**7/8 条已落地**（P1-7 部分：分支摘要已隔离；压缩摘要 2026-08-09 补 cacheRetention:"none"）。

| # | 改造 | Pi 参照 | 说明 |
|---|---|---|---|
| 6 | **压缩对齐 token 预算** | `reserveTokens: 16384, keepRecentTokens: 20000` + `shouldCompact = tokens > window - reserve`（compaction.ts:235-238） | ✅ `keepRecentTurns` → `keepRecentTokens`（默认 20k，旧键 ×5000 迁移）；`findCompactionCutPoint` 从尾累计 token、切点回退轮起点（tool 不与 assistant 拆开）；会话小于预算不压缩 |
| 7 | **摘要请求缓存隔离** | `cacheRetention: "none"` + 独立 sessionId（compaction.ts:562-581） | ✅ 分支摘要（summarizeConversation）与压缩摘要（compact）均传 `cacheRetention: "none"` 省略 cache_control——一次性辅助请求不写缓存，避免短前缀挤掉主会话缓存条目（2026-08-09 补齐压缩摘要） |
| 8 | **分支摘要（branch-summarization）** | `generateBranchSummary`：切分支前压缩被放弃路径，`<summary>` 注入新分支（branch-summarization.ts:208-280） | ✅ `branch_summarized` 事件 + `summarizeConversation`（独立于压缩管道）+ fork/switch 后台触发（估算 >5k tokens 才摘要）、`conversationFromRaw` 恢复、CLI/Web 渲染；失败不阻断切换 |
| 9 | **工具并行执行（试点）** | `toolExecution: "parallel"`（agent-loop.ts:411-426） | ✅ `behavior.parallelTools` 开关（默认关，热生效）；**预检退串行**——批次含 ask 时整体串行（审批语义不变），deny/finalOnly 并行路径同步拒绝，结果按原始顺序回灌 |
| 10 | **stopReason length 判失败** | `failToolCallsFromTruncatedMessage`（agent-loop.ts:381-406） | ✅ client 解析 `stop_reason`/`finish_reason`（非流式 + 流式全覆盖）→ `ModelResponse.stopReason`；截断回合（max_tokens/length）本批全部 toolCall 判失败回灌模型，不执行（2026-08-05 第三轮） |
| 11 | **turn 级 auto-retry** | RETRYABLE/NON_RETRYABLE pattern + `2s/4s/8s`（agent-session.ts:2637-2748） | ✅ `retry-policy.ts`（classifyModelError：retry/overflow/fatal 三分类，quota/认证 fail-closed）+ loop 内 `#requestTurn` 指数退避（默认 3 次 2s 起步，可配置）；**overflow 特例**：上下文超长先 force 压缩再重试一次；重试期 abort 立即可中断 |
| 12 | **Grep/Glob 换 rg/fd** | grep.ts/find.ts 流式 + kill-at-limit + gitignore 感知 | 部分覆盖：`git ls-files` + 根 `.gitignore` 前缀过滤已实现主要收益（gitignore 语义 + 免全量遍历，2026-08-05 第三轮）；rg 的剩余价值（非 git 目录完整 gitignore 语义、流式 kill-at-limit）待产品决策是否引入二进制依赖 |

### P2 — 架构级 / 按需

| # | 改造 | Pi 参照 | 说明 |
|---|---|---|---|
| 13 | **消息转换层（transform）** | transform-messages.ts：跳过 error/aborted 回合 + 孤儿 toolCall 补结果 + toolCallId 归一化 | ✅ 完整版已落地（2026-08-09）：`transformMessages`（src/model/transform-messages.ts）——toolCallId 重写 + 空 content 兜底 + **相邻 assistant 合并**（半截回合聚合）+ **孤儿 toolCall 补结果**（中断批次不再缺配对）+ **空 assistant 丢弃**（Anthropic 400 修复）；恢复路径 conversationFromRaw 同步聚合连续 text_delta；并行模式补发 tool_call 事件 |
| 14 | **书签（label）与会话标题 entry** | `label`/`session_info` entry（session-manager.ts:1232-1253） | 长会话导航；MyAgent 标题在 index.json（重启可恢复），书签无 |
| 15 | **TypeBox 参数校验** | AJV + Value.Convert + coercer（validation.ts:285-317） | ✅ `args-validate.ts`（AJV 编译缓存 + coerceTypes 强转 + 字段级报错）：参数全程 wire 键名直接校验 inputSchema（2026-08-05 第四轮）；2026-08-06 第五轮随 wire 统一删除映射层，非空规则以 minLength/minItems 进 schema，未知键 additionalProperties 拒绝并回显 Received | 替代手写 validateArgs；报错更精确可定位字段；补"类型强转"语义（模型常发 string 数字） |
| 16 | **Bash 超限全量落盘** | `/tmp/pi-bash-*.log` + `fullOutputPath`（bash-executor.ts:64-87） | ✅ 输出截断时全量 stdout/stderr 落盘 `<tmp>/myagent-bash-<pid>-<seq>.log`，details.fullOutputPath + summary 附路径（模型可 Read 查看）；abort/超时路径同样覆盖（2026-08-05 第四轮） | `traceOutput` 内存常驻的兜底；配合 P0-4 |
| 17 | **会话搜索** | FTS5 / 流式扫描 + allMessagesText（session-manager.ts:687-765） | ✅ Web 端会话列表搜索：`firstMessage` 进 summary + 侧栏标题/首条消息过滤（不引 SQLite，2026-08-05 第三轮）；全文搜索仍可选 |

### 明确不做（对照后维持现状）

- **SQLite 落库**：MyAgent 单进程、会话量小，JSONL + 事件重建已够；等搜索/并发写者成为真实需求再说。
- **扩展系统钩子面**：tools 注册面已落地（`.myagent/tools/` + MCP 桥接 + 插件面板）；未做的是会话层**钩子面**（beforeToolCall/afterToolCall + 事件转发），如未来需要再做。
- **Lazy skills**：MyAgent 已有"记忆注入 + 动态工具集"，skills 的增量价值依赖生态；若用户要求自定义能力，可先做 `/skill:` 的读文件注入（一行代码级）。
- **AgentHarness 形态**（Result 非抛错契约、ExecutionEnv 抽象）：工程风格差异，非能力差距。
- **AGENTS.md 祖先链分层**：MyAgent 单仓库场景，cwd 根 + 全局两层已覆盖。

---

## 6. 附：关键常量速查表

| 常量 | Pi 值 | MyAgent 值 | 备注 |
|---|---|---|---|
| 缓存 miss 噪音底 | 1024 tokens | 1024 tokens | 同源 ✓ |
| 缓存 TTL（idle 归因） | 5 min | 5 min（agent-loop.ts:462） | 同源 ✓ |
| miss 显示阈值 | <20k && <$0.1 | 同（`shouldShowCacheMissNotice`，开关默认关） | P0-5 ✅ |
| 压缩保留量 | keepRecentTokens 20000 / reserveTokens 16384 | keepRecentTokens 20000（旧键 ×5000 迁移） | P1-6 ✅ |
| 压缩触发 | `tokens > window - 16384` | `estTokens > 90_000`（配置） | P1-6 ✅ |
| 摘要请求缓存 | `cacheRetention:"none"` + 新 sessionId | 分支摘要 + 压缩摘要均传 `cacheRetention:"none"` | P1-7 ✅ |
| Bash 输出上限 | 2000 行 / 50KB + temp file 全量 | 150 行 / 12KB + 超限全量落盘（`details.fullOutputPath`） | P2-16 ✅ |
| Bash 排空宽限 | 100ms 空闲（data 续期） | 空闲窗口 data 续期（原 2s 固定已改） | P0-1 ✅ |
| Bash abort | 返回部分输出 | abort/超时 kill 后以部分输出 resolve（`aborted`/`details.timedOut`） | P0-2 ✅ |
| 工具执行 | 默认并行 | `behavior.parallelTools` 开关（默认关，ask 批次退串行） | P1-9 ✅ |
| 请求重试 | 3 次 2s/4s/8s（turn 级）+ provider 级 0.5×2^n ≤8s + 25% 抖动 | turn 级 3 次 2s 起步（可配置）+ overflow 特例；**无 25% 抖动** | P1-11 ✅（抖动未做） |
| 行内截断 | grep 500 字符 | 2000 字符 | 差异不大，可不动 |

---

## 7. 方法与遗留

- 本次分析基于 `/tmp/pi-reference`（`git clone --depth 1`，05bf9df）。Pi 演进很快（调研文档 08-03 的"会话树分支"尚未落地时，仓库已有 label/branch_summary/SQLite/FTS5/租约），**落地某一条前应重新拉取对应文件核对行号与接口**。
- 未深入但值得后续看的：`packages/coding-agent/src/core/timings.ts`（启动性能计时，`PI_TIMING=1`）、`output-guard.ts`、`trust-manager.ts`（项目信任两段式）、`export-html/`（会话导出）、`http-dispatcher.ts` + `client/`（远程会话，对标 MyAgent 远程审批场景的下一步）。
- 若团队想保留一份可随时查阅的本地 Pi 源码，建议固定版本（如 git tag v0.83.0）放入仓库外目录，并在本文头部记录版本。
