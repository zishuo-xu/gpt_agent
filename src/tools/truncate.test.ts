import assert from "node:assert/strict";
import test from "node:test";
import { TOOL_OUTPUT_LIMITS, truncateToolText } from "./truncate.js";

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

test("差异化上限：Bash 输出比 Read 更小、Grep 只留匹配行", () => {
  assert.ok(TOOL_OUTPUT_LIMITS.bash.maxLines < TOOL_OUTPUT_LIMITS.read.maxLines);
  assert.ok(TOOL_OUTPUT_LIMITS.bash.maxChars < TOOL_OUTPUT_LIMITS.read.maxChars);
  assert.ok(TOOL_OUTPUT_LIMITS.grep.maxLines <= TOOL_OUTPUT_LIMITS.read.maxLines);
  assert.ok(TOOL_OUTPUT_LIMITS.glob.maxChars < TOOL_OUTPUT_LIMITS.grep.maxChars);

  // Bash 输出超过其专属上限时，截断结果不会超过 Bash 的字符上限（含截断标记余量）
  const noisy = Array.from(
    { length: 400 },
    (_, index) => `build-step-${index + 1} ${"y".repeat(80)}`,
  ).join("\n");
  const bounded = truncateToolText(noisy, TOOL_OUTPUT_LIMITS.bash);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.text.length <= TOOL_OUTPUT_LIMITS.bash.maxChars + 120);

  // Read 上限内的大输出保持完整，不被 Bash 上限误伤
  const code = Array.from(
    { length: 180 },
    (_, index) => `line-${index + 1} ${"z".repeat(100)}`,
  ).join("\n");
  const full = truncateToolText(code, TOOL_OUTPUT_LIMITS.read);
  assert.equal(full.truncated, false);
});
