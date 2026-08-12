import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * 最小 MCP（Model Context Protocol）客户端，无 SDK。
 * 按 2025-06-18 规范实现（当前主流 MCP server 均为 legacy 时代，可互操作）：
 * - stdio transport：newline-delimited JSON（消息内不得含换行），
 *   stderr 供服务端日志；
 * - streamable HTTP transport：POST + 可选 Mcp-Session-Id，响应为
 *   application/json 或 text/event-stream（最小 SSE 解析，data: 行）；
 * - 握手：initialize（请求 "2025-06-18"，接受服务端返回版本）→
 *   notifications/initialized → tools/list（cursor 分页）。
 *
 * 一期范围：tools/list + tools/call；不做 resources/prompts、OAuth、
 * 进度通知、notifications/cancelled（超时丢弃并日志，规范 SHOULD 非 MUST）、
 * 2026-07-28 modern 协议（initialize 阶段封装为 #handshake 便于替换）。
 */

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpServerConfig {
  /** stdio 模式：可执行命令（如 npx），配合 args/env */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP 模式：完整 endpoint URL（如 https://host/mcp） */
  url?: string;
  /** HTTP 模式：额外请求头（认证等） */
  headers?: Record<string, string>;
  /** 单次工具调用超时（ms），默认 60s */
  timeoutMs?: number;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2025-06-18";
const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const CLOSE_WAIT_MS = 2_000;

export class McpClient {
  readonly name: string;
  readonly #config: McpServerConfig;
  readonly #emitter = new EventEmitter();
  readonly #pending = new Map<string | number, PendingRequest>();
  #nextId = 1;
  #protocolVersion = PROTOCOL_VERSION;
  #transport: "stdio" | "http" | undefined;
  #child: ChildProcess | undefined;
  #stdinClosed = false;
  #buffer = "";
  #closed = false;
  /** HTTP 会话 id（initialize 响应头捕获，后续请求回带） */
  #sessionId: string | undefined;
  #connected = false;

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.#config = config;
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** 握手：initialize → initialized 通知。失败抛错（由 loader 记入报告） */
  async connect(): Promise<void> {
    if (this.#connected) return;
    if (this.#config.url) {
      this.#transport = "http";
    } else if (this.#config.command) {
      this.#transport = "stdio";
      this.#spawnStdio();
    } else {
      throw new Error("MCP server 配置缺少 command 或 url");
    }
    try {
      await this.#handshake();
      this.#connected = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (;;) {
      const result = (await this.#request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        HANDSHAKE_TIMEOUT_MS,
      )) as { tools?: unknown; nextCursor?: unknown };
      const page = Array.isArray(result?.tools) ? result.tools : [];
      for (const raw of page) {
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== "string" || !tool.name) continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          ...(tool.inputSchema &&
          typeof tool.inputSchema === "object" &&
          !Array.isArray(tool.inputSchema)
            ? { inputSchema: tool.inputSchema as Record<string, unknown> }
            : {}),
        });
      }
      if (typeof result?.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    if (!this.#connected || this.#closed) {
      throw new McpError(`MCP server“${this.name}”未连接或已断开`);
    }
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const result = (await this.#request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
      signal,
    )) as McpToolResult;
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      ...(result?.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(result?.isError === undefined
        ? {}
        : { isError: result.isError }),
    };
  }

  /** 终止连接：stdio 关 stdin → 等退出 → SIGTERM 兜底 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#failPending(new McpError("MCP 连接已关闭"));
    const child = this.#child;
    if (child) {
      this.#child = undefined;
      if (!this.#stdinClosed) {
        this.#stdinClosed = true;
        child.stdin?.end();
      }
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          resolve();
        }, CLOSE_WAIT_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** 进程退出兜底：同步终止子进程（process.on("exit") 回调内调用，不能 await） */
  disposeSync(): void {
    const child = this.#child;
    if (!child || this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    this.#child = undefined;
    if (!this.#stdinClosed) {
      this.#stdinClosed = true;
      child.stdin?.end();
    }
    child.kill("SIGTERM");
  }

  #spawnStdio(): void {
    const { command, args, env } = this.#config;
    const child = spawn(command!, args ?? [], {
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // 规范允许 stderr 用于日志
      console.error(`[mcp:${this.name}] ${chunk.trimEnd()}`);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onStdoutData(chunk));
    child.on("error", (error) => {
      // spawn 失败（ENOENT/EMFILE 等）：挂起请求立即失败，不空等超时
      this.#connected = false;
      this.#failPending(
        new McpError(`MCP server“${this.name}”进程启动失败：${error.message}`),
      );
      this.#emitter.emit("disconnected", error);
    });
    child.on("exit", (code) => {
      if (!this.#closed) {
        // 崩溃/被杀：挂起请求立即失败（原为空等 60s 超时，无人值守会假死数分钟），
        // 后续调用快速失败（#connected 已复位）
        this.#connected = false;
        this.#failPending(
          new McpError(`MCP server“${this.name}”进程退出（code=${code}）`),
        );
        this.#emitter.emit("disconnected", new Error(`进程退出（code=${code}）`));
      }
    });
  }

  /** 进程崩溃/关闭时让全部挂起请求立即失败（清定时器，防悬挂） */
  #failPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #onStdoutData(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.#handleMessage(JSON.parse(trimmed) as Record<string, unknown>);
      } catch (error) {
        console.error(
          `[mcp:${this.name}] 无法解析服务端消息：${(error as Error).message}`,
        );
      }
    }
  }

  #handleMessage(message: Record<string, unknown>): void {
    if (message.id === undefined || message.id === null) {
      // 通知：忽略（进度/日志等，一期不处理）
      return;
    }
    const id = message.id as string | number;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = message.error as
      | { code?: unknown; message?: unknown }
      | undefined;
    if (error) {
      pending.reject(
        new McpError(
          String(error.message ?? "MCP 请求失败"),
          typeof error.code === "number" ? error.code : undefined,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  async #handshake(): Promise<void> {
    const result = (await this.#request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "myagent", version: "0.1.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    )) as { protocolVersion?: unknown; capabilities?: unknown; serverInfo?: unknown };
    if (typeof result?.protocolVersion === "string") {
      // 接受服务端返回的版本（工具协议跨版本兼容；版本协商失败时服务端会回 error）
      this.#protocolVersion = result.protocolVersion;
    }
    await this.#notify("notifications/initialized", {});
  }

  #request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      if (this.#closed) {
        reject(new McpError("MCP 连接已关闭"));
        return;
      }
      if (signal?.aborted) {
        reject(new McpError("请求被中止"));
        return;
      }
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new McpError("请求被中止"));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        reject(new McpError(`MCP 请求超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(result);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const message = { jsonrpc: "2.0", id, method, params };
      void this.#send(message).catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async #notify(method: string, params: unknown): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method, params });
  }

  async #send(message: Record<string, unknown>): Promise<void> {
    if (this.#transport === "http") {
      await this.#sendHttp(message);
      return;
    }
    const child = this.#child;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || this.#stdinClosed) {
      throw new McpError(`MCP server“${this.name}”stdin 不可写`);
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #sendHttp(message: Record<string, unknown>): Promise<void> {
    const url = this.#config.url!;
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(this.#config.headers ?? {}),
    };
    // initialize 请求本身不带版本头（版本在 body 协商）；握手后所有请求带
    if (message.method !== "initialize" && this.#protocolVersion) {
      headers["mcp-protocol-version"] = this.#protocolVersion;
    }
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    if (response.status === 404) {
      // 会话失效（规范：须不带 session id 重新 initialize；一期直接失败）
      throw new McpError(`MCP HTTP 会话失效（404），需重新连接`);
    }
    if (!response.ok) {
      throw new McpError(`MCP HTTP ${response.status}`);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (contentType.includes("text/event-stream")) {
      const parsed = parseSse(text);
      if (parsed !== undefined) this.#handleMessage(parsed);
      return;
    }
    if (!text) return;
    try {
      this.#handleMessage(JSON.parse(text) as Record<string, unknown>);
    } catch (error) {
      throw new McpError(
        `MCP HTTP 响应不是有效 JSON：${(error as Error).message}`,
      );
    }
  }
}

/** 最小 SSE 解析：取 data: 行（多行拼接），返回最后一个事件的 JSON 负载 */
export function parseSse(text: string): Record<string, unknown> | undefined {
  let data = "";
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).trimStart();
      data += (data ? "\n" : "") + value;
    }
  }
  if (!data) return undefined;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 归一化 MCP 工具名：ServerName_ToolName，非法字符替换为 _，首字符非字母补 M_ */
export function mcpToolName(serverName: string, toolName: string): string {
  const sanitize = (value: string): string => {
    const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
    return /^[A-Za-z]/.test(cleaned)
      ? cleaned
      : `M_${cleaned}`;
  };
  return `${sanitize(serverName)}_${sanitize(toolName)}`;
}
