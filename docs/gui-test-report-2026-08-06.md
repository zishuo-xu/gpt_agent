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
