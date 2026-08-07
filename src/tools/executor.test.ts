import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolCall } from "../core/types.js";
import { ToolExecutor } from "./executor.js";
import { PluginToolRegistry } from "../shared/plugin-tool.js";

function call(
  id: string,
  tool: ToolCall["tool"],
  target: string,
  args: unknown,
): ToolCall {
  return { id, tool, target, args };
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`git ${args.join(" ")} 退出码 ${code}`)),
    );
  });
}

test("Read 返回行号并支持 offset/limit 续读", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-read-"));
  await writeFile(
    path.join(cwd, "sample.txt"),
    ["alpha", "beta", "gamma", "delta"].join("\n"),
    "utf8",
  );
  const executor = new ToolExecutor(cwd);
  const result = await executor.execute(
    call("read-page", "Read", "sample.txt", {
      file_path: "sample.txt",
      offset: 2,
      limit: 2,
    }),
    new AbortController().signal,
  );

  assert.match(String(result.output), /^2\tbeta\n3\tgamma/);
  assert.match(String(result.output), /Read offset=4 继续/);
});

test("Grep 与 Glob 返回文件行号证据并跳过依赖目录", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-search-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "auth.ts"),
    "export function refreshToken() {}\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "src", "other.js"),
    "refreshToken();\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "node_modules", "ignored", "auth.ts"),
    "refreshToken();\n",
    "utf8",
  );
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;

  const grep = await executor.execute(
    call("grep", "Grep", "refreshToken", {
      pattern: "refreshToken",
      path: ".",
      glob: "**/*.ts",
    }),
    signal,
  );
  assert.match(String(grep.output), /src\/auth\.ts:1:/);
  assert.doesNotMatch(String(grep.output), /other\.js|node_modules/);

  const glob = await executor.execute(
    call("glob", "Glob", "**/*.ts", {
      pattern: "**/*.ts",
      path: ".",
    }),
    signal,
  );
  assert.equal(glob.output, "src/auth.ts");
});

test("Edit/Write 结果将 diff 移出 output（模型只见 summary，diff 进 details）", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-diffout-"));
  await writeFile(path.join(cwd, "sample.txt"), "before\n", "utf8");
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;

  // Edit 语义要求先 Read 目标文件
  await executor.execute(
    call("read", "Read", "sample.txt", { file_path: "sample.txt" }),
    signal,
  );
  const edit = await executor.execute(
    call("edit", "Edit", "sample.txt", {
      file_path: "sample.txt",
      old_string: "before",
      new_string: "after",
    }),
    signal,
  );
  assert.match(String(edit.output), /已编辑/, "output 应为简短 summary");
  assert.doesNotMatch(
    String(edit.output),
    /-before|\+after/,
    "diff 不应进入模型上下文",
  );
  assert.match(
    String((edit.details as { diff?: unknown }).diff),
    /-before\n\+after/,
    "完整 diff 进 details 供 UI 渲染",
  );

  const write = await executor.execute(
    call("write", "Write", "new.txt", {
      file_path: "new.txt",
      content: "line1\nline2\n",
    }),
    signal,
  );
  assert.match(String(write.output), /已写入/, "Write output 应为简短 summary");
  assert.match(String(write.output), /字节/, "Write 只报字节数（Pi 同款）");
  assert.doesNotMatch(String(write.output), /line1/);
  assert.equal(
    (write.details as { diff?: unknown }).diff,
    undefined,
    "Write 不产生 diff（避免事件流持久化膨胀）",
  );
});

test("git 仓库内 Grep/Glob 走 git 文件列表并遵循 .gitignore", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-gitsearch-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "tmp"), { recursive: true });
  await writeFile(
    path.join(cwd, ".gitignore"),
    "tmp/\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "src", "auth.ts"),
    "export const TOKEN = 1;\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "tmp", "scratch.ts"),
    "export const TOKEN = 2;\n",
    "utf8",
  );
  await runGit(cwd, ["init", "-q"]);
  await runGit(cwd, ["add", "src/auth.ts", ".gitignore"]);
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;

  const grep = await executor.execute(
    call("grep", "Grep", "TOKEN", {
      pattern: "TOKEN",
      path: ".",
      glob: "**/*.ts",
    }),
    signal,
  );
  assert.match(String(grep.output), /src\/auth\.ts:1:/);
  assert.doesNotMatch(String(grep.output), /scratch\.ts|tmp\//);

  const glob = await executor.execute(
    call("glob", "Glob", "**/*.ts", {
      pattern: "**/*.ts",
      path: ".",
    }),
    signal,
  );
  assert.equal(glob.output, "src/auth.ts");
});

