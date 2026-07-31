import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConversationMessage } from "../model/types.js";
import { ContextManager, applySoftForgetting } from "./context.js";

test("ContextManager 注入 AGENTS、记忆与 Todo 快照", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-context-project-"));
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-context-home-"),
  );
  await mkdir(path.join(cwd, ".myagent", "memory"), { recursive: true });
  await mkdir(path.join(homeDir, ".myagent"), { recursive: true });
  await writeFile(
    path.join(cwd, "AGENTS.md"),
    "项目必须使用 pnpm。",
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".myagent", "memory", "pitfalls.md"),
    "测试必须串行运行。",
    "utf8",
  );
  await writeFile(
    path.join(homeDir, ".myagent", "MEMORY.md"),
    "默认使用中文交流。",
    "utf8",
  );
  const context = new ContextManager({ cwd, homeDir });
  context.setTodos([
    { id: "inspect", content: "检查代码", status: "in_progress" },
    { id: "verify", content: "运行测试", status: "pending" },
  ]);

  const prepared = await context.prepare("基础系统提示", [
    { role: "user", content: "开始" },
  ]);

  assert.match(prepared.system, /项目必须使用 pnpm/);
  assert.match(prepared.system, /测试必须串行运行/);
  assert.match(prepared.system, /默认使用中文交流/);
  assert.match(prepared.system, /\[in_progress\] inspect: 检查代码/);
});

test("ContextManager 仅注入其他项目记忆标题索引与完整路径", async () => {
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-context-home-"),
  );
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "myagent-context-current-"),
  );
  const other = await mkdtemp(
    path.join(os.tmpdir(), "myagent-context-other-"),
  );
  const stateDir = path.join(homeDir, ".myagent");
  await mkdir(
    path.join(stateDir, "projects", "other-project"),
    { recursive: true },
  );
  await mkdir(path.join(other, ".myagent", "memory"), {
    recursive: true,
  });
  await writeFile(
    path.join(
      stateDir,
      "projects",
      "other-project",
      "project.json",
    ),
    JSON.stringify({ name: "project-a", cwd: other }),
    "utf8",
  );
  const memoryPath = path.join(
    other,
    ".myagent",
    "memory",
    "pitfalls.md",
  );
  await writeFile(
    memoryPath,
    "- Chroma 查询必须设置 timeout\n完整解释不应直接注入\n",
    "utf8",
  );
  const manager = new ContextManager({
    cwd,
    homeDir,
    stateDir,
  });

  const prepared = await manager.prepare("base", []);

  assert.match(prepared.system, /其他项目记忆索引/);
  assert.match(prepared.system, /project-a/);
  assert.match(prepared.system, /Chroma 查询必须设置 timeout/);
  assert.match(prepared.system, new RegExp(escapeRegExp(memoryPath)));
  assert.doesNotMatch(prepared.system, /完整解释不应直接注入/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("软遗忘只替换最近三轮之前的工具结果并给出恢复指引", () => {
  const messages: ConversationMessage[] = [];
  for (let index = 1; index <= 5; index += 1) {
    messages.push({ role: "user", content: `问题 ${index}` });
    messages.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `read-${index}`,
          tool: "Read",
          target: `file-${index}.ts`,
          args: { filePath: `file-${index}.ts` },
        },
      ],
    });
    messages.push({
      role: "tool",
      toolCallId: `read-${index}`,
      toolName: "Read",
      target: `file-${index}.ts`,
      content: `large output ${index}`,
      isError: false,
    });
  }

  const prepared = applySoftForgetting(messages, 3);
  const toolMessages = prepared.filter((message) => message.role === "tool");
  assert.match(toolMessages[0]?.content ?? "", /输出已省略.*重新调用 Read/);
  assert.match(toolMessages[1]?.content ?? "", /输出已省略.*重新调用 Read/);
  assert.equal(toolMessages[2]?.content, "large output 3");
  assert.equal(toolMessages[4]?.content, "large output 5");
});
