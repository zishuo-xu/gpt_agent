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
