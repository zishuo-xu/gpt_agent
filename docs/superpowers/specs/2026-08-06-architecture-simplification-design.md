# MyAgent 架构简化设计

> 日期：2026-08-06
> 范围：全面简化（清理去重 + 机制合并 + 结构重构），无硬约束（存储/UI/测试均允许调整，以行为不变为验收基线）

## 背景与目标

MyAgent（本地编码 agent，TypeScript + Node.js ≥22，CLI + Web 双前端）近两周叠加了大量 Pi 参照功能（steer、缓存归因、分支、并行工具、详情拆分），产生三类债务：

1. **纯重复**：成本公式 ×3、原子写 ×4、readOptional ×3、stringify ×2+、appendEndpoint ×2、abortableSleep ×2、escapeRegExp ×2、工具名枚举 ×4、死代码若干
2. **双机制并存**：双层重试栈、双错误分类器、会话元数据双写（事件流 + index.json）、双事件扇出、文件收集 ×2、只读规则 ×2、配置写入 ×2
3. **结构问题**：core↔model↔tools 三角依赖、`session.ts`(1015 行) god object、前端手写 3 处后端类型副本、多个 >1400 行大文件

## 已确认的语义决策

| 决策 | 结论 |
|---|---|
| 重试栈 | 保留回合级（`AgentLoop.#requestTurn` + 错误分类），删除请求级（`ResilientModelClient`） |
| index.json | 删除，元数据全部从事件流推导 |
| 落地节奏 | 分三期（A 清理 → B 机制合并 → C 结构），每阶段 typecheck+test 全绿、独立提交 |

## Phase A — 清理与去重（低风险）

### A1 删死代码
- `src/utils/greeting.ts` + `tests/greeting.test.ts`
- `RepoMap.invalidate()` + `repo-map.test.ts` 对应用例（无生产调用方）
- `web/sessions.ts` 的 `WebAgentSession` 别名 → 测试（`e2e-workflow.test.ts`、`sessions.test.ts`）改 import `AgentSession`
- `stats/trace-stats.ts` 的 `AgentTurnTraceLike` 别名

**保留**（有测试直接消费，非死代码）：`branchChain`/`filterRecordsForBranch`/`formatSubagentConclusion`；`compileBounds` 本就是内部函数。

### A2 共享工具模块 `src/utils/`
| 新模块 | 合并内容 |
|---|---|
| `utils/fs.ts` | `atomicWriteFile(path, content, opts)`（config/service、session-manager、web/memory、tools/atomic-file 的 temp+fsync+rename 四份）；`readOptional(path)`（context、atomic-file、web/memory 三份） |
| `utils/cost.ts` | `usageCostCny(usage, pricing)`（agent-loop:712 与 session.ts:1003 两份；missedCost 语义特殊留在 agent-loop） |
| `utils/stringify.ts` | `stringify`（branch.ts、session-manager.ts 两份；agent-model 的 stringifyOutput 若语义一致则合并） |
| `utils/sleep.ts` | `abortableSleep`（agent-loop、resilient-client 两份） |
| `utils/regexp.ts` | `escapeRegExp`（permissions、executor 两份） |

### A3 工具名目录单一化
- 新建 `src/shared/tool-names.ts`：`TOOL_NAMES` as const 数组 + 派生 `ToolName` 类型 + `isToolName` 守卫
- `core/types.ts` re-export `ToolName`；`client.ts`、`permissions.ts`（STRICT_GATED/NORMAL_AUTO）、`trace-stats.ts`（DIFF_TOOLS）改为从目录派生/引用，子集用 `satisfies ToolName[]` 编译期守护

### A4 appendEndpoint 去重
- `client.ts` 导出 `appendEndpoint`，`test-connection.ts` 复用（删本地副本）

### A5 测试合并
- `task-box.test.ts` 并入 `run-task.test.ts` 后删除

### A6 仓库杂物
- 删除：`.qoder/`（分析产物）、`.playwright-cli/`（436 个抓取日志）、`test-todo-api/`（grep 确认零引用）——已在基线提交中完成
- `设计方案/` 经核实已在版本控制中（commit 718a5ca/67a0516/af9b554，内容与 HEAD 一致），无需动作

## Phase B — 机制合并（中风险）

### B1 重试栈合一
- 删除 `ResilientModelClient` 类；`session-manager.ts:347` 直接使用内层 client
- `resilient-client.ts` 改名 `fallback-client.ts`，只留 `FallbackModelClient` + `ModelRetriesExhaustedError` + abort 判定
- 回合级 `#requestTurn` 退避补 Retry-After 支持（`max(退避, retryAfterMs)`），弥补请求级 Retry-After 丢失
- 错误行为不变：fallback 链耗尽仍抛 `ModelRetriesExhaustedError`，session.ts:638 的指引分支照常
- 测试：`resilient-client.test.ts` 删重试用例、留 fallback 用例

### B2 错误分类合一
- `retry-policy.ts` + `error-guidance.ts` 合并为 `model/error-policy.ts`：
  - 机器分类 `classifyModelError → RetryPolicy`（retry/overflow/fatal，pattern 表唯一来源）
  - 用户指引 `modelErrorGuidance`/`modelErrorGuidanceText`：status 分支保留（401/403→auth、402→balance、404→not_found、429→rate_limit、5xx→server），message 分支改消费机器分类（fatal→balance/unknown、retry→network、新增 overflow 指引文案）
  - 删除 error-guidance 的 `NETWORK_PATTERNS`/`BALANCE_PATTERNS`（与 retry-policy 重叠）
- import 更新：agent-loop、session

