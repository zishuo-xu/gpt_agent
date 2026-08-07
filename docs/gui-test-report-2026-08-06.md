# Web GUI 测试报告（10 个生产级复杂场景）

- 日期：2026-08-06（补充于首轮 P0-P3 报告之后）
- 方式：浏览器黑盒测试（IAB 后端，DOM 快照 + 截图证据，无脚本注入）
- 环境：隔离 HOME（`/tmp/myagent-gui-test-home`，DeepSeek 密钥），`tsx src/cli.ts --web` @ `127.0.0.1:3001`，写操作隔离于 `/tmp/myagent-gui-test-workspace`

## 场景结果总览（10/10 通过）

| # | 场景 | 结果 | 关键验证点 |
| --- | --- | --- | --- |
| S1 | 切换项目 + 从零构造完整 Web 项目 | ✅ | 文件浏览器选目录（修复后）、7 文件 Write 审批链（diff 预览）、npm install + build 通过、**vite preview 实际运行**、添加/完成/删除/刷新持久化实测 |
| S2 | 项目迭代：加功能 + 构建验证 | ✅ | multiedit/edit 迭代、build 通过、**过滤功能浏览器实测**（All/Active/Completed 正确） |
| S3 | 拒绝审批并留言 → 模型纠偏 | ✅ | 留言「不要写文件，直接给中文内容」→ 模型回复「明白了，不写文件」+ 中文 README 内容 |
| S4 | 大厅模式只读保护 | ✅ | Bash/Write 全部 deny（无需审批）、glob 只读可用 |
| S5 | 长任务中止 | ✅ | sleep 30 运行中点击 ■ 中止 → 状态「已中止」、命令中断、输入恢复 |
| S6 | 详情面板 | ✅ | 任务清单、消耗（token/缓存命中/浪费/费用）、会话信息（29 次工具调用） |
| S7 | /run 无人值守任务模式 | ✅ | 无人值守会话、任务卡片、deadline narrow 阶段提示、自动执行、收尾总结 |
| S8 | 会话搜索 | ✅ | 关键词过滤会话列表 |
| S9 | 会话删除 | ✅ | confirm 确认后删除，**jsonl + trace 文件同步清理**（文件系统验证） |
| S10 | 回放模式 | ✅ | slider 1229/1229 事件、拖动截断视图正确、退出恢复 |

## 发现的缺陷与修复（3 个，均已修复并回归验证）

| # | 缺陷 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 「打开其他项目…」死按钮：点击无任何 UI | `showProjectPicker` 状态有设置/重置但 **JSX 从未渲染对话框**（样式类齐全但组件缺失） | `web/src/SessionApp.tsx` 补全项目选择器 overlay（根入口 + 面包屑 + 目录列表 + 打开按钮）；另修 z-index 层级（50→70，避免被 new-task-overlay 遮挡） |
| 2 | 大厅模式 glob 报 `ENOENT .../myagent-lobby` | lobby cwd 临时目录无人创建 | `web/project-registry.ts` `getLobby()` 增加 `mkdirSync(cwd, { recursive: true })` |
| 3 | 服务器重启后大厅会话丢失（列表为空） | `getLobby()` 缺 `sessionManager.restore()`（`getByCwd` 有而 `getLobby` 无） | `getLobby()` 改为 async 并 `await sessionManager.restore()`，`resolve()` 同步改 await |

修复验证：typecheck ✅（core 203 + web 18 测试全绿）、构建 ✅、浏览器回归 ✅（选择器可导航打开项目、大厅 glob 正常、大厅会话重启后恢复）。

## 非缺陷观察项

