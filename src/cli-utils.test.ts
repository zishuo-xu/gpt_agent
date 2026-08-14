import assert from "node:assert/strict";
import test from "node:test";
import type { MyAgentConfig } from "./config/schema.js";
import {
  coerceConfigValue,
  formatEffectiveConfig,
  isApprovalAnswer,
  parseApprovalAnswer,
  parseConfigSetLine,
} from "./cli-utils.js";

test("isApprovalAnswer：y/n/yes/no 与 /allow、/deny 前缀", () => {
  for (const answer of ["y", "Y", "yes", "n", "no", "/allow", "/allow global", "/deny", "/deny 不要写文件"]) {
    assert.equal(isApprovalAnswer(answer), true, answer);
  }
  for (const not of ["hello", "/help", "yesss", ""]) {
    assert.equal(isApprovalAnswer(not), false, not);
  }
});

test("parseApprovalAnswer：y 与 /allow 默认 once 范围", () => {
  assert.deepEqual(parseApprovalAnswer("y"), { granted: true, scope: "once" });
  assert.deepEqual(parseApprovalAnswer("yes"), { granted: true, scope: "once" });
  assert.deepEqual(parseApprovalAnswer("/allow"), { granted: true, scope: "once" });
});

test("parseApprovalAnswer：/allow 指定范围，非法范围回退 once", () => {
  assert.deepEqual(parseApprovalAnswer("/allow session"), { granted: true, scope: "session" });
  assert.deepEqual(parseApprovalAnswer("/allow project"), { granted: true, scope: "project" });
  assert.deepEqual(parseApprovalAnswer("/allow global"), { granted: true, scope: "global" });
  assert.deepEqual(parseApprovalAnswer("/allow forever"), { granted: true, scope: "once" });
});

test("parseApprovalAnswer：n 拒绝无留言，/deny 带留言", () => {
  assert.deepEqual(parseApprovalAnswer("n"), { granted: false });
  assert.deepEqual(parseApprovalAnswer("/deny"), { granted: false });
  assert.deepEqual(parseApprovalAnswer("/deny 不要写文件"), {
    granted: false,
    feedback: "不要写文件",
  });
  // 拒绝时保留原始大小写留言
  assert.deepEqual(parseApprovalAnswer("/deny 使用 pnpm 而非 npm"), {
    granted: false,
    feedback: "使用 pnpm 而非 npm",
  });
});

test("parseConfigSetLine：拆出键路径、值与默认 project 作用域", () => {
  assert.deepEqual(parseConfigSetLine("context.compactAtEstimatedTokens 50000"), {
    keyPath: "context.compactAtEstimatedTokens",
    value: "50000",
    scope: "project",
  });
  assert.deepEqual(parseConfigSetLine("behavior.showCacheMissNotices true global"), {
    keyPath: "behavior.showCacheMissNotices",
    value: "true",
    scope: "global",
  });
  // 值本身含空格时只尾部分离作用域
  assert.deepEqual(parseConfigSetLine("server.host 0.0.0.0 project"), {
    keyPath: "server.host",
    value: "0.0.0.0",
    scope: "project",
  });
  assert.throws(() => parseConfigSetLine("justakey"), /用法：\/config set/);
});

test("coerceConfigValue：数字/布尔强转，字符串原样，类型不符报错", () => {
  assert.equal(coerceConfigValue(0, "50000"), 50000);
  assert.equal(coerceConfigValue(true, "false"), false);
  assert.equal(coerceConfigValue(false, "TRUE"), true);
  assert.equal(coerceConfigValue("127.0.0.1", "0.0.0.0"), "0.0.0.0");
  assert.throws(() => coerceConfigValue(0, "abc"), /需要数字/);
  assert.throws(() => coerceConfigValue(true, "maybe"), /需要 true\/false/);
});

test("formatEffectiveConfig：摘要包含权限/规则计数/角色模型/上下文/Web", () => {
  const config: MyAgentConfig = {
    providers: [],
    models: {
      main: { providerId: "p1", model: "m1", pricing: { inputPerMillionCny: 1, outputPerMillionCny: 2, cachedInputPerMillionCny: 0.2 } },
      cheap: { providerId: "p1", model: "m2", pricing: { inputPerMillionCny: 1, outputPerMillionCny: 2, cachedInputPerMillionCny: 0.2 } },
      explore: { providerId: "p2", model: "m3", pricing: { inputPerMillionCny: 1, outputPerMillionCny: 2, cachedInputPerMillionCny: 0.2 } },
    },
    permissions: {
      mode: "normal",
      rules: [
        { effect: "allow", pattern: "Bash(pnpm test)" },
        { effect: "deny", pattern: "Write(secrets/**)" },
        { effect: "ask", pattern: "Bash(git push*)" },
        { effect: "allow", pattern: "Bash(git status)" },
      ],
      approvalTimeoutMs: 60000,
    },
    context: {
      compactAtEstimatedTokens: 90000,
      keepRecentTokens: 20000,
    },
    server: { host: "0.0.0.0", password: "secret", apiToken: "" },
    notify: { webhook: "", desktop: false },
    behavior: { showCacheMissNotices: false, parallelTools: false, crossProjectMemory: true, enablePlugins: true },
  };
  const text = formatEffectiveConfig(config);
  assert.match(text, /权限档：normal · 审批超时 60000ms/);
  assert.match(text, /allow 2 \/ ask 1 \/ deny 1/);
  assert.match(text, /main=p1\/m1 · cheap=p1\/m2 · explore=p2\/m3/);
  assert.match(text, /压缩阈值 90000 tokens · 保留最近 20000 tokens/);
  assert.match(text, /host 0\.0\.0\.0 · 已设访问密码/);
});
