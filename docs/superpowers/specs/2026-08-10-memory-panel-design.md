# 记忆面板增强：审计深化（diff + 会话跳转）+ Markdown 预览

## 1. 目标与范围

在现有记忆面板（4 文档 + 自动写入时间线）基础上增强两项：

- **A. 审计深化**：时间线条目可展开「本次自动写入的前后 diff」；条目可点击跳转到对应会话
- **B. Markdown 预览**：编辑区支持预览模式，复用自研 `RichText` 渲染（不引渲染库）；扩展代码块渲染（记忆文件常见）

范围界定：后端在 `src/web/memory.ts` + 一个**工具执行层留档钩子**（`src/tools/atomic-file.ts` 注入点，见 4.1 说明）；前端 `web/src/MemoryApp.tsx` + `session-render.tsx`（RichText 扩展）+ `main.tsx`（路由）。不动 agent 主循环/会话管理/模型层。

## 2. 现状与差距

| 项 | 现状 | 差距 |
| --- | --- | --- |
| 时间线 | 从会话事件反推：Edit/MultiEdit/Write 命中记忆路径 → 记录（ts/sessionId/摘要） | 只读列表；**看不到改了什么**；无跳转 |
| diff 数据 | 工具执行层 `AtomicFileStore.write/edit` 已持有 `before`（旧内容），写入 `EditJournal`（**内存态，重启即失**，无持久化） | 无历史留档 → 无法回溯 diff |
| 渲染 | textarea 纯文本编辑 | 无预览；`RichText` 已支持标题/列表/引用/分隔线/链接，**无代码块** |
| 路由 | `#sessions` 打开会话列表，选中会话是组件内 state | 无法从记忆面板直达指定会话 |

## 3. 设计：A. 审计深化

### 3.1 写时留档（diff 数据源）

**结论先行**：`fs.watch`/轮询无法拿到旧内容（事件发生时文件已被覆盖）；git 历史与写入点不对应（写入≠提交）。**唯一可靠点是在工具写文件之前复制旧内容**——`AtomicFileStore.write` / `#commit`（Edit/MultiEdit 共用）已读取 `before`，在 `journal.record` 之前插入留档调用即可。

- 新增 `src/web/memory-history.ts`：`MemoryHistoryKeeper` 类
  - 构造参数：记忆文件定义（`memoryDefinitions` 的 path 集合，含全局 `~/.myagent/MEMORY.md`）
  - `snapshot(filePath, before: string | null)`：命中记忆路径时，将旧内容原子写到 **同目录 `.history/`**：
    - 全局：`~/.myagent/.history/MEMORY-<ts>.md`
    - 项目：`<cwd>/.myagent/memory/.history/pitfalls-<ts>.md`
    - `<ts>` 格式 `YYYYMMDD-HHmmss-SSS`；`before === null`（新建文件）不留档
  - **上限控制**：每文档最多保留 50 份，超限删除最旧（写入前扫描目录）
  - 幂等/性能：路径命中用 Set 预构建，非记忆文件零开销
- 注入方式：`AtomicFileStore` 新增可选 `snapshot?: (path, before) => Promise<void>` 回调（默认 noop），`write`/`#commit` 在 `journal.record` 前调用 `await snapshot(...)`；`src/web/server.ts` 组装 `AtomicFileStore` 时注入 `MemoryHistoryKeeper.snapshot`（web 启动路径）；CLI 路径不注入（无面板，零行为变化）
- gitignore：项目 `.gitignore` 增加 `.myagent/memory/.history/`（全局 `.history` 在 home 目录不在 git，无需处理）

### 3.2 时间线 API 扩展

- `GET /api/memory`：timeline 条目增加 `historyPath?: string`（该写入点对应的留档文件绝对路径；无留档数据时为 undefined——**从本功能上线起生效**，历史条目无 diff）
- 新增 `GET /api/memory/history?path=<留档文件绝对路径>`：返回 `{ before, after, diff }`（after = 当前文件内容；diff 用现有 `createDiffPreview` 统一格式）。校验 path 必须在 `.history/` 目录内（防路径穿越）

### 3.3 前端：时间线 diff 展开 + 会话跳转

- MemoryApp 时间线条目：
  - 有 `historyPath` 的条目显示「查看改动」按钮 → 点击 fetch `/api/memory/history` → 展开 `<DiffOrOutput text={diff} />`（复用现有 diff 渲染组件）
  - 无 historyPath 的条目显示「本次改动发生在本功能上线前」提示
  - 条目点击（或「打开会话」按钮）→ `window.location.hash = "#sessions/<sessionId>"` 跳转
- 路由：`web/src/main.tsx` 解析 `sessions/<id>` 段 → `SessionApp` 接收 `initialSessionId?: string` prop → 会话列表加载后自动 `selectSession(id)`（找不到时静默回退列表视图）。会话页 hash 变化无需联动（单向跳转）

## 4. 设计：B. Markdown 预览

- `session-render.tsx` 的 `RichText` 扩展 **fenced code block** 渲染（```` ```lang `` ``` ```` 围栏 → `<pre><code>`，支持行内 span 保留）：记忆文件常见代码片段/命令记录；属渲染路线自然扩展（web-ui-selfbuilt-rendering：扩展而非重构）
- MemoryApp 编辑器区：**「预览 / 编辑」切换按钮**（单视图互斥，桌面/移动端同构）
  - 预览渲染实时 draft（`<RichText text={draft} />`），不落盘不破坏草稿状态
  - 预览模式隐藏清空/保存按钮？——保留保存按钮（保存不依赖预览模式），清空按钮保留
- 记忆文档是 markdown：预览默认开启？默认「编辑」模式（先编辑后预览，行为保守）

## 5. API 契约

```
GET /api/memory
  → { documents, timeline: [{ ts, sessionId, sessionTitle, documentId, summary, historyPath? }] }

GET /api/memory/history?path=/abs/path/to/.history/pitfalls-20260810-120000-123.md
  → { before: string, after: string, diff: string }
  400: path 不在 .history/ 目录内；404: 留档文件不存在
```

## 6. 测试策略

- **单测（core）**：
  - `memory-history.test.ts`：命中/非命中、新建文件不留档、上限 50 清理、原子写、路径安全（不越界）
  - `memory.test.ts` 扩展：timeline 含 historyPath（构造含记忆写入的会话事件）、history API 校验与 404/400
  - `atomic-file.test.ts` 扩展：snapshot 回调在 write/edit 前调用、非记忆路径不调用（注入 noop 的既有测试不破坏）
  - `session-render.test.tsx` 扩展：代码块渲染
- **前端单测**：MemoryApp 预览切换、diff 展开、跳转 hash
- **e2e**（生产级）：记忆面板——写入记忆 → 时间线出现 → 展开 diff 可见改动内容 → 点击跳转到对应会话；预览模式渲染 markdown（标题/列表/代码块）
- **浏览器模拟用户**（IAB）：桌面 + 移动视口完整旅程 + 截图

## 7. 兼容性与边界

- 时间线数据结构向后兼容（新增可选字段）；旧条目无 diff（提示上线前）
- CLI 路径不注入留档钩子：行为零变化
- `.history/` 目录 gitignore；上限 50 份/文档防无限增长
- 记忆文件被**手动编辑**（编辑器/用户）不产生留档（仅工具写入路径）——diff 语义为「agent 自动写入」，与时间线数据源一致
