# 插件工具通道（.myagent/tools/）与网络搜索

MyAgent 支持以插件形式引入自定义工具，参考 Pi 扩展系统的 tools 注册面设计。插件工具对模型、权限、审批、UI 而言与内置工具无差别——接入一个工具 = 写一个插件文件。

## 架构总览：插件从文件到模型调用的完整链路

```
.myagent/tools/*.ts（插件文件）
  → PluginToolRegistry（全局单例注册表）
  → getAllToolDefinitions()（工具列表合并，模型可见）
  → client guard（工具名开放集校验）
  → executor 分发（内置未命中 → 插件 run）
  → 权限引擎（normal 兜底 ask + 通配记忆）
  → UI 通用 tool card 渲染（零改动）
```

### 目录与发现

两层目录，单层文件发现（非递归）：

- 全局：`~/.myagent/tools/*.ts`（或 `.mjs` / `.js`）
- 项目：`<cwd>/.myagent/tools/*.ts`（同名时项目层覆盖全局层，与配置合并语义一致）

每个文件 default 导出一个工具对象。插件在 **server/进程启动后首个会话创建时一次性加载**（`session-manager.#ensurePlugins`，懒加载；`behavior.enablePlugins: false` 可整体关闭）；会话内工具集固定（与内置工具同一约束，不破坏 prompt cache 前缀）。**新增/修改插件需重启 server（或重新启动 CLI）**，无热重载。坏文件跳过并记日志，不阻塞会话。

### 工具协议

```ts
// .myagent/tools/web-fetch.ts
import { definePluginTool } from "../../src/shared/plugin-tool.js";

export default definePluginTool({
  name: "WebFetch",                       // 唯一；字母开头，仅字母/数字/_/-；不得与内置工具重名
  description: "Fetch a URL and return its visible text content.",
  inputSchema: {                          // JSON Schema，参数经统一校验后传入 run
    type: "object",
    properties: { url: { type: "string", minLength: 1 } },
    required: ["url"],
    additionalProperties: false,
  },
  async run(args, signal) {
    // 失败不 throw：编码进结果（isError: true），遵循 loop 的 streamFn 契约
    return {
      summary: "已抓取 https://example.com（1200 字符）",  // 必填，事件流展示
      output: "文本内容……",                                // 进 LLM 上下文的纯文本
      details: { url, status: 200 },                        // 仅 UI 展示，不进模型
      isError: false,
    };
  },
});
```

- `run(args, signal)`：`args` 为经过 schema 校验后的参数；`signal` 中止信号（中断时建议配合 fetch/子进程使用）
- 结果字段与内置工具 `ToolExecutionResult` 对齐：`summary` 必填，`output`/`details`/`isError` 可选
- `details` 任意键值对自动渲染到 UI 的详情网格（键名 `diff` 有专门的高亮渲染；`code`/`durationMs` 有退出码/时长着色）

### 注册与分发（关键代码位置）

- 注册：`src/shared/plugin-tool.ts` 的 `PluginToolRegistry` 单例；`loadPluginTools(homeDir, cwd, registry)` 动态 import 插件文件
- 模型可见：`src/tools/tool-definitions.ts` 的 `getAllToolDefinitions()` = 内置工具 + registry 全部插件
- 工具名开放集：`src/model/client.ts` guard 用 `isToolName(name) || pluginToolRegistry.has(name)`——模型可以调用任意已注册插件名，不校验内置枚举
- 分发：`src/tools/executor.ts` 先查内置工具，未命中转 `#plugins.execute()` 调插件 `run`
- MCP 工具经 `mcp-loader` 归一化后注册进**同一个 registry**，对模型/权限/UI 与普通插件完全同类

## 权限

插件工具不在内置权限划分（`NORMAL_AUTO`/`STRICT_GATED`）内：

| 档位 | 行为 |
| --- | --- |
| normal | 兜底 ask：每次调用需审批（可添加 `"WebFetch(*)"` allow 规则后放行） |
| trust | 全部 allow |
| strict | 直接 allow（插件不在写工具门控集） |