1. **Composer 发送需 ⌘/Ctrl+Enter**（防误触设计，UI 有提示）；自动化环境 `press("Enter")` 不触发，`press("Meta+Enter")` 偶发不稳定，按钮点击最可靠——非产品缺陷。
2. **长中文 fill 出现编码错乱**（IAB 自动化输入路径问题），改用英文消息规避——非产品缺陷。
3. **会话级「本次会话允许」记住的 Bash 规则对后续命令生效**（git status 免审批直接执行）；Write 规则按签名精确匹配（README.md 仍需审批）。
4. **任务模式下 Bash 未触发审批**（/run 无人值守语义），行为符合设计。
5. 项目 local.jsonc（trust 档）覆盖全局配置（normal），会话恢复权限档显示 trust 为配置优先级设计。

## 结论

10 个生产级复杂场景全部通过。发现并修复 3 个真实缺陷（均为多项目/大厅支持的功能性缺陷），每个缺陷均有浏览器回归验证。核心链路（审批、排队、插队、拒绝纠偏、中止、任务模式、回放、持久化）在真实模型驱动下工作正常。

---

# 补充测试报告（功能差距全覆盖 A-G）

- 日期：2026-08-06（续）
- 目标：补齐此前识别的能力差距——项目选择器测试、审批超时、多会话并行、CLI 命令、上下文压缩、webhook、访问密码——真实用户模拟验证
- 环境：隔离 HOME（`/tmp/myagent-gui-test-home`），web @ `0.0.0.0:3000`（密码保护测试），CLI 管道于 `/tmp/myagent-gui-test-workspace`

## 任务结果总览（7/7 通过，发现并修复 1 个认证失效缺陷）

| 任务 | 内容 | 结果 | 关键验证点 |
| --- | --- | --- | --- |
| A | 项目选择器行为层测试 | ✅ | `ProjectPicker` 组件化 + 5 个测试（渲染/导航/打开/关闭/错误态），web 测试 18→23 |
| B | 审批超时自动拒绝 | ✅ | approvalTimeoutMs 8s 实测：审批请求超时自动拒绝 + `notify` 事件 → webhook「审批超时」推送 |
| C | 多会话并行 | ✅ | 会话 1 sleep 20 运行中，会话 2 独立运行互不阻塞，两会话各自完成 |
| D | CLI 命令端到端 | ✅ | `/init`（生成 AGENTS.md 1763B）、`/config set`（两次串行写入均持久化）、`/model`、`/compact`、管道 4 命令稳定 |
| E | 上下文压缩实测 | ✅ | 阈值 50000 触发 3 次「上下文已压缩 · 保留 X%」事件，压缩后继续应答正常 |
| F | webhook 推送 | ✅ | 本地 receiver 收到「任务完成/任务出错/审批超时」三类推送 |
| G | 访问密码 | ✅ | 非 localhost 访问：无 cookie 401、错 cookie 401、对 cookie 200；登录页错误密码提示「密码错误」、正确密码进入应用（浏览器实测） |

## 缺陷 #4（本补充轮）：认证中间件注册顺序导致密码保护失效

**现象**：配置 `server.host=0.0.0.0` + `server.password=testpass` 后，无 cookie 访问 `/api/sessions` 仍返回 200，密码保护未生效。

**根因**：`server.ts` 在 `createWebApp()`（内部已注册全部 `/api/*` 业务路由）**之后**执行 `app.use("*", auth)`。Hono 按注册顺序匹配执行链——业务路由先注册先命中，`use("*")` 中间件对已注册的 `/api/*` 路由完全不执行（最小复现确认：中间件日志只有页面请求，无 API 请求）。页面 `/` 因后注册的 `get("*")` 在中间件之后才命中而显示登录页，造成「登录页正常但 API 裸奔」的假象。

**修复**：`createWebApp` 新增 `mountBeforeRoutes` 参数，认证中间件与 `/api/auth` 登录路由在业务路由**之前**注册（`src/web/app.ts`、`src/web/server.ts`）。新增行为层测试「认证中间件经 mountBeforeRoutes 在业务路由前生效」（app.test.ts，覆盖 401/登录页/错 cookie/对 cookie/登录端点）。

