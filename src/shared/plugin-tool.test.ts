import assert from "node:assert/strict";
import test from "node:test";
import { PluginToolRegistry } from "./plugin-tool.js";

function tool(name: string) {
  return {
    name,
    description: `${name} 测试工具`,
    inputSchema: { type: "object" },
    async run(args: Record<string, unknown>) {
      return {
        summary: `执行 ${name}`,
        output: `output-${String(args.input ?? "")}`,
        details: { name, input: args.input },
      };
    },
  };
}

test("注册表：注册/查询/定义转换/分发执行", async () => {
  const registry = new PluginToolRegistry();
  registry.register(tool("WebFetch"), "web-fetch.ts");

  assert.equal(registry.has("WebFetch"), true);
  assert.equal(registry.has("Read"), false, "内置工具不在插件注册表");
  assert.deepEqual(registry.names(), ["WebFetch"]);

  const definitions = registry.definitions();
  assert.equal(definitions.length, 1);
  assert.deepEqual(definitions[0], {
    name: "WebFetch",
    description: "WebFetch 测试工具",
    inputSchema: { type: "object" },
  });

  const result = await registry.execute("WebFetch", { input: "abc" }, new AbortController().signal);
  assert.equal(result.isError, undefined);
  assert.equal(result.summary, "执行 WebFetch");
  assert.equal(result.output, "output-abc");
  assert.deepEqual(result.details, { name: "WebFetch", input: "abc" });
});

test("注册表：同名覆盖、非法名与内置名冲突被拒", () => {
  const registry = new PluginToolRegistry();
  registry.register(tool("Fetch"), "global.ts");
  registry.register(tool("Fetch"), "project.ts");
  assert.equal(registry.names().length, 1, "同名后注册覆盖");

  assert.throws(() => registry.register({ ...tool("bad name"), name: "bad name" }));
  assert.throws(() => registry.register(tool(""), "x.ts"));
  assert.throws(() => registry.register(tool("Read")), /内置工具冲突/);
  assert.throws(
    () =>
      registry.register({
        name: "NoRun",
        description: "缺 run",
        inputSchema: { type: "object" },
        run: undefined as never,
      }),
    /缺少 description 或 run/,
  );
});

test("注册表：未注册名执行返回失败结果，run 抛错被捕获", async () => {
  const registry = new PluginToolRegistry();
  const signal = new AbortController().signal;

  const missing = await registry.execute("Ghost", {}, signal);
  assert.equal(missing.isError, true);
  assert.match(String(missing.output), /未注册/);

  registry.register({
    name: "Boom",
    description: "抛错插件",
    inputSchema: { type: "object" },
    async run() {
      throw new Error("插件内部错误");
    },
  });
  const failed = await registry.execute("Boom", {}, signal);
  assert.equal(failed.isError, true);
  assert.match(String(failed.summary), /插件内部错误/);
});

test("注册表：调用统计（次数/失败/耗时聚合，成功与失败均计入）", async () => {
  const registry = new PluginToolRegistry();
  const signal = new AbortController().signal;
  registry.register({
    name: "OkTool",
    description: "成功工具",
    inputSchema: { type: "object" },
    async run() {
      return { summary: "ok" };
    },
  });
  registry.register({
    name: "ErrTool",
    description: "失败工具",
    inputSchema: { type: "object" },
    async run() {
      return { summary: "err", isError: true };
    },
  });

  await registry.execute("OkTool", {}, signal);
  await registry.execute("OkTool", {}, signal);
  await registry.execute("ErrTool", {}, signal);
  await registry.execute("Ghost", {}, signal);

  const stats = new Map(
    registry.stats().map((entry) => [entry.name, entry]),
  );
  const ok = stats.get("OkTool");
  assert.equal(ok?.calls, 2);
  assert.equal(ok?.errors, 0);
  assert.ok((ok?.totalMs ?? 0) >= 0);
  const err = stats.get("ErrTool");
  assert.equal(err?.calls, 1);
  assert.equal(err?.errors, 1, "isError 结果计入失败");
  assert.equal(stats.has("Ghost"), false, "未注册名不产生统计（execute 直接返回）");
});
