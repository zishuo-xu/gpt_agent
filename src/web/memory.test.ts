import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSessionManager } from "../core/session-manager.js";
import { MemoryService } from "./memory.js";

/**
 * 构造带「Edit 记忆文件」事件的假会话管理器：list()/get().events() 返回
 * 预置事件记录（tool_call Edit + tool_result），供 #buildTimeline 反推。
 */
function makeTimelineSessions(options: {
  memoryTarget: string; // tool_call 的 target（相对 cwd 或绝对）
  editTs: string;
}): AgentSessionManager {
  const events = [
    {
      seq: 1,
      ts: options.editTs,
      event: {
        type: "tool_call",
        call: { id: "c1", tool: "Edit", target: options.memoryTarget },
      },
    },
    {
      seq: 2,
      ts: options.editTs,
      event: {
        type: "tool_result",
        callId: "c1",
        isError: false,
        summary: "已替换 1 块",
      },
    },
  ];
  return {
    list: () => [{ id: "s1", title: "写记忆会话" }],
    get: () => ({ events: () => events }),
  } as unknown as AgentSessionManager;
}

async function fixture(): Promise<{
  root: string;
  project: string;
  memDir: string;
  docPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-memory-"));
  const project = path.join(root, "project");
  const memDir = path.join(project, ".myagent", "memory");
  await mkdir(memDir, { recursive: true });
  return { root, project, memDir, docPath: path.join(memDir, "pitfalls.md") };
}

test("时间线：条目 ts 前 60s 窗口内存在留档时填充 historyPath", async () => {
  const { root, project, docPath } = await fixture();
  await writeFile(docPath, "当前内容", "utf8");
  const historyDir = path.join(path.dirname(docPath), ".history");
  await mkdir(historyDir, { recursive: true });
  const historyFile = path.join(
    historyDir,
    "pitfalls-20260810-120000-000-abcd.md",
  );
  await writeFile(historyFile, "旧内容", "utf8");
  // 留档 mtime 在事件 ts 前 10s（窗口 60s 内）
  const editTs = new Date(Date.now() - 5_000).toISOString();
  await utimes(historyFile, new Date(Date.now() - 15_000), new Date(Date.now() - 15_000));
  const sessions = makeTimelineSessions({ memoryTarget: docPath, editTs });
  const service = new MemoryService({
    cwd: project,
    homeDir: path.join(root, "home"),
    sessions,
  });
  const { timeline } = await service.list();
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]!.documentId, "pitfalls");
  assert.equal(timeline[0]!.historyPath, historyFile);
  await rm(root, { recursive: true, force: true });
});

test("时间线：窗口外（mtime 早于 60s）或无留档时 historyPath 缺省", async () => {
  const { root, project, docPath } = await fixture();
  await writeFile(docPath, "当前内容", "utf8");
  const historyDir = path.join(path.dirname(docPath), ".history");
  await mkdir(historyDir, { recursive: true });
  const staleFile = path.join(historyDir, "pitfalls-20260801-000000-000-abcd.md");
  await writeFile(staleFile, "旧内容", "utf8");
  const editTs = new Date(Date.now() - 5_000).toISOString();
  // 窗口外：mtime 120s 前
  await utimes(staleFile, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const sessions = makeTimelineSessions({ memoryTarget: docPath, editTs });
  const service = new MemoryService({
    cwd: project,
    homeDir: path.join(root, "home"),
    sessions,
  });
  const { timeline } = await service.list();
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]!.historyPath, undefined);
  await rm(root, { recursive: true, force: true });
});