### B3 删 index.json
- `session-manager.ts` 删 `SessionIndexEntry`/`SessionIndexFile`/`#indexPath`/`#readIndex`/`#queueIndexWrite`/`#indexWriteTail` 及全部调用点
- restore 的 title/permissionMode 兜底直接用事件流：`sessionInfoTitle(records)`、`lastPermissionMode(records) ?? runtimeConfig.permissions.mode`
- `runTask` finally 恢复权限档时补发 `permission_mode_changed` 事件（唯一的行为性新增，保证恢复保真）
- 会话列表本就来自 restore 后的内存注册表，无额外改动

### B4 事件扇出合并
- `session.ts` 删 `#listeners` Set；`subscribe()` 改为 `#bus.subscribe` 薄包装（复用刚记录的同一条 record，保证 seq/ts 一致）

### B5 文件收集合一
- `executor.collectFiles`（git ls-files + gitignore）提取为共享实现，`RepoMap.#collectFiles` 复用（支持 depth 参数）
- 统一忽略列表（合并 `IGNORED_DIRS` 与 `IGNORED_DIRECTORIES` 的分歧：`.myagent`/`.venv`/`target`）

### B6 只读规则合一
- `TaskRunner` readonlyRules 与 `web/sessions.ts` LOBBY_PERMISSION_RULES 合并为共享常量（permissions.ts 导出 `READONLY_DENY_RULES`），两处引用

### B7 配置写入合一
- `web/src/config-path.ts` 移到 `src/config/config-path.ts`（框架无关）；CLI `setConfigValue`（cli.ts:727-758）改用它（统一为不可变更新语义），CLI 调用点适配

## Phase C — 结构重构（高风险）

### C1 分层修正（三角 → 单向）
- `model/agent-model.ts` → `core/agent-model.ts`（上下文组装/压缩/系统提示是运行时职责）
- `model/tool-definitions.ts` → `tools/tool-definitions.ts`（工具定义归工具层）
- 结果：`model/` 只剩纯协议（client/fallback-client/error-policy/test-connection/types），**运行时零 core 依赖**
- 依赖方向：model → core ← tools → model（仅类型）；全部 import 改写，编译期验证

### C2 大文件拆分（验收：无行为变化 + 目标行数）
| 文件 | 拆分 |
|---|---|
| `core/session.ts`(1015) | 拆 `session-branch.ts`（BranchCoordinator：fork/switch/摘要队列，~180 行）+ `session-approval.ts`（PermissionWaiter：审批等待/超时/记忆，~90 行）→ 目标 <700 |
| `cli.ts`(820) | 拆 `cli-render.ts`（renderEvent 30+ 分支，~300 行）→ 目标 <400 |
| `web/src/SessionApp.tsx`(1975) | 拆 `session-display.ts`（buildDisplayItems 纯函数）+ `SessionDetails.tsx`（diff 高亮/退出码/折叠） |
| `web/src/App.tsx`(1443) | 按设置分区拆 `web/src/settings/` 组件 |
| `web/src/styles.css`(3223) | 拆 `styles/{base,chat,settings,memory}.css` |

### C3 类型单一化
- 新建 `src/shared/types.ts`（纯类型、零运行时）：`SessionSummary`/`SessionBranch`/`RecordedEvent`/`MemoryDocument`/`TimelineEntry`/`ConnectionTestResult`/公共配置类型
- 后端各模块（core/session、core/types、web/memory、model/test-connection、config/schema）re-export 自该模块
- 前端经 `@shared` 别名引入：`web/vite.config.ts` 加 `resolve.alias` + `server.fs.allow`，`web/tsconfig.json` 加 `paths`；type-only import 构建期擦除，不产生运行时后端依赖
- `AgentSessionEvent` 与 `RecordedEvent` 统一为单一接口（`sessionId` 可选），删 `AgentSessionEvent`、`WebSessionEvent` 别名改引 `RecordedEvent`

## 验收与风险

- 每阶段：`pnpm run typecheck` + `pnpm test` 全绿；Phase C 追加 `pnpm run build`
- 行为不变由现有 29 个测试文件兜底（B 组按变更调整相应测试）
- 已知行为性新增：仅 B3 的 `permission_mode_changed` 补发事件
- 风险点：B1 后瞬态错误仅回合级重试（3 次 2s→8s，成本行为与请求级重发一致）；B3 需确认 run 会话权限档恢复保真；C1/C3 为纯搬移+类型改写，编译期验证

## 提交计划
1. A0：基线提交当前工作树
2. 设计文档提交
3. Phase A 提交
4. Phase B 提交
5. Phase C 提交

## 落地记录（2026-08-06 执行完毕）

- A0 基线 `c921ab3`；Phase A `9e50b15`；Phase B `dc2bfd3`；Phase C `2d66b0a`。全部阶段 `typecheck` + `test` 全绿，Phase C 追加 `build` 通过。
- 与设计的偏差（均为有意取舍）：
  - A1 保留被测试直接消费的导出（`branchChain`/`filterRecordsForBranch`/`formatSubagentConclusion`），仅删真正死代码。
  - A6 的 `设计方案/` 经核实早已在版本控制中，无需动作。
  - B3 落地时发现 createSession 的显式标题从未进事件流（构造函数直设），补了 `setTitle` 同名放开 + createSession 显式标题写事件流；`RecordedEvent.sessionId` 改为可选（落盘时补齐）。
  - C2 仅拆分有验证覆盖/纯函数化的部分：`session.ts`(1015→798) 拆出 `session-branch.ts`+`session-approval.ts`，`cli.ts`(820→658) 拆出 `cli-render.ts`，`SessionApp.tsx`(1975→1729) 拆出 `session-display.ts`。`App.tsx`(1443) 与 `styles.css`(3223) 未拆：纯组件/CSS 重排、无测试覆盖且无法视觉验证，收益低于回归风险，留待后续按需处理。