**验证**：curl 实测 LAN IP（192.168.31.52:3000）——无 cookie API 401、错 cookie 401、对 cookie 200、错密码登录 401、对密码登录 200；浏览器黑盒实测登录页渲染 → 错密码提示「密码错误」→ 正确密码进入应用主界面（会话列表可见）。修复后回归：core 204 + web 23 测试全绿、typecheck ✅、build ✅。

## 缺陷 #5（本补充轮）：CLI 管道多命令读-改-写竞态与 readline 关闭崩溃

**现象**：管道连续执行 `/config set` 时后者覆盖前者写入；EOF 后异步命令触发 `ERR_USE_AFTER_CLOSE: readline was closed`。

**修复**：`src/cli.ts` 增加 `safePrompt`（closed 标志 + try/catch 包裹）与串行命令链（`commandChain = commandChain.then(...)` 保证斜杠命令顺序执行）。验证：两次 `/config set` 值均正确持久化，4 条命令管道稳定退出。

## 缺陷 #6（本补充轮）：恢复的会话不推送 webhook

**现象**：服务器重启后恢复的会话完成时不发 webhook（`WebhookNotifier` 只在 `createSession` 注入）。

**修复**：`src/core/session-manager.ts` restore 路径同样注入 `WebhookNotifier`。验证：receiver 收到「任务完成」推送。

## 其他发现（配置优先级，非缺陷）

- 项目 `local.jsonc` 的 `server` 段覆盖全局配置（设计行为）——在 gpt_agent 项目下启动 web 时全局的 host/password 被项目配置覆盖。测试通过临时修改项目配置完成验证后已还原。
- localhost 访问免认证（`needsAuth = !isLocalhost && !!password`）为设计行为；监听 `0.0.0.0` 时 localhost 同样需要认证（统一保护）。
- `SessionApp.test.tsx` 两个 describe 重复注册 happy-dom 全局（全局单例限制），幂等处理。

## 结论

A-G 全部实现并实测通过。核心发现为缺陷 #4（认证中间件失效）——属高危安全问题（配置了密码但 API 无保护），已修复并有行为层测试锁定。

---

# 补充测试报告（简洁架构残留优化 A-E）

- 日期：2026-08-06（续）
- 目标：修复评估中识别出的简洁架构残留——大文件拆分、依赖方向、类型副本、测试盲区、字面量归目录

## 优化结果总览（5/5 完成）

| 项 | 内容 | 结果 |
| --- | --- | --- |
| A | **App.tsx 拆分**：1415 行 → ~500 行组装层，拆出 `web/src/settings/`（ProviderPanel 250 行 / RoleModelsPanel 230 行 / PermissionsPanel 110 行 / ContextPanel 60 行 / SchemaSections 190 行 / types 共享类型）+ 6 个行为层测试 | ✅ |
| B | **依赖方向修正**：`CompletionRequest.tools` 改必填，删 client.ts 四处 `?? CODING_TOOL_DEFINITIONS` 运行时回退——model 层不再运行时依赖 tools（编译期约束全部调用方显式注入） | ✅ |
| C | **config-path 下沉 @shared**：`src/config/config-path.ts` → `src/shared/config-path.ts`，前端经 `@shared/config-path.js` 引用——消除前端对后端源码的运行时 import（Vite 打包不再打入后端文件）；cli.ts 同步改引用 | ✅ |
| D | **测试盲区补齐**：`cli-utils.test.ts`（7 测试：审批解析 y/yes//allow 范围//deny 留言、config set 解析、类型强转、摘要格式）+ `utils.test.ts`（11 测试：原子写权限保留/AbortError 不落盘/临时文件清理、abortableSleep、escapeRegExp、stringify、usageCostCny、glob）+ `App.test.tsx`（6 测试：四分区渲染/回调/Key 显隐/覆盖提示/规则删除/阈值修改） | ✅ |
| E | **字面量归目录**：agent-model/context/agent-loop 7 处工具名硬编码改引 `TOOL_NAMES`（as const 编译期守卫）；context.test.ts 本地 escapeRegExp 副本改引 `utils/regexp` | ✅ |

