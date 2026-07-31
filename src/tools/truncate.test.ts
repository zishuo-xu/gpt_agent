import assert from "node:assert/strict";
import test from "node:test";
import { truncateToolText } from "./truncate.js";

test("工具输出截断保留头尾并提供机器可执行的恢复提示", () => {
  const source = Array.from(
    { length: 600 },
    (_, index) => `line-${index + 1} ${"x".repeat(120)}`,
  ).join("\n");
  const result = truncateToolText(source, {
    maxLines: 20,
    maxChars: 2_000,
    continuationHint: "use Read offset=13 to continue",
  });

  assert.equal(result.truncated, true);
  assert.match(result.text, /^line-1 /);
  assert.match(result.text, /lines truncated; use Read offset=13 to continue/);
  assert.match(result.text, /line-600 /);
  assert.ok(result.text.length <= 2_100);
});

test("超长单行截断仍保留头尾", () => {
  const result = truncateToolText(
    `HEAD-${"x".repeat(50_000)}-TAIL`,
  );
  assert.match(result.text, /^HEAD-/);
  assert.match(result.text, /middle content truncated/);
  assert.match(result.text, /-TAIL$/);
});
