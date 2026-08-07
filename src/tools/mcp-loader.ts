import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  McpClient,
  mcpToolName,
  type McpServerConfig,
  type McpToolInfo,
} from "./mcp-client.js";
import type { PluginToolRegistry } from "../shared/plugin-tool.js";

/**
 * MCP server 加载器：plugins.json 的 mcpServers 段 → 连接 → tools/list →
 * 逐工具注册进插件注册表（工具名 ServerName_ToolName 归一化防冲突）。
 *
 * 配置（~/.myagent/plugins.json 或 <cwd>/.myagent/plugins.json，项目覆盖全局）：
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": {} },
 *     "remote": { "url": "https://host/mcp", "headers": { "Authorization": "Bearer x" }, "enabled": false }
 *   }
 * }
 *
 * 单个 server 连接/握手失败跳过（记入报告 errors），不阻塞其他 server 与插件。
 * 进程级一次性加载（与插件一致）：新增/修改配置需重启 server。
 */

export interface McpLoadReport {
  servers: Array<{ name: string; tools: number }>;
  errors: Array<{ name: string; message: string }>;
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled?: boolean;
}

interface McpServersConfig {
  mcpServers?: Record<string, unknown>;
}

/** 读取 mcpServers 配置段（两层浅合并，ENOENT 静默——与 web-search 插件同模式） */
export async function readMcpServersConfig(
  homeDir = os.homedir(),
  cwd = process.cwd(),
): Promise<Map<string, McpServerConfig>> {
  const layers = [
    path.join(homeDir, ".myagent", "plugins.json"),
    path.join(cwd, ".myagent", "plugins.json"),
  ];
  let merged: McpServersConfig = {};
  for (const file of layers) {
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as McpServersConfig;
      // 顶层浅合并（对象层覆盖），项目层在后
      merged = { ...merged, ...raw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[plugins] 读取 ${file} 失败：${(error as Error).message}`);
      }
    }
  }
  const entries = new Map<string, McpServerConfig>();
  const rawServers = merged.mcpServers;
  if (!rawServers || typeof rawServers !== "object") return entries;
  for (const [name, raw] of Object.entries(rawServers)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as McpServerEntry;
    if (entry.enabled === false) continue;
    if (typeof entry.command === "string" && entry.command.trim()) {
      entries.set(name, {
        command: entry.command.trim(),
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        ...(entry.env && typeof entry.env === "object"
          ? { env: entry.env as Record<string, string> }
          : {}),
        ...(typeof entry.timeoutMs === "number"
          ? { timeoutMs: entry.timeoutMs }
          : {}),
      });
    } else if (typeof entry.url === "string" && entry.url.trim()) {
      entries.set(name, {
        url: entry.url.trim(),
        ...(entry.headers && typeof entry.headers === "object"
          ? { headers: entry.headers as Record<string, string> }
          : {}),
        ...(typeof entry.timeoutMs === "number"
          ? { timeoutMs: entry.timeoutMs }
          : {}),
      });
    }
  }
  return entries;
}

/** MCP 工具 content 数组 → 文本（text 拼接；image/audio/resource 摘要） */
export function mcpContentToText(content: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const block of content) {
    const type = String(block.type ?? "");
    if (type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (type === "image") {
      parts.push(`[图片（${String(block.mimeType ?? "unknown")}，base64 ${String(block.data ?? "").length} 字符）]`);
    } else if (type === "audio") {
      parts.push(`[音频（${String(block.mimeType ?? "unknown")}，base64 ${String(block.data ?? "").length} 字符）]`);
    } else if (type === "resource_link" || type === "resource") {
      const uri = String(
        (block as Record<string, unknown>).uri ??
          ((block.resource as Record<string, unknown> | undefined)?.uri ?? ""),
      );
      parts.push(`[资源：${uri}]`);
    } else {
      parts.push(`[未知内容块：${type || "?"}]`);
    }
  }
  return parts.join("\n");
}

/** 连接所有配置的 MCP server 并注册工具；返回报告（坏 server 不阻塞） */
export async function loadMcpServers(
  homeDir: string,
  cwd: string,
  registry: PluginToolRegistry,
  clients: Map<string, McpClient>,
): Promise<McpLoadReport> {
  const report: McpLoadReport = { servers: [], errors: [] };
  const configs = await readMcpServersConfig(homeDir, cwd);
  for (const [name, config] of configs) {
    const client = new McpClient(name, config);
    clients.set(name, client);
    try {
      await client.connect();
      const tools = await client.listTools();
      let registered = 0;
      for (const tool of tools) {
        registerMcpTool(name, tool, client, registry);
        registered += 1;
      }
      report.servers.push({ name, tools: registered });
    } catch (error) {
      report.errors.push({
        name,
        message: error instanceof Error ? error.message : "连接失败",
      });
    }
  }
  return report;
}

function registerMcpTool(
  serverName: string,
  tool: McpToolInfo,
  client: McpClient,
  registry: PluginToolRegistry,
): void {
  const normalized = mcpToolName(serverName, tool.name);
  registry.register(
    {
      name: normalized,
      description:
        `[MCP:${serverName}] ${tool.description ?? `调用 ${tool.name}`}`.trim(),
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object" },
      async run(args, signal) {
        try {
          const result = await client.callTool(tool.name, args, signal);
          const text = mcpContentToText(result.content);
          const output =
            text ||
            (result.structuredContent === undefined
              ? ""
              : JSON.stringify(result.structuredContent, null, 2));
          return {
            summary: `MCP“${serverName}”工具 ${tool.name} 已调用`,
            ...(output ? { output } : {}),
            details: {
              mcpServer: serverName,
              mcpTool: tool.name,
              ...(result.structuredContent === undefined
                ? {}
                : { structuredContent: result.structuredContent }),
            },
            ...(result.isError === true ? { isError: true } : {}),
          };
        } catch (error) {
          return {
            summary:
              error instanceof Error ? error.message : "MCP 工具调用失败",
            isError: true,
          };
        }
      },
    },
    `mcp:${serverName}#${tool.name}`,
  );
}

/** 终止全部 MCP 客户端（stdio 子进程；web server 关闭与进程退出路径调用） */
export async function closeMcpClients(
  clients: Map<string, McpClient>,
): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.close()));
  clients.clear();
}

/** 同步终止（process.on("exit") 兜底：exit 回调内不能 await） */
export function disposeMcpClientsSync(
  clients: Map<string, McpClient>,
): void {
  for (const client of clients.values()) client.disposeSync();
  clients.clear();
}