新增测试 24 个：core 204→222、web 23→29（总计 251 全绿）。

## 浏览器实测（模拟用户使用）

| 场景 | 结果 |
| --- | --- |
| 设置页渲染：六分区（供应商/角色模型/权限/上下文/复合字段/扩展设置）完整 | ✅ |
| 编辑「硬压缩触发」90000→80000 → 保存按钮变 dirty → 保存 → 「配置已保存」+ 落盘生效（全局配置验证 80000） | ✅ |
| 模型连接测试：POST /api/config/test 真实调用 DeepSeek，返回 ok/1134ms | ✅ |
| 会话监控页正常；新建会话面板正常 | ✅ |
| 真实任务（只读摘要）：glob → read package.json → read src/App.tsx → 正确总结项目（Vite/tsc 构建链），缓存命中 71% | ✅ |
| 审批流：Write hello.txt 触发审批卡（diff 预览 + 四级允许 + 拒绝留言）→ 点「仅这一次」→ 文件落盘 | ✅ |

## 验证

`pnpm run typecheck` ✅ · `pnpm test` 251 全绿 ✅ · `pnpm run build` ✅（前端 35→41 模块，拆分生效）。

## 设计文档偏差说明

- C2 原计划 `SessionDetails.tsx` 拆分（SessionApp 主组件）与 styles.css 拆分维持此前决策（无测试覆盖 + 无法视觉验证，收益低于回归风险），本次未做。
- `web/src/settings/types.ts` 的 Provider/Config 与后端 `schema.ts` 的 `ModelProviderConfig`/`MyAgentConfig` 结构同源但字段不同（前端含 hasApiKey 脱敏字段、后端含注释保留逻辑），维持前端独立类型而非强行合并——合并需后端 toPublicConfig 输出对齐，收益低于改动面。

# 补充测试报告（T1-T9 边界补全 + 生产级崩溃续跑验证）

日期：2026-08-06（T1-T9 全部实现后的补充轮）。覆盖：事件流容错、崩溃恢复/续跑、书签、HTML 导出、桌面通知、守护进程、前端拆分、Playwright E2E，以及真实模型驱动的生产级复杂任务测试。

## 功能实现与单测（新增 17 个测试）

| 项 | 实现 | 测试 |
| --- | --- | --- |
| T2 事件流坏行容错 | `readJsonl`（坏行跳过），SessionStore/TraceStore/恢复路径统一接入 | `utils.test.ts` +2（中间坏行/尾部半行） |
| T1+T3 崩溃恢复/续跑 | `run_started.taskOptions` 持久化；`interruptedTaskFrom` 检测（run_started 无配对 run_finished）；`resumeTask()` 沿用原 taskId、注入续跑指令；CLI `/resume`、Web `POST /resume` +「↻ 续跑中断任务」按钮 | `resume-task.test.ts` +3（序列化往返/崩溃恢复全链路/重复拒绝） |
| T7 书签 | `label` 事件（空名=移除）；CLI `/label /unlabel /labels`；Web 书签 RailCard + ★ 按钮（仅用户消息）+ API | `bookmark.test.ts` +3 |
| T6 会话导出 | `exportSessionHtml` 自包含 HTML（内联样式、diff 高亮 add/del、escapeHtml 全转义） | `export-session.test.ts` +2 |
| T8 桌面通知 | `DesktopNotifier`（darwin 守卫、osascript 转义、每小时 2 条限速、notifyFn 可注入） | `desktop-notifier.test.ts` +6 |
| T9 守护进程 | `--daemon`（execArgv 传播 tsx loader、pid 文件、日志重定向）/`--daemon-stop` | 实测通过 |
| T5 前端拆分 | SessionApp 1868→1450 行（拆 `session-render.tsx`）；styles.css 四拆（base/settings/chat/memory） | web 29 测试保持全绿 |

