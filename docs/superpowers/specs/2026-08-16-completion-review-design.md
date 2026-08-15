# 任务验收链设计：完成审查 + 完成报告

> 2026-08-16 · 来源：0→1 搭建评测（deepseek-v4-flash "纸上谈兵"假完成）+ 整体方向确认
> 定位：把"兜底"升级为"把关"——模型宣布完成后、交付用户前，加一道独立验证

## 背景

评测确认：便宜模型会在思考里规划完整方案后直接宣布完成（0 工具调用、目录全空）。现有机制（done 拦截、0 工具提示）都是"事后发现"，没有"确保干好"。设计一个任务验收链：**干活（cheap 模型）→ 审查（独立验证）→ 报告（结构化交付）**。审查复用 TaskRunner 骨架（独立上下文 + 只读工具 + 结论回流），模型用 main 角色当前配置（用户确认：不新增 review 角色，直接用现有模型）。

## 触发（session.sendInput 主循环，AgentLoop done 后）

- 触发条件（任一满足即审查）：
  1. 会话累计存在文件写操作（EditJournal entries > 0 或 fileOps.modified 非空）
  2. taskMode（/run 任务）
  3. 手动 `/review` 命令（交互模式显式请求）
- 纯问答（无写操作、非任务）跳过——不浪费模型调用
- 配置开关：`behavior.completionReview`（默认 true，false 关闭）
- 审查循环上限：每轮完成最多 2 次（reviewAttempts），超限放行并标记"审查未通过"

## 审查执行（复用 TaskRunner 骨架）

- 新 `TaskRunner` 运行：独立 `ConversationAgentModel`（main 角色 client，fresh context）+ 只读工具集 + Bash（跑验证命令，权限走正常判定、审批冒泡）
- 审查 prompt 组装（输入）：
  - 任务要求：本轮用户消息原文（taskMode 下含 --goal）
  - 改动文件清单（EditJournal / fileOps.modified）
  - 最近一次验证命令（test/build）的 tool_result summary（如有）
  - todo 状态快照
  - 指令："逐项核对任务要求是否满足；用 Read/Grep/Bash（仅验证类命令）自证；输出：通过/不通过 + 问题清单（文件:行号证据）+ 未确认项"
- 事件：复用 `task_start/task_end`（description 前缀 `[完成审查]`）；新增 `review_result` 事件（{passed, issues, summary}）供 UI 渲染
- 结论解析：三段式（结论 / 问题清单 / 未确认），与子代理结论解析同构

## 打回循环

- `review_result.passed === false` → `#model.addUserMessage("完成审查未通过：<问题清单>\n请修复这些问题并重新验证后再次宣布完成。")` → 主循环 continue（再跑一轮 AgentLoop）
- 审查通过 / 达到上限（2 次）→ 正常结束
- 会话 summary 增加 `review?: { passed: boolean; attempts: number }`（从事件流推导，Web 展示徽标）

## 完成报告（交付环节）

- 审查结束后生成结构化报告（CLI 输出 + Web 卡片；/run 收尾总结并入）：
  1. 改动文件（fileOps.modified，数量 + 列表）
  2. 验证结果（最近一次 test/build tool_result summary；无则明示"未运行验证"）
  3. 审查结论（通过 / 未通过 + 问题清单）
  4. 运行指引（模型最终回复末段或审查结论中的启动说明）

## 可观测性

- `review_result` 事件写入 JSONL（回放可见）
- CLI：审查开始/结论输出（`◇ [完成审查] 任务名` / `审查通过 ✓` / `审查未通过 ✗ + 问题数`）
- Web：会话尾部"审查"卡片（通过/未通过 + 问题清单），会话头部徽标"已审查"
- 成本：审查运行计入会话统计（task_end 已有成本归因）

## 配置

- `behavior.completionReview: boolean`（默认 true，Schema 增加）
- 审查模型：main 角色 client（不新增角色；用户确认"都用这两个模型"）

## 测试

- 触发条件：有写操作触发 / 纯问答跳过 / /run 触发 / 开关关闭不触发
- 审查流程：通过（注入 review_result passed）→ 会话正常结束；不通过 → 打回注入消息 → 再跑；上限 2 次后放行
- review_result 事件与 summary.review 推导
- Web：审查卡片与徽标渲染
- 回归：真实任务跑一次（搭项目场景），确认审查触发、产出真实、报告完整

## 明确不做

- 新增 review 模型角色（用户确认用现有模型）
- 审查结果自动修文件（审查只报问题，修复走主循环打回）
- 浏览器视觉验证（审查的验证能力之一，仍为后续独立项）
