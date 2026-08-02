# MyAgent - 无人值守编码 Agent

MyAgent 是一个面向长时间自主运行任务的本机编码 Agent：把自然语言任务交给它，它会在你的代码库里自主探索、编辑文件、运行命令、自我修正，需要你决策时才停下来征求批准。无人值守模式下可设时间/预算边界，跑完自动收尾。

**一期开发已通过验收**（19 项核心用例真实验证 + 用户旅程全流程），二期迭代持续进行（工具参数健壮性、配置热生效、标题生成、缓存前缀工程等），远程仓库：https://github.com/zishuo-xu/gpt_agent

## 当前能力

### 核心闭环

- **自主编码**：自然语言任务 → Read / Grep / Glob / Edit / MultiEdit / Write / Bash / TodoWrite / Task 工具集
- **todo 可视化**：多步骤任务自动建清单，实时翻转状态
- **原子文件编辑**：临时文件 + rename，中止不留半文件；EditJournal 记录每次编辑，收尾可精确撤销
- **统一硬中止**：Esc 立即取消模型与当前工具；Bash 终止整个进程组

### 权限安全（strict / normal / trust 三档）

- strict：写操作与 Bash 全部弹批准；normal：只读与 Edit 自动放行，Write 与灰区 Bash 弹批准；trust：deny 与显式 ask 外全部自动执行
- **看完再批**：Edit/Write 批准前展示真实 diff（±3 行上下文）；Bash 显示命令原文 + 风险翻译
- 批准记忆四级：仅一次 / 本次会话 / 本项目 / 全局
- deny 是硬边界，任何档位不豁免；审批超时无人响应自动拒绝（fail-closed）

### 无人值守（/run）

- 任务三要素：`--goal` 机器可判定验收、`--bounds` 负面清单（编译为 deny 硬规则，启动前确认）、`--until/--budget` 时间/预算盒
- 优雅终止：分阶段收窄范围 → 收尾 → 纯总结，产出总结报告 + todo 快照 + 记忆写入
- `--permission trust` 任务期生效，结束后回落原档位

### 子代理（Task）

- 探索类任务派生独立上下文的子代理（空白上下文 + 主 Agent 自写 prompt），只回流三段式结论（结论 / 关键证据 / 未确认）
- 默认只读、explore 角色模型；嵌套 ≤2 层、并发 ≤4、最多 40 轮强制收尾；失败降级为工具结果返回主 Agent

### 记忆复利

- 项目记忆：`AGENTS.md`（/init 生成）+ `.myagent/memory/`（conventions / pitfalls / decisions）
- 全局记忆：`~/.myagent/MEMORY.md`；干活中学到的稳定事实自动写入，下次会话自动注入
- 跨项目联想：新会话注入他项目记忆的标题索引，相关时自动调取全文

### Web 界面（myagent --web）

- **监控台**：所有会话实时状态卡（进度 / 花费 / 时长），审批请求标签页标题提示
- **会话详情**：完整事件流（文本 / 工具 / diff / 子代理卡片）、回放模式、可继续追问
- **记忆面板**：四类记忆直接编辑 / 删除，自动写入有时间线审计
- **设置页**：供应商 / 角色模型 / 权限规则 / 行为参数 / 服务器（监听地址与访问密码），Schema 驱动自动生成，全局 / 项目双作用域
- **远程审批**：监听非 localhost + 访问密码，手机浏览器可审批（E2E 验证）

### 模型与成本

- 多供应商：Anthropic + 任意 OpenAI 兼容端点（DeepSeek / Kimi / GLM）
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
- `设计方案/验收文档.md` — 验收用例与状态
- `设计方案/目标与愿景.md` — 长期目标
- `docs/pi-agent-analysis.md` — 对标 Pi Coding Agent 的调研（特点/爆红原因/借鉴点）

## 项目约定（记忆）

- 依赖管理用 `pnpm`（勿用 `npm`）；测试命令 `pnpm test`