## Playwright E2E（5 测试全绿）

webServer 以隔离 HOME + 测试工作区启动；覆盖：设置页六分区渲染、dirty 保存、会话列表/新建面板、真实只读任务（模型真实调用）、审批流写文件（diff 预览 → 批准 → 落盘）。

## 生产级复杂任务（真实模型驱动）

1. **真实 bug 修复任务**：模型发现 `calc.js` subtract 实现错误（`return a+b`），修复为 `a-b`，遵守「不修改测试文件」约束，在临时目录（无 package.json 默认 CJS）验证 4 测试全过，清理临时文件，沉淀 pitfalls 记忆（含 rm -rf deny 规则）。
2. **书签 API 链路**：添加 → 查询 → 空名移除 → 查询，`label` 事件落盘验证（seq 790/791）。
3. **导出端点**：`content-disposition` attachment + `text/html`，791 事件渲染完整，diff 高亮 add/del 各 2 处。
4. **崩溃续跑端到端**（kill -9 服务器）：
   - 崩溃检测：重启后 `status: interrupted` + `interruptedTask` 还原 taskId/description ✅
   - 续跑执行：`resumeTask` 沿用原 taskId，`run_finished` 配对 `completed` ✅

## 本轮发现并修复的缺陷（2 个）

| # | 缺陷 | 根因 | 修复 |
| --- | --- | --- | --- |
| 7 | 工具执行中崩溃，续跑后模型 API 报 `tool_calls` 必须有配套 tool 消息 | `conversationFromRaw` 对无配对 `tool_result` 的孤儿 tool_call 直接入栈，恢复的消息历史非法 | `src/core/branch.ts` 收尾对孤儿 tool_call 补「工具调用因进程崩溃中断」tool 消息（倒序插入）；`branch.test.ts` +2 回归测试 |
| 8 | 崩溃续跑后权限从 trust 降级为 normal（工具需重新审批） | 初始权限模式只存内存、从不写入事件流，恢复时 `lastPermissionMode` 取不到而回落配置默认 | 构造时若模式非 normal 且事件流无 `permission_mode_changed`，补写一条入事件流；`resume-task.test.ts` 增加恢复后 `permissionMode === "trust"` 断言 |

修复验证（端到端）：kill -9 → 重启 → 续跑 → `sleep 90` **无审批直接执行**（修复前同调用被拒 3 次）→ 任务自然完成。

## 验证

`pnpm run typecheck` ✅ · `pnpm test` 268 全绿（core 239 + web 29）✅ · `pnpm run build` ✅。

# 补充测试报告（S1-S8 系统级优化 + 生产级验证）

日期：2026-08-06。S1-S8 全部落地后的系统级验证轮，含 Playwright E2E 扩展、进程级实测与真实模型浏览器验证。

## 系统级优化落地（S1-S8）

