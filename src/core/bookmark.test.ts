import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationAgentModel } from "./agent-model.js";
import type {
  CompletionRequest,
  ModelClient,
  ModelResponse,
} from "../model/types.js";
import { AgentSession } from "./session.js";
import { AgentSessionManager } from "./session-manager.js";
import { ConfigService } from "../config/service.js";

class ScriptedClient implements ModelClient {
  async complete(request: CompletionRequest): Promise<ModelResponse> {
    return {
      text: "完成",
      toolCalls: [],
      usage: { input: 1, output: 1, cached: 0 },
    };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bookmark-"));
  const cwd = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const homeDir = path.join(root, "home");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(stateDir, "projects"), { recursive: true });
  await mkdir(path.join(homeDir, ".myagent"), { recursive: true });
  return { cwd, stateDir, homeDir };
}

test("书签：添加/改名/移除，空名称删除", async () => {
  const { cwd, stateDir } = await fixture();
  const session = new AgentSession({
    id: "bookmark-1",
    title: "书签测试",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(new ScriptedClient(), []),
    stateDir,
    permissionRules: [],
  });
  await session.sendInput("第一轮任务");
  await session.flush();
  const seq = session.events().find((e) => e.event.type === "user")!.seq;

  assert.deepEqual(session.bookmarks(), []);
  session.addBookmark(seq, "起点");
  assert.deepEqual(session.bookmarks(), [{ seq, name: "起点" }]);
  // 改名：重复标记同一 seq
  session.addBookmark(seq, "改名后");
  assert.deepEqual(session.bookmarks(), [{ seq, name: "改名后" }]);
  // 移除
  session.removeBookmark(seq);
  assert.deepEqual(session.bookmarks(), []);
  // 不存在的 seq
  assert.throws(() => session.addBookmark(999, "x"), /不存在/);
  // 空名称
  assert.throws(() => session.addBookmark(seq, "  "), /不能为空/);
});

test("书签：恢复后从事件流重建", async () => {
  const { cwd, stateDir, homeDir } = await fixture();
  const session = new AgentSession({
    id: "bookmark-2",
    title: "书签恢复",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(new ScriptedClient(), []),
    stateDir,
    permissionRules: [],
  });
  await session.sendInput("第一轮任务");
  await session.flush();
  const seq = session.events().find((e) => e.event.type === "user")!.seq;
  session.addBookmark(seq, "重要节点");
  await session.flush();

  // 重启恢复
  const manager = new AgentSessionManager({
    cwd,
    configService: new ConfigService({ cwd, homeDir }),
    stateDir,
    homeDir,
    modelFactory: async () =>
      new ConversationAgentModel(new ScriptedClient(), []),
  });
  await manager.restore();
  const restored = manager.get("bookmark-2")!;
  assert.deepEqual(restored.bookmarks(), [{ seq, name: "重要节点" }]);
});

test("书签 API：GET 列出 / POST 添加与移除", async () => {
  const { cwd, stateDir, homeDir } = await fixture();
  const session = new AgentSession({
    id: "bookmark-3",
    title: "书签 API",
    cwd,
    mode: "trust",
    model: new ConversationAgentModel(new ScriptedClient(), []),
    stateDir,
    permissionRules: [],
  });
  await session.sendInput("任务");
  await session.flush();
  const seq = session.events().find((e) => e.event.type === "user")!.seq;

  const manager = new AgentSessionManager({
    cwd,
    configService: new ConfigService({ cwd, homeDir }),
    stateDir,
    homeDir,
    modelFactory: async () =>
      new ConversationAgentModel(new ScriptedClient(), []),
  });
  await manager.restore();
  const restored = manager.get("bookmark-3")!;

  // 添加
  restored.addBookmark(seq, "API 书签");
  assert.deepEqual(restored.bookmarks(), [{ seq, name: "API 书签" }]);
  // 空名称移除
  restored.removeBookmark(seq);
  assert.deepEqual(restored.bookmarks(), []);
});
