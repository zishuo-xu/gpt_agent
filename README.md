# MyAgent - 无人值守编码 Agent

MyAgent 是一个面向长时间自主运行任务的本机编码 Agent：把自然语言任务交给它，它会在你的代码库里自主探索、编辑文件、运行命令、自我修正，需要你决策时才停下来征求批准。无人值守模式下可设时间/预算边界，跑完自动收尾。

远程仓库：https://github.com/zishuo-xu/gpt_agent

## 当前能力

### 核心闭环

- **自主编码**：自然语言任务 → Read / Grep / Glob / Edit / MultiEdit / Write / Bash / TodoWrite / Task 工具集
- **todo 可视化**：多步骤任务自动建清单，实时翻转状态
- **原子文件编辑**：临时文件 + rename，中止不留半文件；EditJournal 记录每次编辑，收尾可精确撤销
- **统一硬中止**：Esc 立即取消模型与当前工具；Bash 终止整个进程组
- **任务验收链（开发验证用）**：`behavior.completionReview` 开启或 `/review` 手动触发时，任务完成后运行独立审查（读文件/跑验证命令核对任务要求），不通过自动打回修复（最多 2 次）；运行时默认关闭——不增加成本与延迟，纯问答不触发

### 权限安全（strict / normal / trust 三档）

- strict：写操作与 Bash 全部弹批准；normal：只读与 Edit 自动放行，Write 与灰区 Bash 弹批准；trust：deny 与显式 ask 外全部自动执行
- **看完再批**：Edit/Write 批准前展示真实 diff（±3 行上下文）；Bash 显示命令原文 + 风险翻译（依赖安装/脚手架/git 提交等常见命令有明确翻译，并附 Agent 本轮意图）
- 批准记忆四级：仅一次 / 本次会话 / 本项目 / 全局
- deny 是硬边界，任何档位不豁免；审批超时无人响应自动拒绝（fail-closed）

### 无人值守（/run）

- 任务三要素：`--goal` 机器可判定验收、`--bounds` 负面清单（编译为 deny 硬规则，启动前确认）、`--until/--budget` 时间/预算盒
- 优雅终止：分阶段收窄范围 → 收尾 → 纯总结，产出总结报告 + todo 快照 + 记忆写入
- `--permission trust` 任务期生效，结束后回落原档位
- **任务级审批控制**：`--approve-timeout 30`（任务期审批超时秒数，无人值守不再干等 5 分钟）、`--auto-allow "Bash(pnpm*),Read(*)"`（任务期自动放行规则白名单，结束回落）
- **定时触发**：`--at 09:00` / `--every 30`（可组合），Web 服务端每 30s 轮询到期自动启动会话；注册 / 取消在「定时任务」面板（含上次触发结果与会话），持久化于 `scheduled.jsonl`，重启保留

### 子代理（Task）

- 探索类任务派生独立上下文的子代理（空白上下文 + 主 Agent 自写 prompt），只回流三段式结论（结论 / 关键证据 / 未确认）
- 默认只读、explore 角色模型；嵌套 ≤2 层、并发 ≤4、最多 40 轮强制收尾；失败降级为工具结果返回主 Agent

### 记忆复利

- 记忆共四类：`preferences`（全局）+ `conventions` / `pitfalls` / `decisions`（项目级）
- 全局记忆：`~/.myagent/MEMORY.md`；干活中学到的稳定事实自动写入，下次会话自动注入；项目级记忆：`AGENTS.md`（/init 生成）+ `.myagent/memory/`（conventions / pitfalls / decisions），随项目使用累积
- 跨项目联想：新会话注入他项目记忆的标题索引，相关时自动调取全文

### Web 界面（myagent --web）

- **监控台**：所有会话实时状态卡（进度 / 花费 / 时长），审批请求标签页标题提示
- **会话详情**：完整事件流（文本 / 工具 / diff / 子代理卡片）、回放模式、可继续追问；任务清单三态标记（✓/→/○）自动展开，完成但存在未完成项或零工具调用时显示警告条
- **记忆面板**：四类记忆直接编辑 / 删除，自动写入有时间线审计
- **定时任务面板**：按项目注册 / 取消定时 `/run`（`--at` / `--every`），到期服务端自动启动会话；启动失败自动重试（5 分钟 × 3 次后丢弃），可设**每日花费上限**（超限顺延）；每行展示上次触发结果与会话
- **任务统计面板**：会话用量聚合（完成 / 失败 / 中断 / tokens / 费用），按天分桶纯 CSS 柱状图 + **按模型/供应商成本维度表** + 会话明细表（含 /run 收尾总结查看）
- **结果触达**：webhook（企业微信 / 飞书 / Bark / 通用 JSON）与 macOS 桌面通知——任务完成 / 失败 / 中断 / 出错 / 审批超时推送，/run 收尾推送含耗时与费用（通用网关附带结构化字段 status/costCny/tokens/durationMs/sessionId）；**保留策略**：超过 `sessionRetentionDays`（默认 30 天）未更新的会话启动与每日自动清理
- **设置页**：供应商 / 角色模型 / 权限规则 / 行为参数 / 服务器（监听地址与访问密码），Schema 驱动自动生成，全局 / 项目双作用域
- **远程审批**：监听非 localhost + 访问密码，手机浏览器可审批（E2E 验证）