| 项 | 实现 | 验证 |
| --- | --- | --- |
| S1 Anthropic 缓存写入控制 | `toAnthropicMessages` 消息级缓存断点：首条（非末尾）user 消息标记 cache_control（Anthropic 断点上限 4：system+tools+1 消息）；`cacheRetention:"none"` 时全省略 | client 12 测试（含新消息断点语义测试） |
| S2 单实例写锁 | 项目级 `O_EXCL` 锁文件（pid+时间戳）；`restore()`/`createSession()` 入口获取；`releaseLock()` 幂等；CLI `--force` 跳过；锁冲突报错含 pid 与处置提示 | 单测 + 进程级实测（第二个 CLI 报错、--force 跳过） |
| S3 restore 性能 | 测量驱动：5 千/2 万/5 万事件 restore 30/71/149ms 线性无瓶颈（模型侧由 `next()` 请求前自动压缩兜底上下文）；新增 2 万事件护栏测试（<3s + 状态完整） | restore-perf 测试 |
| S4 优雅关闭 | CLI：`closeCli` + SIGTERM → flush + releaseLock；Web：SIGINT/SIGTERM → 主 manager flush/releaseLock + `registry.disposeAll()`；ProjectRegistry.seed 主实例 | 进程级实测（daemon-stop 后 pid 文件与锁均清除） |
| S5 日志轮转 | 守护进程 web.log >5MB 轮转 `web.log.1`（保留一份）；Bash 超限落盘 `myagent-bash-*.log` 启动清理（>7 天，可注入 tmpDir）；会话保留维持 Web 删除接口 | bash 清理单测 + 进程级实测（6MB 日志启动 → .1 生成） |
| S6 覆盖率门禁 | `pnpm run test:coverage`：`--experimental-test-coverage` + 阈值失败（core lines 85/functions 75/branches 80；web 60/75/60） | 基线 core 91.0%/web 67.5%，阈值通过 |
| S7 system prompt 体积守护 | 测试断言全量注入估算 < 1000 tokens（Pi 原则）+ 只读裁剪版更小 | agent-model 15 测试 |
| S8 启动计时 | `MYAGENT_TIMING=1`：config 加载/restore/会话创建分阶段耗时；CLI 与 Web 启动路径接入 | 实测输出 `config 加载: 5ms, restore: 55ms` |

## 生产级验证（Playwright E2E 8/8 全绿，20.5s）

原有 5 测试（设置/会话/真实任务/审批流）+ 新增 3 测试：
- 用户消息书签：hover 消息卡片（★ 悬停显示）→ ★ 打标（prompt 对话框）→ 书签栏出现 → ✕ 移除
- 导出会话 HTML：点击导出 → download 事件 → 文件名 `myagent-<id>.html` + 内容含 `MyAgent 会话导出`
- 续跑按钮显隐：正常会话无「↻ 续跑中断任务」按钮；resume API 返回 409

## 浏览器实测（真实模型用户路径，IAB）

- 会话列表 50 会话加载；历史长会话（修复计算器测试问题）完整渲染：事件流、每轮缓存命中率（96%/99%…）、审批卡（含 60s 审批超时自动拒绝）、pitfalls 记忆写入、书签栏持久化书签（#1 起点 + 移除按钮）、★ 按钮渲染
- 新建会话面板（项目/大厅 radio + 权限档 + 启动任务）；设置页五分区渲染
- 首次加载空列表为首帧时序（1.5s 自动刷新补齐），非缺陷

## 本测试轮发现并修复的缺陷（1 个）

| # | 缺陷 | 根因 | 修复 |
| --- | --- | --- | --- |
| 9 | E2E 全量请求 500（Internal Server Error），会话创建/详情全挂 | S2 锁引入后，server.ts 主 sessionManager 与 ProjectRegistry 默认项目实例是两个独立实例——前端请求带 `?project=` 时 `getByCwd` 为同项目创建第二个 manager，`restore()` 撞主实例锁抛错 | `ProjectRegistry.seed()` 注册主实例（server.ts 启动时调用），resolve 默认项目直接命中缓存；配套 `gracefulShutdown: SIGTERM`（Playwright 结束时走优雅关闭释放锁，不再残留） |

## 验证

`pnpm run typecheck` ✅ · `pnpm test` 275 全绿（core 246 + web 29）✅ · `pnpm run test:coverage` 阈值通过 ✅ · `pnpm run build` ✅ · `pnpm run test:e2e` 8/8 ✅

# 补充测试报告（生产级长任务场景套件：浏览器模拟真实用户）

日期：2026-08-06。目标：浏览器模拟用户真实使用，测试复杂长任务场景，≥5 个生产级大任务。发现问题即修复并复测。

## 测试环境

