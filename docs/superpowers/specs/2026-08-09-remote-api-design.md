# 远程会话：/api/v1 无头接口 + 移动端响应式 — 设计文档

> 日期：2026-08-09
> 分支：zcode-remote-api（基于 main@afa6254）
> 状态：已确认（认证/契约/耦合承诺/移动端/测试策略逐节评审通过）

---

## 1. 背景与目标

MyAgent 已有完整的浏览器远程能力（Web 监控台 + 手机审批 + 密码认证），功能端点齐备但存在两个缺口：

1. **无机器对机器的稳定接口**：现有 `/api/*` 是前端内部契约（如 `/api/sessions/:id/input` 的 task/message 双字段兼容逻辑），集成方（飞书机器人等外部系统）绑定它会随前端演进被破坏；认证只有 cookie 登录，不适合脚本。
2. **移动端体验**：手机浏览器可用但体验一般（桌面布局侧栏常驻、触控目标小）。

目标：提供**独立版本化的 `/api/v1` 无头接口**（Bearer token 认证、白名单事件契约、薄适配层），并**响应式改造现有前端**以适配手机操作。

## 2. 范围

### 做
- `server.apiToken` 配置（设置页可生成随机 token），`Authorization: Bearer` 认证 `/api/v1/*`
- `/api/v1` 八端点：runs / sessions / sessions/:id / events（增量）/ messages / approvals / interrupt / export
- 白名单事件契约（10 种类型，内部事件多对一折叠映射）
- 移动端响应式（侧栏抽屉、触控目标、审批卡片、diff 横滚）
- `docs/remote-api.md` 契约文档 + 飞书机器人调用示例
- 设计文档（本文）+ 实施计划

### 不做（已确认排除）
- 独立进程/端口（同进程薄层，见 §4）
- HTTPS、令牌分级、登录限速（安全加固项，另行决策）
- CLI 远程薄壳（`myagent --api`）
- IM 适配内嵌（飞书是外部调用方，MyAgent 只暴露 API）
- 移动端独立视图（/m 路由，响应式足够）

## 3. 耦合承诺（核心约束）

**`src/core/*` 零改动**。v1 与主系统的耦合点仅三处，全部是稳定的服务层接口：

| 耦合点 | 边界 |
|---|---|
| 认证中间件挂载 | `server.ts` 装配层（v1 路由组内 `use`） |
| 数据来源 | 只调 `WebSessionManager` 公共方法（`get/list/sendInput/summary/events/...`），不 import 任何内部模块 |
| 事件映射 | v1 自己的白名单转换层（内部事件 → v1 契约，单向） |

故障隔离：Hono 请求边界天然隔离，v1 所有处理器统一 try/catch → 错误映射为 4xx/5xx 响应，不向上抛、不触碰主循环状态。v1 出错最多表现为"该请求返回错误"，主循环、现有 API、CLI 不受影响。

## 4. 架构

同进程：`src/web/api-v1.ts`（新文件，纯路由 + 转换，无状态），在 `server.ts` 装配层通过 `app.route("/api/v1", v1App)` 挂载。`src/web/app.ts` 不改。

v1 拿不到内部细节（thinking 原文、分支树细节），只能给白名单内的稳定信息——这是机器面的预期粒度。

## 5. 配置与认证

```ts
// src/config/schema.ts server 段新增
server: { host: "127.0.0.1", password: "", apiToken: "" }
```

- 设置页 Schema 驱动自动生成输入框 + 「生成随机 Token」按钮
- `/api/v1/*` 只认 `Authorization: Bearer <token>`，与浏览器 cookie 登录完全隔离
- token 比较 `crypto.timingSafeEqual`（等长前缀保护 + 长度归一）
- `apiToken` 未配置时 `/api/v1` 整体返回 **404 not_enabled**（不暴露端点存在性）
- 现有 `/api/*` 与 cookie 认证不动，前端零影响

## 6. v1 端点契约

基础约定：前缀 `/api/v1`；响应 `{ ok: true, data }` / `{ ok: false, error, code }`；错误码 `unauthorized`(401) / `not_enabled`(404) / `not_found`(404) / `invalid`(400) / `conflict`(409) / `internal`(500)；全部端点支持 `?project=<key>`。

