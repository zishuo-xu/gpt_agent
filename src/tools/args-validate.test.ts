import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "../core/types.js";
import { validateToolArgs } from "./args-validate.js";

function call(
  tool: ToolCall["tool"],
  args: unknown,
): ToolCall {
  return { id: "t", tool, target: tool, args };
}

test("字符串数字强转为 number（模型常发 string 数字）", () => {
  const result = validateToolArgs(
    call("Bash", { command: "echo hi", timeout_ms: "5000" }),
  );
  assert.equal(result.error, undefined);
  const args = result.args as { timeout_ms?: unknown };
  assert.equal(typeof args.timeout_ms, "number");
  assert.equal(args.timeout_ms, 5000);
});

test("必填缺失时报错并定位到字段路径（wire 键名）", () => {
  const read = validateToolArgs(call("Read", { offset: 1 }));
  assert.match(read.error ?? "", /\/file_path/);

  const edit = validateToolArgs(
    call("Edit", { file_path: "a.ts", old_string: "x" }),
  );
  assert.match(edit.error ?? "", /\/new_string/);
});

test("空串与空数组被 minLength/minItems 拒绝（原 validateArgs 业务规则）", () => {
  const emptyCommand = validateToolArgs(
    call("Bash", { command: "" }),
  );
  assert.match(emptyCommand.error ?? "", /\/command/);

  const emptyEdits = validateToolArgs(
    call("MultiEdit", { file_path: "a.ts", edits: [] }),
  );
  assert.match(emptyEdits.error ?? "", /\/edits/);

  const emptyOldString = validateToolArgs(
    call("Edit", { file_path: "a.ts", old_string: "", new_string: "b" }),
  );
  assert.match(emptyOldString.error ?? "", /\/old_string/);
});

test("unknown 额外字段被拒绝并回显（对齐 Pi 严格校验）", () => {
  const result = validateToolArgs(
    call("Bash", { command: "ls", cwd: "/tmp" }),
  );
  assert.match(result.error ?? "", /\/cwd/);
  assert.match(result.error ?? "", /"cwd":"\/tmp"/, "报错回显收到的参数");
});

test("合法参数原样通过，bool 与嵌套数组结构校验", () => {
  const bash = validateToolArgs(
    call("Bash", { command: "ls", background: false }),
  );
  assert.equal(bash.error, undefined);

  const multiEdit = validateToolArgs(
    call("MultiEdit", {
      file_path: "a.ts",
      edits: [{ old_string: "x", new_string: "y" }],
    }),
  );
  assert.equal(multiEdit.error, undefined);
  const edits = (multiEdit.args as { edits: unknown[] }).edits;
  assert.equal(edits.length, 1);

  // 嵌套数组内缺字段也报错
  const bad = validateToolArgs(
    call("MultiEdit", {
      file_path: "a.ts",
      edits: [{ old_string: "x" }],
    }),
  );
  assert.match(bad.error ?? "", /edits\/0\/new_string/);
});

test("未知工具兜底放行（不拦截后续执行）", () => {
  const result = validateToolArgs(call("Bash" as never, { command: "ls" }));
  assert.equal(result.error, undefined);
});