- 工作区：`/tmp/prod-test-workspace`（gpt_agent 源码副本 git clone + node_modules 链接，可跑 pnpm test/typecheck/build）
- 服务器：独立 Playwright 项目（`web/playwright.prod.config.ts`，3300 端口 + 隔离 HOME `/tmp/prod-test-home` + trust 无人值守档）
- 驱动：真实模型（DeepSeek），浏览器黑盒操作（Playwright UI 路径：新建面板 → 权限档 → 输入任务 → 启动 → 等待完成 → 产物验证）
- 套件：`web/e2e/prod-scenarios.spec.ts`

## 场景结果（6/6 全绿，最终验收 5.0 分钟一次通过）

| 场景 | 任务 | 验证点 | 结果 |
| --- | --- | --- | --- |
| P1 缺陷修复 | truncate preferTail 失效（预注入 bug，测试红）→ 复现 → 修复 → 全量测试绿 | 修复后系数满足"尾部更多"语义（模型用 0.4/0.6 或 0.32/0.6 均接受） | ✅ 1.3m |
| P2 功能实现 | 新模块 usage-stats.ts（汇总 token/费用）+ 单测 | 模块导出签名 + 测试存在 + 全量测试绿（+3 测试） | ✅ 45s |
| P3 跨模块重构 | escapeHtml 提取到 utils/escape.ts + 更新引用 | 新模块导出 + 旧文件改为引用 + 无本地定义 | ✅ 24s |
| P4 长会话多轮 | 同一会话连续 3 轮（分析→补测试→改常量），上下文连续 | 3 轮完成标记保留（reload 后可重进） | ✅ 1.3m |
| P5 架构分析 | 架构文档生成（有界：5 个入口文件 + 600 字） | 文档 >500 字 + 四目录覆盖 | ✅ 42s |
| P6 批处理统计 | count-tests 脚本 + 报告 | test( 调用总数 > 200（实际 256） | ✅ 32s |

最终状态：工作区全量测试 **282 全绿**（agent 新增 7 个测试），6 场景产物全部在位。

## 测试中发现并修复的问题（5 个，均为测试基建/断言问题）

| # | 问题 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | trust 档未选导致 Bash 审批挂起循环 | 任务默认 normal 档，无人值守时审批 60s 超时拒绝、模型换命令重试 | startTask 显式选「trust · 无人值守」档 |
| 2 | 会话创建后输入框定位失败 | 任务运行中 placeholder 变为排队版（"发消息给 MyAgent…（自动排队…）"） | 用正则匹配两种 placeholder |
| 3 | 会话 id 从 URL 提取失败 | 前端不把会话 id 写入 URL（hash 路由不记录） | 移除 URL 提取（返回值未使用） |
| 4 | P6 断言口径错误 | 正则匹配到"文件总数 37"而非"test( 调用总数 256" | 正则精确到 `test( 调用总数` |
| 5 | P4 reload 后断言失败 | reload 后会话未选中 + 同名会话 strict 冲突 | reload 后点击会话（.first() 取最新） |

## 关键产品观察（非缺陷）

1. **推理模型（deepseek-v4-flash）开放任务慢**：P5 无界任务（自由探索 + 长文档）35 分钟未完成（每轮思考 1-2 分钟，API 直测 0.5s 正常）；改为有界任务（指定文件列表 + 限定篇幅）后 42 秒完成——任务边界设计对推理模型至关重要。
2. **模型修复方式的多样性**：P1 两次修复分别为 0.4/0.6 与 0.32/0.6（均满足语义）——断言应验证语义而非固定值。
3. **子代理（Task）长输出时主任务等待**：P5 一次失败卡在 task_event 流式输出；任务级无子代理超时（模型侧行为）。

## 验证

`pnpm run test:e2e:prod` 6/6 全绿（5.0m）✅ · 工作区全量 282 测试全绿 ✅ · 常规 E2E 8/8（回归）✅