| 方法/路径 | 请求 | 响应 data |
|---|---|---|
| `POST /api/v1/runs` | `{ command: "/run ...", project?, confirmBounds? }` | `{ sessionId }` |
| `GET /api/v1/sessions` | `?limit=20` | 摘要数组（title/status/cost/tokens/时间） |
| `GET /api/v1/sessions/:id` | — | 单会话摘要 + 统计 |
| `GET /api/v1/sessions/:id/events` | `?after=<seq>` | `{ events: V1Event[], latestSeq }` |
| `POST /api/v1/sessions/:id/messages` | `{ message, steer? }` | `{ accepted, queued }` |
| `POST /api/v1/sessions/:id/approvals/:callId` | `{ granted, scope?, feedback? }` | `{ resolved: true }` |
| `POST /api/v1/sessions/:id/interrupt` | — | `{ interrupted: boolean }` |
| `GET /api/v1/sessions/:id/export` | — | HTML（复用现有导出） |

边界语义：
- `runs`：含 hardRules 的 /run 需显式 `confirmBounds: true`，否则 409 返回边界清单由集成方决定（沿用现有 input 端点语义）
- `messages` 只收普通消息，任务发起一律走 `runs`（语义单一，不复制 input 的 task/message 双字段兼容）

## 7. 事件白名单契约

```ts
type V1Event =
  | { seq: number; ts: string; type: "user.text";        text: string }
  | { seq: number; ts: string; type: "assistant.text";   text: string }
  | { seq: number; ts: string; type: "assistant.thinking"; text: string }
  | { seq: number; ts: string; type: "tool.call";        tool: string; target?: string; args: unknown }
  | { seq: number; ts: string; type: "tool.result";      tool: string; summary: string; isError: boolean }
  | { seq: number; ts: string; type: "approval.request"; callId: string; tool: string; risk: string }
  | { seq: number; ts: string; type: "run.started";      description: string }
  | { seq: number; ts: string; type: "run.finished";     status: string; reason?: string }
  | { seq: number; ts: string; type: "system.info";      message: string }
  | { seq: number; ts: string; type: "system.error";     message: string };
```

映射规则（多对一折叠，白名单外永不破坏契约）：
- `text_delta` → `assistant.text`（连续片段由调用方按 seq 聚合或前端语义，v1 逐事件给）
- `user` / `user_queued` → `user.text`
- `tool_call` → `tool.call`；`tool_result` → `tool.result`
- `ask_permission` → `approval.request`
- `run_started` / `run_finished` 直映射
- `error` → `system.error`
- 其余（cost_update / todo_update / context_compacted / branch_switch / label / notify / thinking_delta 归入 assistant.thinking 等）按白名单归属，未知/新增类型折叠为 `system.info`

## 8. 移动端响应式

纯 CSS 断点（`@media (max-width: 768px)`），`SessionApp.tsx` 仅加侧栏开合状态（useState + 汉堡按钮）：

| 改造点 | 窄屏行为 |
|---|---|
| 会话列表侧栏 | 抽屉化：默认隐藏，汉堡开合；选中会话自动收起 |
| 主区 | 全宽 |
| 顶部操作按钮 | 中止/新会话保持可见，次要操作紧凑排 |
| 消息输入框 | 置底、字号 ≥16px（防 iOS 缩放） |
| 审批卡片 | 全宽，操作按钮 ≥44px |
| diff / 代码块 | 横向滚动保持 |
| `.project-picker` | 已适配（92vw），不动 |

延续自研路线：不引入组件库，不重构组件结构。

## 9. 测试策略

| 层 | 覆盖点 |
|---|---|
| `src/web/api-v1.test.ts` | 认证矩阵（无/错/对 token → 401；未配置 → 404 not_enabled）；八端点 happy path + 错误码；事件白名单折叠（未知类型 → system.info）；runs confirmBounds 语义 |
| app 级测试 | 按 `app.test.ts` 现有模式（Hono app 直接 fetch，不起真实服务器） |
| 组件测试 | SessionApp 侧栏抽屉开合行为（jsdom 现有模式） |
| GUI/E2E | Playwright 移动视口（375px）主流程「发起 → 审批 → 看进度」；断点视觉回归用现有 gui-test 流程 |

## 10. 产出物

- `src/web/api-v1.ts`（新）+ `src/web/api-v1.test.ts`（新）
- `src/config/schema.ts`（+apiToken 字段）、`src/web/server.ts`（挂载 + 认证）
- 复用现有公共方法，不改 `src/web/sessions.ts`：`AgentSession.events(after)` 已具备增量语义（`after=0` 全量），`summary()` 提供详情字段
- `web/src/styles/chat.css` / `base.css`（断点）、`web/src/SessionApp.tsx`（抽屉状态）
- `docs/remote-api.md`（契约文档 + curl 示例 + 飞书机器人调用示例）
- 本文档 `docs/superpowers/specs/2026-08-09-remote-api-design.md`
