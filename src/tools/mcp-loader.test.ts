import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PluginToolRegistry } from "../shared/plugin-tool.js";
import { McpClient } from "./mcp-client.js";
import {
  closeMcpClients,
  loadMcpServers,
  mcpContentToText,
  readMcpServersConfig,
} from "./mcp-loader.js";

const FAKE_STDIO_SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } });
  } else if (msg.method === 'notifications/initialized') {
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'read file', description: 'Read a file', inputSchema: { type: 'object' } },
      { name: 'write', description: 'Write a file', inputSchema: { type: 'object' } }
    ] } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'mcp-ok' }] } });
  }
});
`;

async function fixture(): Promise<{ home: string; project: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-mcp-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".myagent"), { recursive: true });
  await mkdir(path.join(project, ".myagent"), { recursive: true });
  return { home, project };
}

function serverConfig(command: string) {
  return JSON.stringify({
    mcpServers: {
      fs: { command, args: ["-e", FAKE_STDIO_SERVER] },
      disabled: { command, args: ["-e", FAKE_STDIO_SERVER], enabled: false },
      broken: { command: "/nonexistent/binary" },
      empty: {},
    },
  });
}

test("readMcpServersConfig：两层合并、enabled:false 跳过、缺 command/url 跳过", async () => {
  const { home, project } = await fixture();
  try {
    await writeFile(
      path.join(home, ".myagent", "plugins.json"),
      serverConfig(process.execPath),
      "utf8",
    );
    await writeFile(
      path.join(project, ".myagent", "plugins.json"),
      JSON.stringify({
        mcpServers: {
          fs: { command: "node", args: ["proj.js"], env: { K: "v" } },
          remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" }, timeoutMs: 5000 },
        },
      }),
      "utf8",
    );
    const configs = await readMcpServersConfig(home, project);
    // 项目层 fs 覆盖全局层（command 变 node）；disabled/broken/empty 均被过滤
    assert.deepEqual([...configs.keys()].sort(), ["fs", "remote"]);
    assert.equal(configs.get("fs")?.command, "node");
    assert.deepEqual(configs.get("fs")?.args, ["proj.js"]);
    assert.deepEqual(configs.get("fs")?.env, { K: "v" });
    assert.equal(configs.get("remote")?.url, "https://example.com/mcp");
    assert.equal(configs.get("remote")?.headers?.Authorization, "Bearer t");
    assert.equal(configs.get("remote")?.timeoutMs, 5000);
  } finally {
    await rm(path.dirname(home), { recursive: true, force: true });
  }
});

test("loadMcpServers：stdio server 工具注册为 Server_Tool 命名，坏 server 跳过", async () => {
  const { home, project } = await fixture();
  try {
    await writeFile(
      path.join(project, ".myagent", "plugins.json"),
      serverConfig(process.execPath),
      "utf8",
    );
    const registry = new PluginToolRegistry();
    const clients = new Map<string, McpClient>();
    const report = await loadMcpServers(home, project, registry, clients);

    assert.deepEqual(
      report.servers.map((item) => item.name),
      ["fs"],
    );
    assert.equal(report.servers[0]?.tools, 2);
    assert.equal(report.errors.length, 1, "坏 server 记入错误不阻塞");
    assert.equal(report.errors[0]?.name, "broken");

    // 归一化命名 + description 前缀
    assert.equal(registry.has("fs_read_file"), true);
    assert.equal(registry.has("fs_write"), true);
    assert.equal(registry.has("fs_disabled_tool"), false);
    const definitions = registry.definitions();
    assert.match(
      definitions.find((tool) => tool.name === "fs_read_file")?.description ?? "",
      /^\[MCP:fs\]/,
    );

    // 调用转发到 MCP server
    const result = await registry.execute(
      "fs_write",
      { file_path: "a.txt" },
      new AbortController().signal,
    );
    assert.equal(result.isError, undefined);
    assert.equal(result.output, "mcp-ok");
    assert.deepEqual(result.details, {
      mcpServer: "fs",
      mcpTool: "write",
    });
    await closeMcpClients(clients);
  } finally {
    await rm(path.dirname(home), { recursive: true, force: true });
  }
});

test("loadMcpServers：HTTP server 注册；调用失败返回 isError 不抛", async () => {
  const { home, project } = await fixture();
  let failCalls = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as { id?: unknown; method: string; params?: { name?: string } };
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fake", version: "1.0" },
        };
      } else if (message.method === "notifications/initialized") {
        response.setHeader("content-type", "application/json");
        response.end("{}");
        return;
      } else if (message.method === "tools/list") {
        result = {
          tools: [
            { name: "remote_read", description: "Remote read", inputSchema: { type: "object" } },
            { name: "remote_broken", description: "Always fails", inputSchema: { type: "object" } },
          ],
        };
      } else if (message.method === "tools/call") {
        if (message.params?.name === "remote_broken") {
          failCalls += 1;
          result = { content: [{ type: "text", text: "nope" }], isError: true };
        } else {
          result = { content: [{ type: "text", text: "remote-ok" }] };
        }
      } else {
        response.statusCode = 500;
        response.end("{}");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    await writeFile(
      path.join(project, ".myagent", "plugins.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: `http://127.0.0.1:${port}/mcp` },
        },
      }),
      "utf8",
    );
    const registry = new PluginToolRegistry();
    const clients = new Map<string, McpClient>();
    const report = await loadMcpServers(home, project, registry, clients);
    assert.deepEqual(report.servers, [{ name: "remote", tools: 2 }]);
    assert.deepEqual(report.errors, []);

    const ok = await registry.execute(
      "remote_remote_read",
      {},
      new AbortController().signal,
    );
    assert.equal(ok.output, "remote-ok");

    const failed = await registry.execute(
      "remote_remote_broken",
      {},
      new AbortController().signal,
    );
    assert.equal(failed.isError, true);
    assert.equal(failCalls, 1);
    await closeMcpClients(clients);
  } finally {
    server.close();
    await rm(path.dirname(home), { recursive: true, force: true });
  }
});

test("mcpContentToText：text 拼接与 image/resource 摘要", () => {
  assert.equal(
    mcpContentToText([
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ]),
    "第一段\n第二段",
  );
  assert.equal(
    mcpContentToText([
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "resource_link", uri: "file:///tmp/a.txt" },
    ]),
    "[图片（image/png，base64 4 字符）]\n[资源：file:///tmp/a.txt]",
  );
});