审批记忆对插件工具使用**通配 pattern `ToolName(*)`**（session 记忆与持久化规则一致）：同一会话内任意参数不再重复询问（内置工具仍用精确签名）。

权限规则在设置页「权限与审批」分区添加，pattern 语法为 `工具名(参数)` 加 `*` 通配。

## 安全模型

插件代码以 agent 进程权限运行——**与 Bash 工具同等信任**。只安装你信任的插件；示例 WebFetch 会发起网络请求。设置页 `behavior.enablePlugins` 可整体关闭插件通道。

## 示例插件：网络搜索（WebSearch + WebFetch）

本仓库 `.myagent/tools/` 随包提供两个插件，共同构成完整的网络研究能力：

### WebFetch：反爬增强的页面抓取

抓取 URL 返回可见文本（HTML/JSON/纯文本自动识别，默认截断 8000 字符，`max_chars` 可调）。反爬策略：

- **浏览器级请求头**：完整 Chrome 桌面端请求头集（UA + Accept + Accept-Language + sec-ch-ua 系列）——裸 UA（如 `MyAgent/0.1`）会被 doc.rust-lang.org 这类站点直接拒绝，浏览器请求头实测放行
- **重试**：网络错误 / 5xx / 429 重试一次（800ms 退避）；4xx 判定为确定性拒绝不重试
- **可选 `cookies` 参数**：需要会话 cookie 的页面
- 抓取核心 `fetchPageText()` 为具名导出，供 WebSearch 深度模式复用

### WebSearch：三级 provider 策略 + 深度模式

```
searxng（自托管元搜索，默认）→ tavily（可选云 API）→ HTML 引擎链（bing → ddg → baidu）
```

- **searxng**：本机 Docker 部署（见下），`plugins.json` 配置 baseUrl + apiToken；空结果自动重试一次（800ms，应对上游引擎瞬时波动）
- **tavily**：可选降级。原则：**本地自托管优先，不依赖第三方 API Key**；仅在自行配置 key 后启用（`plugins.json` webSearch 段或环境变量 `TAVILY_API_KEY`）
- **HTML 引擎链**：无配置或 API 失败时自动顺延，免配置但依赖页面结构，可能随上游改版失效
- `engine` 参数：`auto`（默认）/ `html`（强制 HTML 链）/ 指定单引擎

**深度模式（`fetch_pages` 参数，默认 2，范围 0-3）**：搜索结果返回后自动并发抓取前 N 个结果的页面正文（每页 8s 超时、失败页面跳过、正文 2000 字符截断），拼进 `output` 与 `details`。模型一次 WebSearch 调用即拿到素材，无需二次 WebFetch。设为 0 关闭（仅返回 snippet）。

### 配置

`plugins.json`（两层浅合并：全局 `~/.myagent/plugins.json` + 项目 `<cwd>/.myagent/plugins.json` 覆盖；文件已 gitignore）的 `webSearch` 段：

```json
{
  "webSearch": {
    "provider": "searxng",
    "baseUrl": "http://127.0.0.1:8080",
    "apiToken": "myagent-search-token"
  }
}
```

### 并发与上游风控

- **服务端与插件层无并发上限**：SearXNG 多 worker（按核数）、limiter 已关、插件并发执行
- **真正的限制在上游引擎**：搜索引擎对同一 IP 的请求频率高度敏感。实测 3 并发查询中 2 个被限流（0 条）；密集请求（分钟级多次）会触发整组风控（CAPTCHA / suspended 180s-3600s）
- **安全并发 ≈ 1-2 个查询**（agent 单次调用一个搜索工具的场景足够）；深度模式内部并发抓取同样受目标站反爬限制，已有超时与失败跳过兜底

## SearXNG 部署与调优

### 部署（Docker 单容器）

```bash
mkdir -p ~/.searxng && cat > ~/.searxng/settings.yml << 'EOF'
# 见下方「完整配置」段
EOF
docker run -d --name myagent-searxng -p 8080:8080 \
  -v ~/.searxng:/etc/searxng searxng/searxng:latest
# 验证：curl "http://127.0.0.1:8080/search?q=test&format=json" -H "Authorization: Bearer <token>"
```

