import assert from "node:assert/strict";
import test from "node:test";
import type { ModelClient } from "../model/types.js";
import { generateSessionTitle, titleFrom } from "./session-title.js";

test("titleFrom：空白归一 + 36 字截断加省略号", () => {
  assert.equal(titleFrom("  修复  登录 测试 "), "修复 登录 测试");
  const long = "长".repeat(50);
  const result = titleFrom(long);
  assert.equal(result.length, 37);
  assert.ok(result.endsWith("…"));
  assert.equal(result.slice(0, 36), "长".repeat(36));
  assert.equal(titleFrom(""), "");
});

function mockClient(text: string): ModelClient {
  return { complete: async () => ({ text }) } as unknown as ModelClient;
}

function failingClient(message: string): ModelClient {
  return {
    complete: async () => {
      throw new Error(message);
    },
  } as unknown as ModelClient;
}

test("generateSessionTitle：模型标题经清洗后回调", async () => {
  const titles: string[] = [];
  await generateSessionTitle({
    createRoleClient: async () => mockClient("修复登录测试"),
    userText: "修复一下登录测试",
    onTitle: (title) => titles.push(title),
  });
  assert.deepEqual(titles, ["修复登录测试"]);
});

test("generateSessionTitle：中文请求 + 纯英文标题回退请求前缀", async () => {
  const titles: string[] = [];
  await generateSessionTitle({
    createRoleClient: async () => mockClient("Fix login tests"),
    userText: "修复登录测试",
    onTitle: (title) => titles.push(title),
  });
  assert.deepEqual(titles, ["修复登录测试"]);
});

test("generateSessionTitle：生成失败回退首条消息前缀", async () => {
  const titles: string[] = [];
  await generateSessionTitle({
    createRoleClient: async () => failingClient("请求超时"),
    userText: "给项目加 ESLint",
    onTitle: (title) => titles.push(title),
  });
  assert.deepEqual(titles, ["给项目加 ESLint"]);
});

test("generateSessionTitle：无 cheap 客户端时不回调", async () => {
  const titles: string[] = [];
  await generateSessionTitle({
    createRoleClient: async () => undefined,
    userText: "任务",
    onTitle: (title) => titles.push(title),
  });
  assert.deepEqual(titles, []);
});
