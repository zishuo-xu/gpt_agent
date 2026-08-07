import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PERMISSION_RULES,
  PermissionEngine,
} from "./permissions.js";
import type { PermissionRule, ToolCall, ToolName } from "./types.js";

function call(tool: ToolName, target = "file.txt"): ToolCall {
  return { id: "call-1", tool, target, args: {} };
}

const rules: PermissionRule[] = [
  { effect: "allow", pattern: "Bash(npm test*)" },
  { effect: "ask", pattern: "Bash(git push*)" },
  { effect: "deny", pattern: "Bash(rm -rf *)" },
];

test("deny 在所有档位下都直接拒绝", () => {
  for (const mode of ["strict", "normal", "trust"] as const) {
    const engine = new PermissionEngine(mode, rules);
    assert.equal(engine.judge(call("Bash", "rm -rf build")), "deny");
  }
});

test("strict 忽略 allow 规则并询问所有写操作与 Bash", () => {
  const engine = new PermissionEngine("strict", rules);
  assert.equal(engine.judge(call("Read")), "allow");
  assert.equal(engine.judge(call("Edit")), "ask");
  assert.equal(engine.judge(call("MultiEdit")), "ask");
  assert.equal(engine.judge(call("Write")), "ask");
  assert.equal(engine.judge(call("Bash", "npm test")), "ask");
});

test("normal 自动允许读与精确编辑，Write 和灰区 Bash 询问", () => {
  const engine = new PermissionEngine("normal", rules);
  assert.equal(engine.judge(call("Read")), "allow");
  assert.equal(engine.judge(call("Edit")), "allow");
  assert.equal(engine.judge(call("MultiEdit")), "allow");
  assert.equal(engine.judge(call("Write")), "ask");
  assert.equal(engine.judge(call("Bash", "npm test")), "allow");
  assert.equal(engine.judge(call("Bash", "git push origin main")), "ask");
  assert.equal(engine.judge(call("Bash", "node script.js")), "ask");
});

test("trust 仍尊重显式 ask，其余自动允许", () => {
  const engine = new PermissionEngine("trust", rules);
  assert.equal(engine.judge(call("Bash", "git push origin main")), "ask");
  assert.equal(engine.judge(call("Write")), "allow");
  assert.equal(engine.judge(call("Bash", "node script.js")), "allow");
});

test("重叠规则固定遵循 deny > ask > allow", () => {
  const engine = new PermissionEngine("trust", [
    { effect: "allow", pattern: "Bash(git *)" },
    { effect: "ask", pattern: "Bash(git push*)" },
    { effect: "deny", pattern: "Bash(git push --force*)" },
  ]);
  assert.equal(engine.judge(call("Bash", "git status")), "allow");
  assert.equal(engine.judge(call("Bash", "git push origin main")), "ask");
  assert.equal(
    engine.judge(call("Bash", "git push --force origin main")),
    "deny",
  );
});

test("trust 也拒绝危险删除与宽泛 git 清理命令", () => {
  const engine = new PermissionEngine(
    "trust",
    DEFAULT_PERMISSION_RULES,
  );
  for (const command of [
    "sudo rm -rf build",
    "rm -fr build",
    "git reset --hard HEAD",
    "git clean -fd",
    "git checkout -- src",
  ]) {
    assert.equal(
      engine.judge({
        id: command,
        tool: "Bash",
        target: command,
        args: { command },
      }),
      "deny",
      command,
    );
  }
});

test("插件工具：normal 兜底 ask，allow 规则放行，trust 全放行", () => {
  const pluginCall: ToolCall = {
    id: "plugin-1",
    tool: "WebFetch",
    target: "https://example.com",
    args: { url: "https://example.com" },
  };

  const normal = new PermissionEngine("normal", rules);
  assert.equal(normal.judge(pluginCall), "ask", "插件工具不在 NORMAL_AUTO，normal 兜底 ask");

  const withRule = new PermissionEngine("normal", [
    ...rules,
    { effect: "allow", pattern: "WebFetch(*)" },
  ]);
  assert.equal(withRule.judge(pluginCall), "allow", "显式 allow 规则放行");

  const trust = new PermissionEngine("trust", rules);
  assert.equal(trust.judge(pluginCall), "allow", "trust 全放行");

  const strict = new PermissionEngine("strict", rules);
  assert.equal(strict.judge(pluginCall), "allow", "插件不在 STRICT_GATED，strict 放行");
});
