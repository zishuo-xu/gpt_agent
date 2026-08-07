import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test from "node:test";
import {
  McpClient,
  McpError,
  mcpToolName,
  parseSse,
} from "./mcp-client.js";

/** 内联假 MCP stdio server（node -e 模式，参照 bash.test.ts） */
const FAKE_STDIO_SERVER = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } });
  } else if (msg.method === 'notifications/initialized') {
    // 通知无响应
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'fail', description: 'Fails', inputSchema: { type: 'object' } }
    ] } });
  } else if (msg.method === 'tools/call') {
    if (msg.params.name === 'hang') return; // 挂起：测超时
    if (msg.params.name === 'die') process.exit(0); // 自杀：测崩溃
    if (msg.params.name === 'fail') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg.params.arguments) }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
});
`;

function stdioConfig(overrides: Record<string, unknown> = {}) {
  return {
    command: process.execPath,
    args: ["-e", FAKE_STDIO_SERVER],
    timeoutMs: 2_000,
    ...overrides,
  };
}

async function connectFake(overrides: Record<string, unknown> = {}) {
  const client = new McpClient("fake", stdioConfig(overrides));
  await client.connect();
  return client;
}

test("stdio：握手 → 工具列表 → 调用往返（参数透传）", async () => {
  const client = await connectFake();
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["echo", "fail"],
    );
    assert.equal(tools[0]?.description, "Echo text");
    assert.deepEqual(tools[0]?.inputSchema?.properties, {
      text: { type: "string" },
    });

    const result = await client.callTool("echo", { text: "hello" });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0]?.text, 'echo:{"text":"hello"}');
  } finally {
    await client.close();
  }
});

test("stdio：并发请求独立关联 id", async () => {
  const client = await connectFake();
  try {
    const [a, b, c] = await Promise.all([
      client.callTool("echo", { text: "a" }),
      client.callTool("echo", { text: "b" }),
      client.callTool("echo", { text: "c" }),
    ]);
    assert.deepEqual(
      [a, b, c].map((result) => result.content[0]?.text),
      [
        'echo:{"text":"a"}',
        'echo:{"text":"b"}',
        'echo:{"text":"c"}',
      ],
    );
  } finally {
    await client.close();
  }
});

test("stdio：超时抛错；isError 结果透传；未知方法错误传播", async () => {
  const client = await connectFake();
  try {
    await assert.rejects(
      client.callTool("hang", {}),
      (error) =>
        error instanceof McpError && /超时/.test(error.message),
    );

    const failed = await client.callTool("fail", {});
    assert.equal(failed.isError, true);
    assert.equal(failed.content[0]?.text, "boom");
  } finally {
    await client.close();
  }
});

test("stdio：server 崩溃后调用快速失败", async () => {
  const client = await connectFake();
  try {
    // die 工具让 server 进程退出；等待退出传播
    await client.callTool("die", {}).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      client.callTool("echo", { text: "x" }),
      /未连接或已断开/,
    );
  } finally {
    await client.close();
  }
});

test("mcpToolName：归一化非法字符与数字开头，server 前缀防冲突", () => {
  assert.equal(mcpToolName("filesystem", "read_file"), "filesystem_read_file");
  assert.equal(mcpToolName("my server", "write file"), "my_server_write_file");
  assert.equal(mcpToolName("srv", "2fa.verify"), "srv_M_2fa_verify");
  assert.equal(mcpToolName("a", "read_file"), "a_read_file");
  assert.equal(mcpToolName("a", "read_file"), mcpToolName("a", "read_file"));
});

test("parseSse：data: 行提取 JSON；多行 data 拼接", () => {
  assert.deepEqual(
    parseSse('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'),
    { jsonrpc: "2.0", id: 1, result: { ok: true } },
  );
  assert.deepEqual(
    parseSse('data: {"jsonrpc":"2.0",\ndata: "id":1,\ndata: "result":{"ok":true}}\n\n'),
    { jsonrpc: "2.0", id: 1, result: { ok: true } },
  );
  assert.equal(parseSse("event: ping\n\n"), undefined);
});

test("HTTP：initialize 捕获 session id，后续请求回带与版本头", async () => {
  const seen: Array<{ headers: Record<string, string>; body: unknown }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({
        headers: request.headers as Record<string, string>,
        body,
      });
      const message = body as { id?: unknown; method: string };
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fake", version: "1.0" },
        };
        response.setHeader("mcp-session-id", "sess-42");
      } else if (message.method === "notifications/initialized") {
        // 通知无响应：空 200
        response.setHeader("content-type", "application/json");
        response.end("{}");
        return;
      } else if (message.method === "tools/list") {
        result = {
          tools: [{ name: "http_tool", description: "HTTP tool", inputSchema: { type: "object" } }],
        };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: "http-ok" }] };
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
    const client = new McpClient("http-fake", {
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { authorization: "Bearer tok" },
    });
    await client.connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["http_tool"]);
    const result = await client.callTool("http_tool", { x: 1 });
    assert.equal(result.content[0]?.text, "http-ok");
    await client.close();

    assert.equal(seen.length, 4);
    // initialize 请求：无版本头与 session id，带自定义认证头
    assert.equal(seen[0]?.headers["mcp-protocol-version"], undefined);
    assert.equal(seen[0]?.headers["mcp-session-id"], undefined);
    assert.equal(seen[0]?.headers["authorization"], "Bearer tok");
    // 后续请求：回带 session id + 版本头
    for (const entry of seen.slice(1)) {
      assert.equal(entry.headers["mcp-session-id"], "sess-42");
      assert.equal(entry.headers["mcp-protocol-version"], "2025-06-18");
    }
  } finally {
    server.close();
  }
});

test("HTTP：SSE 响应解析（完整握手 + 工具往返）", async () => {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as { id?: unknown; method: string };
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sse-fake", version: "1.0" },
        };
      } else if (message.method === "notifications/initialized") {
        response.setHeader("content-type", "application/json");
        response.end("{}");
        return;
      } else if (message.method === "tools/list") {
        result = {
          tools: [{ name: "sse_tool", description: "SSE tool", inputSchema: { type: "object" } }],
        };
      } else if (message.method === "tools/call") {
        result = { content: [{ type: "text", text: "sse-ok" }] };
      } else {
        response.statusCode = 500;
        response.end("{}");
        return;
      }
      // SSE 响应：data: 行
      response.setHeader("content-type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    const client = new McpClient("sse-fake", {
      url: `http://127.0.0.1:${port}/mcp`,
    });
    await client.connect();
    const tools = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["sse_tool"]);
    const result = await client.callTool("sse_tool", {});
    assert.equal(result.content[0]?.text, "sse-ok");
    await client.close();
  } finally {
    server.close();
  }
});