### 插件扩展（.myagent/tools/）

- **插件通道**：`.myagent/tools/*.ts`（项目）或 `~/.myagent/tools/`（全局，项目覆盖）写一个 `definePluginTool` 即接入——注册、模型可见、执行分发、权限审批、UI 渲染全走通用通道，与内置工具无差别；normal 档首次调用审批后同会话通配放行
- **WebSearch**：网络搜索。searxng 自托管（本机 Docker）→ tavily（可选云 API）→ HTML 引擎链（bing/ddg/baidu）兜底，原则本地自托管优先、不依赖第三方 API Key；**深度模式**默认自动抓取前 2 个结果页正文，一次调用即得素材
- **WebFetch**：反爬增强的页面抓取（浏览器级请求头 / 失败重试 / 可选 cookie）
- **MCP 接入**：`plugins.json` 的 `mcpServers` 段配置后，MCP server 工具自动注册进插件通道（stdio 子进程 / 远端 HTTP 双传输），权限与 UI 与普通插件一致
- **插件面板**：加载清单 / 加载错误 / 调用统计可视化，热重载（「重新加载」按钮，无需重启 server）、单插件启用/禁用（状态持久化到 `plugins.json` 的 `pluginDisabled` 段，重启保留）
- **超时护栏**：插件 run 默认 60s 限时，超时返回失败结果不卡死 agent 循环；插件可声明 `timeoutMs` 覆盖
- 完整协议、架构链路、SearXNG 部署调优见 `docs/plugin-tools.md`

### 模型与成本

- 多供应商：Anthropic + 任意 OpenAI 兼容端点（DeepSeek / Kimi / GLM），每角色可配 fallback 链；`/model` 热切换即时生效
- **推理内容（thinking）**：默认开启（Anthropic extended thinking / OpenAI reasoning），会话内保留推理、跨供应商切换自动降级为普通文本；模型不支持时自动降级重试（设置页可关闭）
- **上下文交接**：请求前消息转换（toolCallId 归一化 / 半截回合合并 / 孤儿工具调用补结果），切换供应商不丢质量
- **流式 fallback**：首候选流式中途失败自动顺延下一候选重放（已输出的文本重复属流式固有限制）
- 每轮 token 透明：`本轮 12.4k in / 1.8k out · 缓存命中 78% · 累计 89k`
- 连接测试：真实最小请求验证认证 / 路径 / 模型，错误分类可区分

## 本地开发

```bash
pnpm install
pnpm test            # 全部测试（node:test + tsx）
pnpm run typecheck   # src 与 web 两个 tsconfig
pnpm run build
pnpm run dev         # 交互 CLI：tsx src/cli.ts
```

先在 Web 页面保存并测试 main 模型，再运行：

```bash
pnpm run dev
```

直接输入自然语言任务；需要审批时 CLI 会暂停询问（`y` / `n`，`/allow` 记记忆范围，`/deny` 附留言）。运行中按 `Ctrl+C` 中止。

启动 Web：

```bash
pnpm run web
```

终端会打印实际访问地址，默认 `http://127.0.0.1:3000`；端口被占用自动选下一个。API Key 写入本机配置文件（`.myagent/local.jsonc`），读取时不回传明文。

## 文档索引

- `设计方案/功能文档.md` — 面向使用者的功能说明
- `设计方案/架构文档.md` — 总体架构与核心机制
- `设计方案/技术方案.md` — 技术选型与实现方案
- `设计方案/上下文工程.md` — 上下文组织设计与缓存命中率提升（含实测数据）
- `设计方案/验收文档.md` — 验收用例与状态
- `设计方案/目标与愿景.md` — 长期目标
- `docs/pi-agent-analysis.md` — 对标 Pi Coding Agent 的调研（特点/爆红原因/借鉴点）
- `docs/pi-core-analysis.md` — Pi CORE 源码级对照（会话/上下文/工具/事件流实现细节 + 改造优先级）
- `docs/plugin-tools.md` — 插件工具通道与网络搜索（协议/架构链路/SearXNG 部署调优/运维经验）

## 项目约定（记忆）

- 依赖管理用 `pnpm`（勿用 `npm`）；测试命令 `pnpm test`
