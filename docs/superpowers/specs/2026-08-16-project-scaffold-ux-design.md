# 从 0 搭建项目场景的易用性与功能性优化设计

> 2026-08-16 · 来源：真实任务评测（空目录搭 React+TS 待办应用，normal 档）
> 范围：A 完成可信度 + todo 纪律 / B 审批卡片信息质量 / C Web 任务清单可见性

## 背景与问题（评测复现）

在空目录运行"从零搭建待办应用（含测试、build、git 提交）"，agent 112 秒后宣布完成，实际只完成脚手架 + 装依赖：6 项 todo 未更新（含已完成的第 1 项），全程未调用 Write/Edit 写业务代码，未跑 build/test，未 git init，最终回复无交付说明。同时 Web 端任务清单默认收起且无三态标记，审批卡片 6 次全部"命令副作用未知"。

## A. 完成可信度 + todo 纪律

### A-1 系统提示词强化（src/core/agent-model.ts）

- PROMPT_RESPECT 增加"完成协议"段落：
  1. 宣布完成前必须更新 TodoWrite：已完成的项标记 completed；未完成或放弃的项说明原因（不得静默保留 in_progress/pending）。
  2. 宣布完成前必须运行项目已配置的验证命令（test / build / lint / typecheck 中存在的）；项目无验证命令时在最终回复中说明理由。
  3. 禁止"只输出计划"：计划要写文件就必须调用 Write/Edit；未执行的计划不算完成。
- 目标文件：`src/core/agent-model.ts` 的 PROMPT 常量（PROMPT_RESPECT 及新增段落）。

### A-2 协议层 done 校验（src/core/agent-loop.ts）

- done 判定处（`turn.done`）增加校验：会话存在未完成 todo（非 completed 项）→ 软拦截：
  - 注入一条 user 消息："你宣布任务完成，但任务清单仍有 N 项未完成或未更新：<清单>。请先更新任务清单（完成的项标记 completed，放弃的项在回复中说明原因），并运行项目已配置的验证命令（build/test/lint/typecheck 中存在的；项目无验证命令时在回复中说明）。若确实已全部完成，直接再次宣布完成即可。"
  - 同时发 `notify(warn)`（界面可见"完成声明已拦截"）。
  - 模型继续跑；再次宣布完成则继续拦截（最多 2 次），第 3 次放行——防死循环。
- 实现决策（相对设计稿微调）：拦截条件从"未完成项且本轮未调用 TodoWrite"简化为"存在非 completed 项即拦截"——覆盖模型"更新了部分 todo 但仍宣布完成"的变体，行为更可预测；"本轮更新过 todo"的模型本轮一般不会同时宣布完成，若发生也值得提示。
- 触发范围：仅 `turn.done`（模型宣布完成），不影响 `allTerminated`（P0-4 terminate 语义，子代理收尾）与子代理循环（TaskRunner 不传 getTodos）。
- 不做硬拒绝：无 todo 的会话（闲聊/单步任务）不受影响（getTodos 返回空即放行）。

## B. 审批卡片信息质量

### B-1 风险翻译规则库扩充（src/core/agent-loop.ts riskFor）

- 修复 `^` 锚定缺陷：Bash 命令先去前缀 `cd <dir> && ` / `cd <dir>; `（连续多个）后再匹配规则；新增规则：
  - `(npm|pnpm|yarn) create` → "将生成项目脚手架文件"
  - `git init` → "将初始化 git 仓库"
  - `git commit` → "将创建本地提交"
  - `(npm|pnpm) dlx|npx` → "将下载并执行包（脚手架/一次性命令）"
  - 保留原有规则（install/add、git push、rm、sudo、curl|sh 等）。
- 规则匹配改为对"去 cd 前缀后的命令"执行，返回值说明保持原有文案风格。

### B-2 审批附"Agent 目的"（ask_permission.purpose）

- `AgentEvent` 的 `ask_permission` 增加可选 `purpose?: string`。
- agent-loop 每轮累计模型文本（text_delta 聚合），emit ask_permission 时取最近一段模型文本的末尾摘要（截断 ~80 字符）作为 purpose；无文本则不携带。
- 展示：
  - CLI（src/cli-render.ts）：审批行追加 `目的：<purpose>`。
  - Web（src/web/api-v1.ts 透传 + web/src 审批卡片组件）：卡片显示"Agent 目的"行。
- 兼容：purpose 缺省时 UI 不渲染该行（老会话回放无此字段）。

## C. Web 任务清单可见性

### C-1 默认展开（web/src/SessionApp.tsx）

- `showDetail` 初始值由 false 改为：会话加载后若存在 todo_update 事件（latestTodos 非空）则为 true（有 todo 才自动展开，避免普通会话被撑开）。

### C-2 三态标记（web/src/session-rail.tsx + CSS）

- 任务清单项左侧标记：completed ✓ / in_progress → / pending ○；沿用现有 `rail-todo ${status}` 类，补充 in_progress/pending 的视觉样式（当前只有 completed 有 ✓，CSS 类可能已定义颜色，需确认并补齐）。

### C-3 完成与 todo 矛盾提示（web/src/session-rail.tsx 或 SessionApp）

- 会话状态为"已完成"（done）且 latestTodos 存在非 completed 项时，任务清单卡片顶部显示警告条："Agent 已宣布完成，但仍有 N 项任务未完成或未更新"。
- 数据来源：会话 summary/status + latestTodos（已有）。

## 测试

- 单测（src/core/agent-loop.test.ts）：done 校验——有未完成 todo 且本轮无 TodoWrite 时软拦截注入消息；第二次宣布完成放行；超过 2 次强制 done。
- 单测（src/core/*.test.ts）：riskFor 新规则（cd 前缀 + pnpm create / git init / git commit / npx）。
- 单测（web/src/*.test.tsx）：三态标记渲染、默认展开、矛盾警告条。
- 回归：用评测同款"搭待办应用"任务重跑（CLI + Web），确认不再"宣布完成但没写代码"；审批卡片显示目的与准确风险翻译。

## 明确不做

- 浏览器/UI 验证工具（Playwright 截图）——独立设计，后续单独排期。
- Bash stdin 交互（PTY 支持）——模型已能用非交互参数规避，风险低，暂缓。
- /init 空目录特化——次要。
