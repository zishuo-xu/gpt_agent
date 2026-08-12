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

test("rememberPattern：插件工具通配记忆放行任意 target，去重", () => {
  const engine = new PermissionEngine("normal", []);
  const pluginCall = (target: string): ToolCall => ({
    id: `c-${target}`,
    tool: "WebFetch",
    target,
    args: { url: target },
  });

  // 插件工具通配记忆前：normal 兜底 ask
  assert.equal(engine.judge(pluginCall("https://a.com")), "ask");
  engine.rememberPattern("WebFetch(*)");
  engine.rememberPattern("WebFetch(*)"); // 去重
  assert.equal(engine.judge(pluginCall("https://a.com")), "allow");
  assert.equal(engine.judge(pluginCall("https://b.com/page")), "allow");
  assert.deepEqual(
    engine.rules().filter((rule) => rule.pattern === "WebFetch(*)"),
    [{ effect: "allow", pattern: "WebFetch(*)" }],
    "重复记忆不追加",
  );
});

test("remember：内置工具维持精确签名记忆", () => {
  const engine = new PermissionEngine("normal", []);
  engine.remember({ id: "c", tool: "Bash", target: "git status", args: { command: "git status" } });
  assert.equal(
    engine.judge({ id: "c2", tool: "Bash", target: "git status", args: {} }),
    "allow",
    "同签名放行",
  );
  assert.equal(
    engine.judge({ id: "c3", tool: "Bash", target: "git log", args: {} }),
    "ask",
    "不同命令不放行",
  );
});

test("Bash 只读链：全段 allow 放行，段级 deny/ask 拦截", () => {
  const engine = new PermissionEngine("normal", DEFAULT_PERMISSION_RULES);
  const bash = (target: string): ToolCall => ({
    id: target,
    tool: "Bash",
    target,
    args: { command: target },
  });
  // 全段只读 → 放行
  assert.equal(engine.judge(bash("pwd && ls -la")), "allow");
  assert.equal(engine.judge(bash("ls -la; pwd")), "allow");
  assert.equal(engine.judge(bash("git status && git diff")), "allow");
  assert.equal(engine.judge(bash("pwd")), "allow", "单段 pwd 由整串规则放行");
  assert.equal(engine.judge(bash("ls -la 2>&1 | head && pwd")), "allow", "重定向/管道留在段内");
  assert.equal(engine.judge(bash("find . -maxdepth 3 -not -path './node_modules*' | sort")), "allow", "只读 find 放行");
  assert.equal(engine.judge(bash("cat package.json && ls")), "allow", "cat 链放行");
  assert.equal(engine.judge(bash("ls node_modules | head -50")), "allow", "ls 管道 head 放行");
  // find 的执行形态必须拦截（删除通道）
  assert.equal(engine.judge(bash("find . -exec rm -rf {} \\;")), "deny");
  assert.equal(engine.judge(bash("find . -delete")), "deny");
  // 段级 deny 拦截——前缀 allow 规则（Bash(pwd*)/Bash(ls*)）绕不过去
  assert.equal(engine.judge(bash("pwd && rm -rf build")), "deny");
  assert.equal(engine.judge(bash("ls && rm -fr build")), "deny");
  assert.equal(engine.judge(bash("ls && git reset --hard HEAD")), "deny");
  // 段级 ask 拦截——修复整串前缀 allow 绕过显式 ask 的洞
  assert.equal(engine.judge(bash("ls && git push origin main")), "ask");
  assert.equal(engine.judge(bash("pwd && git commit -m x")), "ask");
  // 含未知命令的链不因前缀放行
  assert.equal(engine.judge(bash("pwd && node script.js")), "ask");
  assert.equal(engine.judge(bash("pwd && whatever")), "ask");
});

test("Bash 只读链：引号内操作符不切分", () => {
  const engine = new PermissionEngine("normal", DEFAULT_PERMISSION_RULES);
  const bash = (target: string): ToolCall => ({
    id: target,
    tool: "Bash",
    target,
    args: { command: target },
  });
  assert.equal(engine.judge(bash('ls "a && b" && pwd')), "allow", "双引号内 && 不切分");
  assert.equal(engine.judge(bash("ls 'x; y' && pwd")), "allow", "单引号内 ; 不切分");
  assert.equal(engine.judge(bash("ls -la 2>&1")), "allow", "重定向 & 不切分");
});

test("Bash 只读链：strict 全询问；trust 尊重段级 ask/deny", () => {
  const bash = (target: string): ToolCall => ({
    id: target,
    tool: "Bash",
    target,
    args: { command: target },
  });
  const strict = new PermissionEngine("strict", DEFAULT_PERMISSION_RULES);
  assert.equal(strict.judge(bash("pwd && ls -la")), "ask", "strict 下 Bash 链一律询问");
  const trust = new PermissionEngine("trust", DEFAULT_PERMISSION_RULES);
  assert.equal(trust.judge(bash("pwd && ls")), "allow");
  assert.equal(trust.judge(bash("pwd && git push origin main")), "ask", "trust 尊重段级显式 ask");
  assert.equal(trust.judge(bash("ls && rm -rf x")), "deny", "trust 也拒绝段级危险命令");
});
