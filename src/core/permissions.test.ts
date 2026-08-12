import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PERMISSION_RULES,
  PermissionEngine,
  READONLY_DENY_RULES,
  segmentWritesFile,
} from "./permissions.js";
import os from "node:os";
import path from "node:path";
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

test("segmentWritesFile：写重定向与 tee 识别，fd 复制与 /dev/null 排除", () => {
  // 写盘形态
  assert.equal(segmentWritesFile("cat a.txt > out.txt"), true);
  assert.equal(segmentWritesFile("ls >> log.txt"), true);
  assert.equal(segmentWritesFile("ls >| out.txt"), true, "noclobber 强制覆盖也是写");
  assert.equal(segmentWritesFile("cmd 2>err.log"), true, "stderr 重定向到文件也是写");
  assert.equal(segmentWritesFile("grep x f | tee out.txt"), true, "tee 写盘");
  assert.equal(segmentWritesFile("tee -a out.txt"), true, "tee -a 追加写盘");
  // 无害形态
  assert.equal(segmentWritesFile("cat a.txt 2>&1"), false, "fd 复制不写盘");
  assert.equal(segmentWritesFile("cmd >&2"), false, "fd 复制到 stderr 不写盘");
  assert.equal(segmentWritesFile("ls > /dev/null"), false, "丢弃输出不写盘");
  assert.equal(segmentWritesFile("cmd 2> /dev/null"), false, "stderr 丢弃不写盘");
  // 引号内不误伤
  assert.equal(segmentWritesFile("ls '>'"), false, "引号内 > 是字面量");
  assert.equal(segmentWritesFile("echo 'tee'"), false, "引号内 tee 是字面量");
  assert.equal(segmentWritesFile("ls -la 2>&1 | head"), false, "管道内 fd 复制不写盘");
});

test("写重定向段：normal 询问、trust 放行、strict 询问（只读白名单前缀不放行）", () => {
  const bash = (target: string): ToolCall => ({
    id: target,
    tool: "Bash",
    target,
    args: { command: target },
  });
  const normal = new PermissionEngine("normal", DEFAULT_PERMISSION_RULES);
  // 漏洞回归：cat/ls 前缀 allow 规则不得覆盖写重定向
  assert.equal(normal.judge(bash("cat package.json > out.txt")), "ask");
  assert.equal(normal.judge(bash("ls -la >> log.txt")), "ask");
  assert.equal(normal.judge(bash("grep x f | tee out.txt")), "ask");
  assert.equal(normal.judge(bash("pwd && echo x > f.txt")), "ask", "链内写段拦截");
  // 无害形态仍放行
  assert.equal(normal.judge(bash("cat a.txt 2>&1 | head")), "allow");
  assert.equal(normal.judge(bash("ls > /dev/null")), "allow");
  assert.equal(normal.judge(bash("ls '>'")), "allow", "引号内字面量不误伤");
  const trust = new PermissionEngine("trust", DEFAULT_PERMISSION_RULES);
  assert.equal(trust.judge(bash("cat package.json > out.txt")), "allow", "trust 语义不变");
  const strict = new PermissionEngine("strict", DEFAULT_PERMISSION_RULES);
  assert.equal(strict.judge(bash("cat package.json > out.txt")), "ask", "strict 全询问");
});

test("只读环境（readonly 规则集）：写重定向 Bash 直接 deny", () => {
  const bash = (target: string): ToolCall => ({
    id: target,
    tool: "Bash",
    target,
    args: { command: target },
  });
  const readonlyRules: PermissionRule[] = [
    ...READONLY_DENY_RULES,
    ...DEFAULT_PERMISSION_RULES,
  ];
  // TaskRunner readonly 子代理逃逸回归：cat 白名单 + 写重定向不得写盘
  const readonly = new PermissionEngine("normal", readonlyRules);
  assert.equal(readonly.judge(bash("cat x > out.txt")), "deny");
  assert.equal(readonly.judge(bash("grep x f | tee out.txt")), "deny");
  // 纯只读命令仍放行（readonly 子代理允许查询）
  assert.equal(readonly.judge(bash("cat package.json")), "allow");
  assert.equal(readonly.judge(bash("ls -la 2>&1 | head")), "allow");
  // trust 主会话下 readonly 子代理同样被写保护拦下（模式兜底不得放行）
  const readonlyTrust = new PermissionEngine("trust", readonlyRules);
  assert.equal(readonlyTrust.judge(bash("cat x > out.txt")), "deny");
});

