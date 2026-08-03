import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConversationMessage } from "../model/types.js";
import { ContextManager, applySoftForgetting } from "./context.js";

test("ContextManager 注入 AGENTS、记忆；Todo 作为独立消息注入", async () => {
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
  // Todo 快照不得进入 system：它高频变化，会破坏 system 前缀缓存
  assert.doesNotMatch(prepared.system, /in_progress\] inspect/);
  // Todo 作为独立消息注入，位于最后一条 user 消息之前
  assert.match(prepared.messages[0]!.content, /\[in_progress\] inspect: 检查代码/);
  assert.equal(prepared.messages[1]?.content, "开始");
});

test("跨项目索引与 system 前缀在多次 prepare 间保持稳定", async () => {
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
  await writeFile(
    path.join(other, ".myagent", "memory", "pitfalls.md"),
    "- Chroma 查询必须设置 timeout\n",
    "utf8",
  );
  const context = new ContextManager({
    cwd,
    homeDir,
    stateDir,
  });

  const first = await context.prepare("base", [
    { role: "user", content: "问题 1" },
  ]);
  const second = await context.prepare("base", [
    { role: "user", content: "问题 1" },
    { role: "assistant", content: "回答", toolCalls: [] },
    { role: "user", content: "问题 2" },
  ]);
  // system 不含 todos，且跨项目索引只生成一次 → 两次 prepare 的 system 完全一致
  assert.equal(first.system, second.system);
  assert.match(first.system, /project-a/);
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

test("出现探索工具后生成并注入仓库签名地图", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-context-map-"));
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-context-home-"),
  );
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "helper.ts"),
    "export function helper(value: number): number {\n  return value * 2;\n}\n",
    "utf8",
  );
  const context = new ContextManager({ cwd, homeDir });

  // 无探索历史：不生成仓库地图
  const plain = await context.prepare("base", [
    { role: "user", content: "开始" },
  ]);
  assert.doesNotMatch(plain.system, /仓库签名地图/);

  // 出现 Grep 工具结果后：生成并注入
  const prepared = await context.prepare("base", [
    { role: "user", content: "探索" },
    {
      role: "tool",
      toolCallId: "grep-1",
      toolName: "Grep",
      target: "helper.ts",
      content: "helper.ts:1",
      isError: false,
    },
  ]);
  assert.match(prepared.system, /仓库签名地图/);
  assert.match(prepared.system, /fn helper\(value\)/);
});


test("静态段会话内固定：运行中修改记忆文件不改变 system 前缀", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "myagent-context-static-"));
  const homeDir = await mkdtemp(
    path.join(os.tmpdir(), "myagent-context-home-"),
  );
  await mkdir(path.join(cwd, ".myagent", "memory"), { recursive: true });
  await writeFile(path.join(cwd, "AGENTS.md"), "版本一：使用 pnpm。", "utf8");
  const context = new ContextManager({ cwd, homeDir });

  const first = await context.prepare("base", [
    { role: "user", content: "问题 1" },
  ]);
  assert.match(first.system, /版本一/);

  // 模拟会话中 agent 写入记忆：当前会话 system 不刷新（参照 Pi：启动时加载）
  await writeFile(path.join(cwd, "AGENTS.md"), "版本二：改用 npm。", "utf8");
  const second = await context.prepare("base", [
    { role: "user", content: "问题 1" },
    { role: "assistant", content: "回答", toolCalls: [] },
    { role: "user", content: "问题 2" },
  ]);

  assert.equal(first.system, second.system, "system 前缀必须保持字节级稳定");
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