要点：

- 默认配置**禁止 JSON 输出**（403），必须 `search.formats` 显式放行 `json`
- 未配置 `api_token` 时 JSON 请求被限流；插件请求带 `Authorization: Bearer <token>` + 浏览器 UA（无 UA 被上游引擎拒）
- 容器无开机自启：`docker update --restart unless-stopped myagent-searxng`（可选）

### 完整配置（含引擎组调优）

```yaml
use_default_settings:
  engines:
    keep_only:            # 引擎收敛：注意 keep_only 必须在 use_default_settings 内部
      - duckduckgo        #   （顶层 engines 只放引擎定义覆盖，语法坑见下）
      - bing
      - brave
      - startpage
      - mojeek
      - wikipedia
server:
  limiter: false          # 本机使用：关闭限流
  public_instance: false
  secret_key: "<随机串>"
  api_token: "<你的 token>"
search:
  formats:
    - html
    - json
engines:
  - name: duckduckgo      # 引擎覆盖：dict 列表项，必须含 name 键
    weight: 1.3           # 加权保证主力引擎结果排序靠前
    timeout: 3.0          # 统一 3s 超时，慢引擎跳过而非拖累整次
  - name: bing
    disabled: false       # bing 在 SearXNG 默认配置里是禁用的，需显式启用
    timeout: 3.0
  - name: brave
    timeout: 3.0
  - name: startpage
    timeout: 3.0
  - name: mojeek
    timeout: 3.0
  - name: wikipedia
    timeout: 3.0
```

### 调优过程中的三个坑（已踩）

1. **`keep_only` 的位置**：必须写在 `use_default_settings.engines.keep_only`（list），不是顶层 `engines:`。顶层 `engines:` 是**引擎定义覆盖**，列表项必须是含 `name` 键的 dict——写错会导致启动崩溃（`TypeError: string indices must be integers`）
2. **google 系引擎不可用**：google / google cse 对数据中心 IP 持续反爬（"unusual traffic" 403，suspended 180s），实测偶有存活但不可依赖——从引擎组剔除
3. **bing 默认禁用**：SearXNG 官方默认 `disabled: true`，需显式覆盖启用

### 运维经验

- 上游风控是 IP 级的临时状态（180s-3600s），等待即可恢复，不需要重启容器（重启不清理上游侧状态）
- 修改 settings.yml 后 `docker restart myagent-searxng` 生效
- 观察引擎健康：`docker logs myagent-searxng` 里的 `suspended_time` 与 CAPTCHA 记录

## MCP 服务器接入

MyAgent 内置最小 MCP 客户端（无 SDK，按 2025-06-18 规范实现）：配置在 `plugins.json` 的 `mcpServers` 段后，MCP server 的**工具自动注册进插件通道**——权限/审批/UI/统计与普通插件工具一致（工具名 `ServerName_ToolName` 归一化）。

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer x" },
      "enabled": false
    }
  }
}
```

- **stdio**（本机子进程）：`command` + `args` + `env`（如 `npx -y 某server`）；**HTTP**（远端）：`url` + `headers`（认证等）
- `enabled: false` 关闭单个 server；`timeoutMs` 覆盖单次工具调用超时（默认 60s）
- server 连接/握手失败跳过并记日志，不阻塞其他 server 与插件；新增/修改配置需重启 server
- 权限：MCP 工具是插件工具 → normal 档兜底 ask（首次批准后本会话通配放行）
- 支持：`tools/list`（分页）、`tools/call`（text/image 摘要/structuredContent）；不支持：resources/prompts、OAuth、进度通知、2026-07-28 modern 协议

## 限制

- 构建产物（`dist/cli.js` 由 tsc 编译、无 tsx loader）下加载 `.ts` 插件会失败；构建产物运行时请使用 `.mjs`（原生 ESM）
- 无热重载：插件变更需重启 server
- explore 只读子代理不注入插件工具；Task 子代理 `writable: true` 时可见
- 二期候选：before/afterToolCall 钩子面、/reload 热重载、插件配置（env/密钥注入）、UI 自定义渲染