test("写重定向段：用户显式授权（--auto-allow / 自定义 allow）放行含写副作用命令", () => {
  const bash = (target: string): ToolCall => ({
    id: target,
    tool: "Bash",
    target,
    args: { command: target },
  });
  // --auto-allow 语义：任务期放行指定工具（含写副作用），不受只读原语拦截
  const engine = new PermissionEngine("normal", [
    ...DEFAULT_PERMISSION_RULES,
    { effect: "allow", pattern: "Bash(echo changed*)" },
  ]);
  assert.equal(engine.judge(bash("echo changed > changed.txt")), "allow");
  // 链内混合：显式授权段放行 + 只读段放行 → 整串放行
  assert.equal(
    engine.judge(bash("ls && echo changed > changed.txt")),
    "allow",
  );
});

test("文件工具 target 规范化：绝对路径形态命中 ~/.ssh deny（原字面匹配旁路）", () => {
  // 用户主目录为 /Users/xuzishuo 时，模型传绝对路径不再绕过 Edit(~/.ssh/*)
  const home = os.homedir();
  const engine = new PermissionEngine(
    "normal",
    DEFAULT_PERMISSION_RULES,
    { cwd: "/work/project" },
  );
  // ~ 形态（原有语义保持）
  assert.equal(engine.judge(call("Edit", "~/.ssh/config")), "deny");
  // 绝对路径形态（原为 allow，旁路修复）
  assert.equal(
    engine.judge(call("Edit", path.join(home, ".ssh/config"))),
    "deny",
  );
  assert.equal(
    engine.judge(call("Write", path.join(home, ".ssh/known_hosts"))),
    "deny",
  );
});

test("文件工具 target 规范化：../ 折叠无法绕过 deny 硬边界", () => {
  const engine = new PermissionEngine(
    "normal",
    [
      ...DEFAULT_PERMISSION_RULES,
      { effect: "deny", pattern: "Edit(*src/secret*)" },
    ],
    { cwd: "/work/project" },
  );
  // 直接形态
  assert.equal(engine.judge(call("Edit", "src/secret/x.ts")), "deny");
  // ../ 折叠形态（原为 allow，旁路修复）
  assert.equal(engine.judge(call("Edit", "src/../src/secret/x.ts")), "deny");
  // 相对路径 resolve 后规则仍可命中（判定与执行同构）
  assert.equal(engine.judge(call("Edit", "src/secret/deep/../y.ts")), "deny");
});

test("文件工具 target 规范化：普通文件相对路径语义不变", () => {
  const engine = new PermissionEngine(
    "normal",
    DEFAULT_PERMISSION_RULES,
    { cwd: "/work/project" },
  );
  // 非敏感路径在 normal 档 NORMAL_AUTO 自动放行（语义不变）
  assert.equal(engine.judge(call("Edit", "src/app.ts")), "allow");
  // 规范化后 .myagent 记忆目录 allow 规则仍命中
  const memoryEngine = new PermissionEngine(
    "trust",
    DEFAULT_PERMISSION_RULES,
    { cwd: "/work/project" },
  );
  assert.equal(
    memoryEngine.judge(call("Write", ".myagent/memory/notes.md")),
    "allow",
  );
  // remember 与 judge 同构：授权后绝对路径形态同样命中
  memoryEngine.remember(call("Edit", "docs/plan.md"));
  assert.equal(
    memoryEngine.judge(call("Edit", "/work/project/docs/plan.md")),
    "allow",
  );
});
