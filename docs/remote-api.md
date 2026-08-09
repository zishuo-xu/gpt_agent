# MyAgent 远程 API（/api/v1）契约

> 面向**外部系统集成**（飞书机器人、脚本、CI 等机器对机器调用）。与浏览器 UI 使用的 `/api/*` 完全独立：版本化前缀、Bearer token 认证、白名单事件契约——主系统内部演进不会破坏本契约。

## 启用

1. 设置页（Web）→ 扩展设置 → **API Token**，点「生成」填入随机 token（或手动写入任意强随机串）
2. 配置文件等价字段：`server.apiToken`
3. 重启 Web 服务后生效

**未配置 apiToken 时 `/api/v1` 整体返回 `404 not_enabled`**（端点不暴露）。

## 认证

所有请求携带：

```
Authorization: Bearer <apiToken>
```

- 与浏览器 cookie 登录完全隔离，`/api/v1` 只认 Bearer
- token 比较为恒定时间（`timingSafeEqual`），防时序侧信道
- **安全边界**：token 拥有者与浏览器同权（可发起任务、审批、中断）。token 泄露 = 全权，仅部署在可信网络，妥善保管

## 基础约定

- 前缀：`/api/v1`
- 响应统一：成功 `{ "ok": true, "data": ... }`；失败 `{ "ok": false, "error": "...", "code": "..." }`
- 错误码：

| code | HTTP | 含义 |
|---|---|---|
| `unauthorized` | 401 | Bearer 缺失/错误 |
| `not_enabled` | 404 | apiToken 未配置，接口未启用 |
| `not_found` | 404 | 会话/项目不存在 |
| `invalid` | 400 | 请求体或字段非法 |
| `conflict` | 409 | 状态冲突（硬边界未确认、审批已失效、会话未运行等） |
| `internal` | 500 | 服务端异常 |

- 多项目：全部端点支持 `?project=<key>`（key 为 Web 项目列表中的项目键）；缺省用启动目录项目

## 端点

### 发起任务

```
POST /api/v1/runs
```

请求：

```json
{
  "command": "/run 修复测试失败 --goal \"pnpm test 全过\" --bounds \"不改 src/**\"",
  "confirmBounds": true
}
```

| 字段 | 说明 |
|---|---|
| `command` | `/run` 任务命令（必填；非 `/run` 返回 400） |
| `confirmBounds` | 含路径硬边界（hardRules）时需显式 `true`；否则 409 并返回 `data.hardRules` / `data.semanticBounds` 由集成方决定 |

响应：`{ "ok": true, "data": { "sessionId": "..." } }`

### 会话列表

```
GET /api/v1/sessions?limit=20
```

响应 `data`：摘要数组（`id/title/status/permissionMode/createdAt/updatedAt/totalInputTokens/totalOutputTokens/totalCachedTokens/totalCostCny/todos/toolCallCount/kind` 等）。

### 会话详情

```
GET /api/v1/sessions/:id
```

响应 `data`：单会话摘要（同上结构）。

### 事件流（增量轮询）

```
GET /api/v1/sessions/:id/events?after=<seq>
```

响应：

```json
{
  "ok": true,
  "data": {
    "events": [ { "seq": 1, "ts": "...", "type": "user.text", "text": "..." } ],
    "latestSeq": 12
  }
}
```

- `after` 缺省 0（全量）；轮询模式：下次请求带上次响应的 `latestSeq`
- 事件类型（**白名单，永不破坏**）：

| type | 字段 | 内部来源 |
|---|---|---|
| `user.text` | text | user / user_queued |
| `assistant.text` | text | text_delta |
| `assistant.thinking` | text | thinking_delta |
| `tool.call` | tool, target?, args | tool_call |
| `tool.result` | tool, summary, isError | tool_result（tool 名由同流内前置 tool_call 补全） |
| `approval.request` | callId, tool, risk | ask_permission |
| `run.started` | description | run_started |
| `run.finished` | status, reason? | run_finished |
| `system.info` | message | 其余/未知类型折叠 |
| `system.error` | message | error |

内部新增事件类型自动折叠为 `system.info`，集成方契约不破。

### 发送消息

```
POST /api/v1/sessions/:id/messages
```

请求：`{ "message": "...", "steer": false }`

- `steer: true` 为插队消息（打断当前工具批次，参照现有 steer 语义）
- 任务发起一律走 `POST /runs`；此处发 `/run` 命令返回 400
- 响应：`{ "ok": true, "data": { "accepted": true, "queued": false } }`（`queued` 为当前是否排队）

### 审批

```
POST /api/v1/sessions/:id/approvals/:callId
```

请求：`{ "granted": true, "scope": "once", "feedback": "..." }`

- `granted` 必填布尔；`scope`：`once` / `session` / `project` / `global`（缺省 once）；`feedback` 可选
- 审批已失效/不存在返回 409

### 中断

```
POST /api/v1/sessions/:id/interrupt
```

响应：`{ "ok": true, "data": { "interrupted": true } }`；会话未运行时 409。

### 导出 HTML

```
GET /api/v1/sessions/:id/export
```

返回自包含 HTML（与 Web「导出」按钮同一产物）。

## 调用示例

### curl

```bash
TOKEN="你的 apiToken"
BASE="http://127.0.0.1:3000/api/v1"

# 发起任务
curl -X POST "$BASE/runs" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"/run 修复测试失败","confirmBounds":true}'

# 轮询事件
curl -s "$BASE/sessions/<sessionId>/events?after=0" \
  -H "Authorization: Bearer $TOKEN"
```

### 飞书机器人集成

机器人收到用户消息时：

1. `POST /api/v1/runs` 发起任务 → 拿 `sessionId`
2. 周期轮询 `GET /api/v1/sessions/:id/events?after=<latestSeq>`，按需提取 `run.started` / `tool.call` / `run.finished` 等事件
3. 任务结束（`run.finished` 或 `system.error`）后，`GET /api/v1/sessions/:id` 取费用/耗时，经飞书机器人 API 回推结果

任务完成推送也可走现有 `notify.webhook`（飞书机器人 webhook），二者可组合：机器人负责"发起 + 查询 + 回复"，webhook 负责"完成时主动推送"。

## 与 Web 内部 API 的关系

- `/api/v1` 是独立契约层：内部事件、响应字段的演进由适配层消化，不传导给集成方
- 前端 `/api/*` 不保证对外稳定，集成方一律使用 `/api/v1`
