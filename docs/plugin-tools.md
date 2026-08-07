# 插件工具通道（.myagent/tools/）

MyAgent 支持以插件形式引入自定义工具，参考 Pi 扩展系统的 tools 注册面设计，一期仅「注册 + 执行」（无 before/afterToolCall 钩子面，钩子面为二期候选）。

## 目录与发现

两层目录，单层文件发现（非递归）：

- 全局：`~/.myagent/tools/*.ts`（或 `.mjs` / `.js`）
- 项目：`<cwd>/.myagent/tools/*.ts`（同名时项目层覆盖全局层，与配置合并语义一致）

每个文件 default 导出一个工具对象。插件在 **server/进程启动后首个会话创建时一次性加载**；会话内工具集固定（与内置工具同一约束，不破坏 prompt cache 前缀）。**新增/修改插件需重启 server（或重新启动 CLI）**，无热重载。

## 工具协议

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

## 权限

插件工具不在内置权限划分（`NORMAL_AUTO`/`STRICT_GATED`）内：

| 档位 | 行为 |
| --- | --- |
| normal | 兜底 ask：每次调用需审批（可添加 `"WebFetch(*)"` allow 规则后放行） |
| trust | 全部 allow |
| strict | 直接 allow（插件不在写工具门控集） |

权限规则在设置页「权限与审批」分区添加，pattern 语法为 `工具名(参数)` 加 `*` 通配。

## 安全模型

插件代码以 agent 进程权限运行——**与 Bash 工具同等信任**。只安装你信任的插件；示例 WebFetch 会发起网络请求。设置页 `behavior.enablePlugins` 可整体关闭插件通道。

## 示例插件

- `.myagent/tools/web-fetch.ts`（本仓库已随包提供）：抓取 URL 返回可见文本（HTML/JSON/纯文本自动识别，默认截断 8000 字符，`max_chars` 可调）。
- `.myagent/tools/web-search.ts`（本仓库已随包提供）：网络搜索，两级策略：
  - **API 模式（推荐）**：配置 provider 后走结构化搜索，返回 `title/url/content`（页面正文），一次调用即拿到素材，无需再 WebFetch。配置于 `~/.myagent/plugins.json`（全局）或 `<cwd>/.myagent/plugins.json`（项目，覆盖全局；该文件已 gitignore）：
    - **Tavily**（云服务，免费层 1000 次/月，[tavily.com](https://tavily.com) 注册）：
      ```json
      { "webSearch": { "provider": "tavily", "apiKey": "tvly-..." } }
      ```
      或环境变量 `TAVILY_API_KEY`。
    - **SearXNG**（自托管元搜索，无配额限制）：先部署实例（见下），再配置：
      ```json
      { "webSearch": { "provider": "searxng", "baseUrl": "http://127.0.0.1:8080", "apiToken": "myagent-search-token" } }
      ```
  - **降级模式**：无配置或 API 失败时自动顺延 HTML 引擎链（bing → duckduckgo → baidu），免配置但依赖页面结构。
  - `engine` 参数：`auto`（默认，API 优先 + HTML 降级）/ `html`（强制 HTML 链）/ 指定单引擎。

**SearXNG 部署（Docker）**：
```bash
mkdir -p ~/.searxng && cat > ~/.searxng/settings.yml << 'EOF'
use_default_settings: true
server:
  limiter: false          # 本机使用：关闭限流
  public_instance: false
  secret_key: "<随机串>"
  api_token: "<你的 token>"   # JSON API 需要；插件 apiToken 填此值
search:
  formats:
    - html
    - json                 # 默认不含 json，必须显式放行
EOF
docker run -d --name myagent-searxng -p 8080:8080 \
  -v ~/.searxng:/etc/searxng searxng/searxng:latest
# 验证：curl "http://127.0.0.1:8080/search?q=test&format=json" -H "Authorization: Bearer <你的 token>"
```
注意：SearXNG 默认配置禁止 JSON 格式输出（403），必须通过 `search.formats` 显式放行；未配置 `api_token` 时 JSON 请求可能被限流。

## MCP 服务器接入

MyAgent 内置最小 MCP 客户端（无 SDK，按 2025-06-18 规范实现）：配置在 `plugins.json` 的 `mcpServers` 段（两层合并，文件已 gitignore）后，MCP server 的**工具自动注册进插件通道**——权限/审批/UI/统计与普通插件工具一致（工具名 `ServerName_ToolName` 归一化）。

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
- 二期候选：before/afterToolCall 钩子面、/reload 热重载、MCP 客户端、插件配置（env/密钥注入）、UI 自定义渲染