test("非 git 目录按 .gitignore 规则过滤（目录前缀与 glob 模式）", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-ig-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "tmp"), { recursive: true });
  await mkdir(path.join(cwd, "sub", "tmp"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), "tmp/\n*.log\n", "utf8");
  await writeFile(
    path.join(cwd, "src", "a.ts"),
    "const marker = 'TRACE-IN-SRC';\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "tmp", "junk.log"),
    "TRACE-IN-TMP-LOG\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "debug.log"),
    "TRACE-IN-DEBUG\n",
    "utf8",
  );
  await writeFile(
    path.join(cwd, "sub", "tmp", "x.txt"),
    "TRACE-IN-NESTED\n",
    "utf8",
  );
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;

  const grep = await executor.execute(
    call("grep", "Grep", "TRACE", {
      pattern: "TRACE",
      path: ".",
    }),
    signal,
  );
  assert.match(String(grep.output), /src\/a\.ts:1:/);
  assert.doesNotMatch(
    String(grep.output),
    /junk\.log|debug\.log|nested|x\.txt/,
  );

  const glob = await executor.execute(
    call("glob", "Glob", "**/*", {
      pattern: "**/*",
      path: ".",
    }),
    signal,
  );
  // .gitignore 自身不被忽略（与 git 语义一致），被忽略的文件均不出现
  assert.match(String(glob.output), /src\/a\.ts/);
  assert.doesNotMatch(
    String(glob.output),
    /junk\.log|debug\.log|x\.txt/,
  );
});

test("TodoWrite 保存全量快照并拒绝多个进行中任务", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-todo-"));
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;
  const result = await executor.execute(
    call("todo", "TodoWrite", "3 items", {
      todos: [
        { id: "locate", content: "定位问题", status: "completed" },
        { id: "fix", content: "修复代码", status: "in_progress" },
        { id: "verify", content: "运行验证", status: "pending" },
      ],
    }),
    signal,
  );

  assert.equal(result.todoSnapshot?.length, 3);
  assert.equal(executor.todos.snapshot()[1]?.status, "in_progress");

  await assert.rejects(
    executor.execute(
      call("todo-invalid", "TodoWrite", "2 items", {
        todos: [
          { id: "one", content: "任务一", status: "in_progress" },
          { id: "two", content: "任务二", status: "in_progress" },
        ],
      }),
      signal,
    ),
    /只能有一项/,
  );
});

test("Write 可原子创建尚不存在的父目录", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-write-dir-"));
  const executor = new ToolExecutor(cwd);
  const result = await executor.execute(
    call("write-memory", "Write", ".myagent/memory/pitfalls.md", {
      file_path: ".myagent/memory/pitfalls.md",
      content: "- verified fact\n",
    }),
    new AbortController().signal,
  );

  assert.match(String(result.output), /已写入/);
  assert.equal(
    await readFile(
      path.join(cwd, ".myagent", "memory", "pitfalls.md"),
      "utf8",
    ),
    "- verified fact\n",
  );
});

test("Grep caseInsensitive:true 匹配不同大小写", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-ci-true-"));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "hello.ts"),
    ["export function sayHello() {}", "export function SAY_HELLO() {}", ""].join("\n"),
    "utf8",
  );
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;

  const result = await executor.execute(
    call("grep-ci", "Grep", "hello", {
      pattern: "hello",
      path: ".",
      case_insensitive: true,
    }),
    signal,
  );
  const lines = String(result.output).split("\n");
  assert.equal(lines.length, 2, "caseInsensitive:true 应匹配两行（sayHello 和 SAY_HELLO）");
  assert.match(lines[0], /hello\.ts:1:/);
  assert.match(lines[1], /hello\.ts:2:/);
});

test("Grep caseInsensitive:false 只匹配精确大小写", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-ci-false-"));
  await mkdir(path.join(cwd, "lib"), { recursive: true });
  await writeFile(
    path.join(cwd, "lib", "utils.ts"),
    ["export function parse() {}", "export function Parse() {}", "export function PARSE() {}", ""].join("\n"),
    "utf8",
  );
  const executor = new ToolExecutor(cwd);
  const signal = new AbortController().signal;

  const result = await executor.execute(
    call("grep-cs", "Grep", "parse", {
      pattern: "parse",
      path: ".",
      case_insensitive: false,
    }),
    signal,
  );
  const lines = String(result.output).split("\n");
  assert.equal(lines.length, 1, "caseInsensitive:false 应只匹配一行（小写 parse）");
  assert.match(lines[0], /utils\.ts:1:/);
});

test("插件工具经注册表分发执行，未注册名返回失败结果", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-exec-plugin-"));
  const registry = new PluginToolRegistry();
  registry.register({
    name: "Echo",
    description: "回显工具",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    async run(args, signal) {
      assert.equal(signal.aborted, false);
      return {
        summary: `回显 ${String(args.text)}`,
        output: `echo:${String(args.text)}`,
        details: { text: args.text },
      };
    },
  });
  const executor = new ToolExecutor(cwd, undefined, undefined, undefined, registry);
  const signal = new AbortController().signal;

  const result = await executor.execute(
    call("p1", "Echo", "hello", { text: "hello" }),
    signal,
  );
  assert.equal(result.summary, "回显 hello");
  assert.equal(result.output, "echo:hello");
  assert.deepEqual(result.details, { text: "hello" });

  const missing = await executor.execute(
    call("p2", "Ghost", "", { text: "x" }),
    signal,
  );
  assert.equal(missing.isError, true);
  assert.match(String(missing.output), /未注册/);
});
