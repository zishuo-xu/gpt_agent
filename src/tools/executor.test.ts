import assert from "node:assert/strict";
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

function call(
  id: string,
  tool: ToolCall["tool"],
  target: string,
  args: unknown,
): ToolCall {
  return { id, tool, target, args };
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
      filePath: "sample.txt",
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
      filePath: ".myagent/memory/pitfalls.md",
      content: "- verified fact\n",
    }),
    new AbortController().signal,
  );

  assert.match(String(result.output), /新建/);
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
      caseInsensitive: true,
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
      caseInsensitive: false,
    }),
    signal,
  );
  const lines = String(result.output).split("\n");
  assert.equal(lines.length, 1, "caseInsensitive:false 应只匹配一行（小写 parse）");
  assert.match(lines[0], /utils\.ts:1:/);
});
